import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * maker-momentum-v1 — directional maker using Binance momentum + GTC limit orders.
 *
 * The pivot from taker to maker strategies after live PM trading (Apr 20-21)
 * proved that taker fills at extreme prices (5-18¢) are unfillable on
 * winning candles — faster bots eat the liquidity. Maker orders solve this
 * by POSTING liquidity instead of racing for it.
 *
 * Strategy:
 *   1. Wait T+60-180s into candle for Binance direction confirmation
 *   2. Pick the side momentum favors (UP if rising, DOWN if falling)
 *   3. POST a maker BUY limit 3 ticks below bestAsk (won't cross spread)
 *   4. GTC subsystem holds the order until book crosses our limit or candle expires
 *   5. If filled, hold to settlement (same as stingo/bred)
 *
 * Advantages over taker (stingo43-late-v1):
 *   - 0% fee + 20% rebate (vs ~1% quartic taker fee at mid-prices)
 *   - No race condition: order sits on book, fill comes to us
 *   - Wider entry window: T+60-180s vs stingo's T+150-210s
 *
 * Key risk: adverse selection — the fills we GET may be the ones where
 * the market is about to move against us (informed takers crossing our
 * bid). Mitigated by the momentum gate (only post when direction is
 * already established).
 */
export class MakerMomentumEngine extends AbstractEngine {
  id = "maker-momentum-v1";
  name = "Maker Momentum (directional limit)";
  version = "1.0.0";

  private readonly entryWindowStartSec = 60;
  private readonly entryWindowEndSec = 180;
  private readonly momentumThreshold = 0.0005; // 5 bps
  private readonly momentumLookbackSec = 120;
  private readonly spreadTicks = 3;            // post 3 ticks ($0.003) below bestAsk
  private readonly maxCashPct = 0.25;

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
      this.enteredThisCandle = false;
      this.lastCandleKey = candleKey;
    }

    // Already posted this candle — one order per candle
    if (this.enteredThisCandle) return [];

    if (this.hasPendingOrder()) return [];

    // Timing gate: wait for direction confirmation but don't wait too long
    const secsRemaining = this.getSecondsRemaining();
    if (secsRemaining < 0) return [];
    const windowStart = this.getWindowStart();
    const windowEnd = this.state.marketWindowEnd || 0;
    const candleSec = Math.round((windowEnd - windowStart) / 1000);
    if (candleSec <= 0) return [];
    const elapsed = candleSec - secsRemaining;
    // Scale entry window proportionally for non-5M candles (60-180s for 300s candle)
    const scale = candleSec / 300;
    const windowStartSec = this.entryWindowStartSec * scale;
    const windowEndSec = this.entryWindowEndSec * scale;
    if (elapsed < windowStartSec || elapsed > windowEndSec) return [];

    // Momentum gate: need a clear directional signal
    const lookback = Math.min(elapsed, this.momentumLookbackSec * scale);
    const momentum = this.recentMomentum(lookback);
    if (Math.abs(momentum) < this.momentumThreshold) return [];

    // Pick side: momentum > 0 → price rising → UP is winning → buy UP
    const buyUp = momentum > 0;
    const tokenId = buyUp ? upTokenId : downTokenId;
    const book = this.getBookForToken(tokenId);
    if (!this.isBookTradeable(book)) return [];

    const bestAsk = book.asks[0]?.price ?? 0;
    if (bestAsk <= 0 || bestAsk > 0.95) return [];

    // Post limit BELOW the ask (maker, won't cross spread)
    const limitPrice = bestAsk - this.spreadTicks * 0.001;
    if (limitPrice <= 0.01) return [];

    // Post-only safety: verify we're not crossing
    const bestBid = book.bids[0]?.price ?? 0;
    if (limitPrice >= bestAsk) return []; // would cross — skip

    // Edge check at our limit price with directional model prob
    const edge = this.feeAdjustedEdge(0.70, limitPrice);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / limitPrice);
    if (shares < 5) return [];

    this.enteredThisCandle = true;
    this.markPending(tokenId);

    return [this.buy(tokenId, limitPrice, shares, {
      orderType: "maker",
      note: `maker-momentum: ${buyUp ? "UP" : "DOWN"} limit ${limitPrice.toFixed(3)} (ask=${bestAsk.toFixed(3)}, mom=${(momentum * 10000).toFixed(1)}bps)`,
      signalSource: "maker_momentum",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.enteredThisCandle = false;
    this.lastCandleKey = "";
  }
}
