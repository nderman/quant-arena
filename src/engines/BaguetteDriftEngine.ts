import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * baguette-drift-v1 — mid-candle entry, hold to resolution drift.
 *
 * Based on live PM trader 0xe007 ("Baguette"): +$812K lifetime.
 * Avg entry $0.56, avg exit $0.72. Not betting on direction — betting
 * that the candle RESOLVES. At T-mid, price is ~0.56 (uncertainty);
 * by T-0 one side drifts to 0.90+ and the other to 0.10.
 *
 * Strategy:
 *   1. Wait T+120-180s into candle (mid-to-late entry window)
 *   2. Pick leading side from Binance momentum (side that's already winning)
 *   3. Taker BUY at current ask if price is in the 0.52-0.62 uncertainty band
 *   4. Hold to settlement — the drift is the trade
 *
 * Why taker: we need to commit immediately. Maker resting at 0.55 in
 * this zone usually doesn't fill — MMs keep tight spreads at mid.
 *
 * Applies to any interval (5m / 15m / 1h / 4h). Window sec scale.
 */
export class BaguetteDriftEngine extends AbstractEngine {
  id = "baguette-drift-v1";
  name = "Baguette Mid-Candle Drift";
  version = "1.0.0";

  private readonly entryStartSec = 120;     // Baguette enters at mid-candle
  private readonly entryEndSec = 180;       // must have ~90s+ left after entry
  private readonly entryMinPrice = 0.52;
  private readonly entryMaxPrice = 0.62;
  private readonly momentumThresh = 0.0002; // 2bps enough to call a leading side
  private readonly momentumLookback = 60;
  private readonly maxCashPct = 0.20;

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
    const elapsed = candleSec - secsRemaining;
    const scale = candleSec / 300;
    if (elapsed < this.entryStartSec * scale) return [];
    if (elapsed > this.entryEndSec * scale) return [];

    // Momentum picks leading side — we buy the one already winning
    const momentum = this.recentMomentum(this.momentumLookback);
    if (Math.abs(momentum) < this.momentumThresh) return [];

    const buyUp = momentum > 0;
    const tokenId = buyUp ? upTokenId : downTokenId;
    const book = this.getBookForToken(tokenId);
    if (!this.isBookTradeable(book)) return [];

    const bestAsk = book.asks[0]?.price ?? 0;
    if (bestAsk < this.entryMinPrice || bestAsk > this.entryMaxPrice) return [];

    // Fee check: raw edge must survive taker fee at this mid-price
    const edge = this.feeAdjustedEdge(0.68, bestAsk);  // expect drift to ~0.72
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / bestAsk);
    if (shares < 5) return [];

    this.enteredThisCandle = true;
    this.markPending(tokenId);
    return [this.buy(tokenId, bestAsk, shares, {
      orderType: "taker",
      note: `baguette ${buyUp ? "UP" : "DOWN"} @ ${bestAsk.toFixed(3)} (mom=${(momentum * 10000).toFixed(1)}bps)`,
      signalSource: "baguette_drift",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.enteredThisCandle = false;
    this.lastCandleKey = "";
  }
}
