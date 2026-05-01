import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * event-reactor-v1 — react to sudden Binance spikes with leading-side taker.
 *
 * Designed for 1h/4h candles where news/event moves produce real
 * asymmetric information. Most of our engines use 60-120s momentum
 * lookback — useless on 1h where a "move" develops over 5-10min.
 *
 * Strategy: detect a sudden Binance move (≥40bps in 3 minutes), confirm
 * the trend has held (positive momentum over 10min), then enter the
 * leading PM side at 30-55¢. One entry per candle, hold to settlement.
 *
 * Why this fits 1h/4h:
 *   - 5m candles are too short for events to develop; this just becomes noise
 *   - 1h/4h candles span typical news events (economic releases, Asian/EU open)
 *   - Sudden 40bps moves in multi-minute windows are rare and directional
 */
export class EventReactorEngine extends AbstractEngine {
  id = "event-reactor-v1";
  name = "Event Reactor (1h/4h spike chaser)";
  version = "1.0.0";

  private readonly spikeLookbackSec = 180;   // 3 min
  private readonly spikeThreshBps = 40;       // ≥40bps move in 3 min
  private readonly trendLookbackSec = 600;    // 10 min
  private readonly trendThreshBps = 20;       // and ≥20bps over 10 min (same direction)
  private readonly entryStartFrac = 0.10;
  private readonly entryEndFrac = 0.80;
  private readonly entryMinPrice = 0.30;
  private readonly entryMaxPrice = 0.55;
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

    // Only runs on longer candles (skip 5m entirely; event moves need time)
    if (candleSec < 600) return [];

    const elapsedFrac = (candleSec - secsRemaining) / candleSec;
    if (elapsedFrac < this.entryStartFrac || elapsedFrac > this.entryEndFrac) return [];

    // Sudden spike + sustained trend in same direction
    const spikeMom = this.recentMomentum(this.spikeLookbackSec);
    const trendMom = this.recentMomentum(this.trendLookbackSec);
    const spikeBps = spikeMom * 10000;
    const trendBps = trendMom * 10000;
    if (Math.abs(spikeBps) < this.spikeThreshBps) return [];
    if (Math.abs(trendBps) < this.trendThreshBps) return [];
    if (Math.sign(spikeBps) !== Math.sign(trendBps)) return [];  // must agree

    const buyUp = spikeMom > 0;
    const tokenId = buyUp ? upTokenId : downTokenId;
    const book = this.getBookForToken(tokenId);
    if (!this.isBookTradeable(book)) return [];
    const bestAsk = book.asks[0]?.price ?? 0;
    if (bestAsk < this.entryMinPrice || bestAsk > this.entryMaxPrice) return [];

    const edge = this.feeAdjustedEdge(0.72, bestAsk);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / bestAsk);
    if (shares < 5) return [];

    this.enteredThisCandle = true;
    this.markPending(tokenId);
    return [this.buy(tokenId, bestAsk, shares, {
      orderType: "taker",
      note: `event ${buyUp ? "UP" : "DOWN"} @ ${bestAsk.toFixed(3)} (spike=${spikeBps.toFixed(0)}bps, trend=${trendBps.toFixed(0)}bps)`,
      signalSource: "event_reactor",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.enteredThisCandle = false;
    this.lastCandleKey = "";
  }
}
