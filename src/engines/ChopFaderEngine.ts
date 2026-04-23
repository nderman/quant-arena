import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * chop-fader-v1 — fade extreme moves in confirmed CHOP regime.
 *
 * Counter-thesis to our TREND specialists. In chop, price over-extends
 * toward one side, then reverts. PM pricing often over-shoots —
 * when UP ask hits 85¢+ in chop, it often retraces before settlement.
 *
 * Strategy: in QUIET/CHOP regime, when one side's ask hits 80¢+ (false
 * confidence), buy the OPPOSITE underdog at 15-25¢ betting on reversion.
 * Small positions (this is a fade, not a conviction bet). Hold to settle.
 *
 * Guards against trending markets (where the "extreme" side is
 * correct): refuses to enter if Binance momentum in same direction as
 * the extreme side is >15bps. That means the move is real, not chop.
 */
export class ChopFaderEngine extends AbstractEngine {
  id = "chop-fader-v1";
  name = "Chop Fader (mean-revert on extreme)";
  version = "1.0.0";

  private readonly entryStartFrac = 0.20;
  private readonly entryEndFrac = 0.70;
  private readonly extremeTriggerPrice = 0.80;  // when leading side hits 0.80+
  private readonly underdogMinPrice = 0.15;
  private readonly underdogMaxPrice = 0.25;
  private readonly trendRejectBps = 15;  // reject if trend confirms the move
  private readonly regimeLookbackSec = 60;
  private readonly maxCashPct = 0.15;

  private enteredThisCandle = false;
  private lastCandleKey = "";

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    this.trackBinance(tick);
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    const rotated = this.updatePendingOrders();
    const candleKey = `${upTokenId}:${downTokenId}`;
    if (candleKey !== this.lastCandleKey || rotated) {
      this.lastCandleKey = candleKey;
      this.enteredThisCandle = false;
    }

    if (this.enteredThisCandle) return [];
    if (this.hasPendingOrder()) return [];

    const secsRemaining = this.getSecondsRemaining();
    if (secsRemaining < 0) return [];
    const windowStart = this.getWindowStart();
    const windowEnd = this.state.marketWindowEnd || 0;
    const candleSec = Math.round((windowEnd - windowStart) / 1000);
    if (candleSec <= 0) return [];
    const elapsedFrac = (candleSec - secsRemaining) / candleSec;
    if (elapsedFrac < this.entryStartFrac || elapsedFrac > this.entryEndFrac) return [];

    // Regime gate: only chop or quiet
    const scaledLookback = this.arenaScaledSec(this.regimeLookbackSec);
    const regime = this.currentRegimeStable(scaledLookback);
    if (regime !== "CHOP" && regime !== "QUIET") return [];

    const upBook = this.getBookForToken(upTokenId);
    const downBook = this.getBookForToken(downTokenId);
    if (!this.isBookTradeable(upBook) || !this.isBookTradeable(downBook)) return [];
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    // Which side is extreme? Fade by buying the opposite
    let fadeTokenId: string | null = null;
    let fadePrice = 0;
    let extremeSide: "UP" | "DOWN" | null = null;

    if (upAsk >= this.extremeTriggerPrice) {
      // UP is extreme → buy DOWN
      extremeSide = "UP";
      fadeTokenId = downTokenId;
      fadePrice = downAsk;
    } else if (downAsk >= this.extremeTriggerPrice) {
      extremeSide = "DOWN";
      fadeTokenId = upTokenId;
      fadePrice = upAsk;
    } else {
      return [];  // no extreme, no fade
    }

    if (fadePrice < this.underdogMinPrice || fadePrice > this.underdogMaxPrice) return [];

    // Reject if Binance momentum confirms the extreme (= real trend, not chop)
    const momentum = this.recentMomentum(scaledLookback);
    const momentumBps = momentum * 10000;
    if (extremeSide === "UP" && momentumBps > this.trendRejectBps) return [];
    if (extremeSide === "DOWN" && momentumBps < -this.trendRejectBps) return [];

    const edge = this.feeAdjustedEdge(0.35, fadePrice);  // expect 25-40% reversion probability
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / fadePrice);
    if (shares < 5) return [];

    this.enteredThisCandle = true;
    this.markPending(fadeTokenId);
    return [this.buy(fadeTokenId, fadePrice, shares, {
      orderType: "taker",
      note: `chop-fade ${extremeSide === "UP" ? "DOWN" : "UP"} @ ${fadePrice.toFixed(3)} (${extremeSide} at extreme, regime=${regime})`,
      signalSource: "chop_fader",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.enteredThisCandle = false;
    this.lastCandleKey = "";
  }
}
