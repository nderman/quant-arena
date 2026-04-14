import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * dca-trend-extreme-v1 — selectivity-first DCA into extreme underdogs.
 *
 * Same core mechanism as dca-extreme-v1 (5-18¢ asymmetric-payoff DCA, hold
 * to settle), but with a directional gate: only buy UP when Binance has
 * been rising over the last 60s, only buy DOWN when Binance has been
 * falling. The "silent engines are good engines" principle (Apr 14): we
 * deliberately fire less often, betting that the hits we do take align
 * with the underlying move and so resolve in our favor more often.
 *
 * Hypothesis: 50% WR × 4:1 payoff (current dca-extreme baseline) becomes
 * 60-65% WR × 4:1 payoff once we're only entering on tickets where the
 * underlying is moving the right way. That's a 25-50% lift in expected
 * PnL per fire.
 *
 * Falsification: if win rate doesn't lift after ~20 trades, the gate is
 * either too loose (catching too many false trends) or too restrictive
 * (silencing during real opportunities). Tune lookback / threshold or
 * cull.
 */
export class DcaTrendExtremeEngine extends AbstractEngine {
  id = "dca-trend-extreme-v1";
  name = "DCA Trend-Aligned Extreme";
  version = "1.0.0";

  private readonly minEntryPrice = 0.05;
  private readonly maxEntryPrice = 0.18;
  private readonly dcaStepSize = 5;
  private readonly maxEntriesPerCandle = 4;
  private readonly settlementBufferSec = 15;

  // Trend gate parameters
  private readonly momentumLookbackSec = 60;
  // Minimum |drift| over 60s to call the move directional. 5bps = 0.05%
  // — modest enough to fire often, large enough to filter noise.
  private readonly minMomentumBps = 5;

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

    // ── Trend gate: require directional Binance move over lookback ──
    // recentMomentum returns (current - oldest_in_window) / oldest, so
    // positive means rising. Need at least minMomentumBps in either
    // direction; below that the market is too quiet to call.
    const momentum = this.recentMomentum(this.momentumLookbackSec);
    const momentumBps = momentum * 10_000;
    if (Math.abs(momentumBps) < this.minMomentumBps) return [];

    const upBook = this.getBookForToken(upTokenId);
    const downBook = this.getBookForToken(downTokenId);
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    const upCheap = upAsk >= this.minEntryPrice && upAsk <= this.maxEntryPrice;
    const downCheap = downAsk >= this.minEntryPrice && downAsk <= this.maxEntryPrice;
    if (!upCheap && !downCheap) return [];

    // ── Direction lock: only buy the side momentum favors ──
    // Rising binance → UP candle is more likely to settle to 1 → buy UP.
    // Falling binance → DOWN candle is more likely → buy DOWN.
    // If the cheap side disagrees with momentum direction, skip.
    const trendBuyUp = momentum > 0;
    const buyUp = trendBuyUp ? upCheap : false;
    const buyDown = !trendBuyUp ? downCheap : false;
    if (!buyUp && !buyDown) return [];

    const tokenId = buyUp ? upTokenId : downTokenId;
    const askPrice = buyUp ? upAsk : downAsk;

    const existing = this.getPosition(tokenId);
    if (existing && existing.shares > 0) return [];

    const modelProb = askPrice + 0.02;
    const edge = this.feeAdjustedEdge(modelProb, askPrice);
    if (!edge.profitable) return [];

    const size = Math.floor(this.dcaStepSize / askPrice);
    if (size < 5) return [];

    this.candleEntries++;
    this.markPending(tokenId);

    return [this.buy(tokenId, askPrice, size, {
      orderType: "taker",
      note: `dca-trend-extreme: ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)} (mom=${momentumBps.toFixed(1)}bps) #${this.candleEntries}`,
      signalSource: "dca_trend_extreme",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.candleEntries = 0;
    this.lastCandleKey = "";
  }
}
