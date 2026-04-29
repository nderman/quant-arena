import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * SpikeRecoveryBuyerEngine
 *
 * Thesis: after a SPIKE regime, the PM market overreacts. The "wrong"
 * side of the spike (the side that just got crushed) is priced too low
 * relative to its actual fair value once vol calms. Catch the rebound
 * by buying the cheap side ON THE TICK that regime transitions from
 * SPIKE back to CHOP or QUIET.
 *
 * This is fundamentally different from chop-fader-v1:
 *  - chop-fader fires when regime IS CHOP at extreme price (continuous)
 *  - this fires only on the SPIKE→CHOP/QUIET TRANSITION (one-shot)
 *
 * Tracks regime label across ticks. Fires once per transition, then
 * waits for the next SPIKE. Selectivity is the feature — silent in
 * stable regimes, fires on the rare transition events.
 *
 * Gates:
 *  - Previous tick's regime was SPIKE
 *  - Current tick's regime is CHOP or QUIET (transition detected)
 *  - Underdog side ask in 15-30¢ band
 *  - feeAdjustedEdge profitable at 0.55 (mean-revert assumption)
 */
export class SpikeRecoveryBuyerEngine extends AbstractEngine {
  id = "spike-recovery-buyer-v1";
  name = "Spike Recovery Buyer";
  version = "1.0.0";

  private readonly underdogMin = 0.15;
  private readonly underdogMax = 0.30;
  private readonly maxCashPct = 0.15;

  // Track previous regime label so we can detect the SPIKE→CHOP transition.
  // Reset on each round so regime memory doesn't leak across rounds.
  private prevRegime: string = "UNKNOWN";

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];
    this.trackBinance(tick);

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) {
      this.prevRegime = "UNKNOWN";
      return [];
    }

    const currentRegime = this.currentRegime(60);

    // Detect transition from SPIKE → CHOP/QUIET (calm-down moment).
    // Save current regime FIRST so we don't miss the next transition if
    // the gates below reject this fire.
    const transitioned =
      this.prevRegime === "SPIKE" &&
      (currentRegime === "CHOP" || currentRegime === "QUIET");
    this.prevRegime = currentRegime;

    if (!transitioned) return [];

    this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    const upBook = this.getBookForToken(upTokenId);
    const downBook = this.getBookForToken(downTokenId);
    if (!this.isBookTradeable(upBook) || !this.isBookTradeable(downBook)) return [];

    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    // Pick the cheaper underdog (more upside if mean-revert hits)
    const upQual = upAsk >= this.underdogMin && upAsk <= this.underdogMax;
    const downQual = downAsk >= this.underdogMin && downAsk <= this.underdogMax;
    if (!upQual && !downQual) return [];

    let tokenId = "";
    let askPrice = 0;
    if (upQual && (!downQual || upAsk < downAsk)) {
      tokenId = upTokenId; askPrice = upAsk;
    } else {
      tokenId = downTokenId; askPrice = downAsk;
    }

    // Mean-reversion edge: 55% confidence post-spike, asymmetric payoff
    // makes this profitable (entry 25¢ → win pays 75¢ = 3x; lose = -25¢)
    const edge = this.feeAdjustedEdge(0.55, askPrice);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / askPrice);
    if (shares < 5) return [];

    this.markPending(tokenId);
    return [this.buy(tokenId, askPrice, shares, {
      orderType: "taker",
      note: `spike-recovery: SPIKE→${currentRegime} bought ${tokenId === upTokenId ? "UP" : "DOWN"} @${askPrice.toFixed(3)}`,
      signalSource: "spike_recovery",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.prevRegime = "UNKNOWN";
  }
}
