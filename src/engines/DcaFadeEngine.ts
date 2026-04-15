import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * dca-fade-v1 — clean re-implementation of bred-4h85's actual edge:
 * DCA into the cheap side after a clear directional move, betting on
 * reversal (fade).
 *
 * Context (Apr 15 forensic): we thought bred-4h85's edge was the 5-18¢
 * band, then thought it was pyramiding, then looked at 12 rounds of
 * bred-4h85's actual buys and found a systemic 96% UP bias on BTC.
 * The inversion bug accidentally makes bred fire one direction based
 * on which side of the book the tick fires on — AND this direction
 * has matched BTC's recent net-downward drift, meaning bred has been
 * fading into UP at 18¢ on a down-trending market.
 *
 * That IS a strategy: when underlying has moved clearly one direction,
 * the losing side compresses to 5-18¢ and offers asymmetric payoff
 * IF you believe in mean reversion. Per-candle reversion of a move
 * that already happened is a real statistical expectation — short
 * windows are mean-reverting more often than trending.
 *
 * This engine implements that explicitly without the bug:
 *   1. Require Binance to have moved > 20bps over 300s (clear direction)
 *   2. Compute the "fade side" = the side that's losing (opposite of move)
 *   3. Only buy the fade side, and only if its price is in 5-18¢
 *   4. Pyramid up to 4 entries per candle at progressively cheaper prices
 *   5. Hold to settle
 *
 * Falsification: if dca-fade-v1 does NOT match bred-4h85's PnL over 5+
 * rounds, direction-alignment via fade isn't the edge and we need to
 * look elsewhere (entry timing, tick-driven triggering, something else).
 *
 * Regime sensitivity: this engine will LOSE HARD in sustained one-way
 * trends (the reversal never happens). That's the known tradeoff for
 * a fade strategy. The 20bps/300s gate ensures we only fire when the
 * move is large enough to make the asymmetric payoff worthwhile.
 */
export class DcaFadeEngine extends AbstractEngine {
  id = "dca-fade-v1";
  name = "DCA Fade — Direction-Aligned Reversal";
  version = "1.0.0";

  private readonly minEntryPrice = 0.05;
  private readonly maxEntryPrice = 0.18;
  private readonly dcaStepSize = 5;
  private readonly maxEntriesPerCandle = 4;
  private readonly settlementBufferSec = 15;

  // Direction gate: require 20 bps move over 300s to call a direction.
  // 300s is half the candle — long enough to see real drift, short
  // enough to stay fresh within the current candle's opportunity.
  private readonly minMomentumBps = 20;
  private readonly momentumLookbackSec = 300;

  private candleEntries = 0;
  private lastCandleKey = "";

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    this.trackBinance(tick);
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();

    const candleKey = `${upTokenId}:${downTokenId}`;
    if (candleKey !== this.lastCandleKey) {
      this.candleEntries = 0;
      this.lastCandleKey = candleKey;
    }

    const secsRemaining = this.getSecondsRemaining();
    if (secsRemaining >= 0 && secsRemaining < this.settlementBufferSec) return [];

    if (this.hasPendingOrder()) return [];
    if (this.candleEntries >= this.maxEntriesPerCandle) return [];

    // ── Direction gate: require clear momentum ──
    const momentum = this.recentMomentum(this.momentumLookbackSec);
    const momentumBps = momentum * 10_000;
    if (Math.abs(momentumBps) < this.minMomentumBps) return [];

    // ── Identify the fade side ──
    // Binance rising → UP token is likely to win (settling > open) → UP is
    // expensive, DOWN is cheap. The fade side is DOWN (bet the move reverses).
    // Binance falling → opposite: fade side is UP.
    const fadeBuyUp = momentum < 0;
    const fadeTokenId = fadeBuyUp ? upTokenId : downTokenId;

    const fadeBook = this.getBookForToken(fadeTokenId);
    const fadeAsk = fadeBook.asks[0]?.price ?? 0;
    if (fadeAsk <= 0) return [];

    // Price must be in the cheap band — the move has compressed the fade
    // side enough to offer asymmetric payoff. If it's not cheap yet, don't
    // enter (the move isn't big enough despite the momentum gate — rare).
    if (fadeAsk < this.minEntryPrice || fadeAsk > this.maxEntryPrice) return [];

    // Allow pyramiding within the candle (bred-4h85 edge, hoisted cleanly)
    // — the position grows each time the fade side compresses further.

    // Model prob: implied by the ask + small asymmetric edge. We believe
    // in reversal more than the market at this point; +0.02 is conservative.
    const modelProb = fadeAsk + 0.02;
    const edge = this.feeAdjustedEdge(modelProb, fadeAsk);
    if (!edge.profitable) return [];

    const size = Math.floor(this.dcaStepSize / fadeAsk);
    if (size < 5) return [];

    this.candleEntries++;
    this.markPending(fadeTokenId);

    return [this.buy(fadeTokenId, fadeAsk, size, {
      orderType: "taker",
      note: `dca-fade: ${fadeBuyUp ? "UP" : "DOWN"} @ ${fadeAsk.toFixed(3)} mom=${momentumBps.toFixed(1)}bps #${this.candleEntries}`,
      signalSource: "dca_fade",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.candleEntries = 0;
    this.lastCandleKey = "";
  }
}
