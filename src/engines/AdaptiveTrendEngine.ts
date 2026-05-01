import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * adaptive-trend-v1 — trades only when its own signal has recently worked.
 *
 * The "only trade when it should" principle. Instead of firing whenever
 * entry conditions match, this engine watches its OWN recent history
 * and skips trading when its signal has been failing.
 *
 * Signal: Binance momentum direction at candle midpoint predicts winning side.
 * Track: for each completed candle in this arena, did our signal's predicted
 *   side actually win? Keep a rolling history of "signal correctness."
 * Filter: only enter a new candle if ≥60% of last 5 candles' signals were right.
 *
 * This creates self-adaptive regime awareness without hardcoding CHOP/TREND.
 * In trending regimes, signal is right → engine fires. In chop, signal
 * is random → engine goes silent. No explicit regime gate needed.
 *
 * Scales entry/lookback windows to the candle duration, so works on
 * 5m/15m/1h/4h without tuning.
 */
export class AdaptiveTrendEngine extends AbstractEngine {
  id = "adaptive-trend-v1";
  name = "Adaptive Trend (self-filtered)";
  version = "1.0.0";

  private readonly entryStartFrac = 0.30;   // T+30% into candle
  private readonly entryEndFrac = 0.70;     // T+70% (skip last 30%)
  private readonly minHistory = 3;          // warm-up: no entries until 3 signals observed
  private readonly historyWindow = 5;       // trailing window for accuracy
  private readonly minAccuracy = 0.60;      // require 60% recent accuracy
  private readonly momentumLookbackFrac = 0.20;  // use 20% of candle as momentum window
  private readonly momentumThreshBps = 15;  // minimum move to call a direction
  private readonly entryMinPrice = 0.35;
  private readonly entryMaxPrice = 0.60;
  private readonly maxCashPct = 0.20;

  // Signal history: recorded at midpoint, resolved at candle end
  private pendingSignal: { candleKey: string; predictedUp: boolean } | null = null;
  private signalHistory: boolean[] = [];  // true = correct, false = wrong

  private enteredThisCandle = false;
  private lastCandleKey = "";
  private lastUpAskAtEnd = 0;
  private lastDownAskAtEnd = 0;

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    this.trackBinance(tick);
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    const rotated = this.updatePendingOrders();
    const candleKey = `${upTokenId}:${downTokenId}`;

    // On rotation: resolve the previous signal if we had one
    if (candleKey !== this.lastCandleKey && this.lastCandleKey !== "") {
      if (this.pendingSignal && this.pendingSignal.candleKey === this.lastCandleKey) {
        // Approximate the winner by the final ask prices we saw.
        // Whichever side had the lower ask at candle end was the winner
        // (its ask approaches 0, opposite approaches 1).
        if (this.lastUpAskAtEnd > 0 && this.lastDownAskAtEnd > 0) {
          const upWon = this.lastUpAskAtEnd < this.lastDownAskAtEnd;
          const correct = this.pendingSignal.predictedUp === upWon;
          this.signalHistory.push(correct);
          if (this.signalHistory.length > this.historyWindow) {
            this.signalHistory.shift();
          }
        }
      }
      this.pendingSignal = null;
      this.enteredThisCandle = false;
      this.lastUpAskAtEnd = 0;
      this.lastDownAskAtEnd = 0;
    }
    this.lastCandleKey = candleKey;
    if (rotated) this.enteredThisCandle = false;

    // Track current ask prices — the last ones before rotation are "candle end"
    const upBook = this.getBookForToken(upTokenId);
    const downBook = this.getBookForToken(downTokenId);
    if (this.isBookTradeable(upBook) && this.isBookTradeable(downBook)) {
      this.lastUpAskAtEnd = upBook.asks[0]?.price ?? this.lastUpAskAtEnd;
      this.lastDownAskAtEnd = downBook.asks[0]?.price ?? this.lastDownAskAtEnd;
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

    // Adaptive filter: only trade if recent signal accuracy meets threshold
    if (this.signalHistory.length >= this.minHistory) {
      const correct = this.signalHistory.filter(v => v).length;
      const accuracy = correct / this.signalHistory.length;
      if (accuracy < this.minAccuracy) return [];
    }
    // While warming up (< minHistory), allow entries to build history

    // Compute current signal: Binance momentum over last 20% of candle duration
    const lookbackSec = Math.max(30, candleSec * this.momentumLookbackFrac);
    const momentum = this.recentMomentum(lookbackSec);
    const momentumBps = momentum * 10000;
    if (Math.abs(momentumBps) < this.momentumThreshBps) return [];

    const predictedUp = momentum > 0;
    const tokenId = predictedUp ? upTokenId : downTokenId;
    const book = predictedUp ? upBook : downBook;
    if (!this.isBookTradeable(book)) return [];
    const bestAsk = book.asks[0]?.price ?? 0;
    if (bestAsk < this.entryMinPrice || bestAsk > this.entryMaxPrice) return [];

    const edge = this.feeAdjustedEdge(0.65, bestAsk);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / bestAsk);
    if (shares < 5) return [];

    // Record signal so we can score it at candle end
    this.pendingSignal = { candleKey, predictedUp };
    this.enteredThisCandle = true;
    this.markPending(tokenId);

    const accuracyStr = this.signalHistory.length > 0
      ? `${Math.round(this.signalHistory.filter(v => v).length / this.signalHistory.length * 100)}%`
      : "warmup";

    return [this.buy(tokenId, bestAsk, shares, {
      orderType: "taker",
      note: `adaptive ${predictedUp ? "UP" : "DOWN"} @ ${bestAsk.toFixed(3)} (mom=${momentumBps.toFixed(1)}bps, accuracy=${accuracyStr}, n=${this.signalHistory.length})`,
      signalSource: "adaptive_trend",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.pendingSignal = null;
    this.signalHistory = [];
    this.enteredThisCandle = false;
    this.lastCandleKey = "";
    this.lastUpAskAtEnd = 0;
    this.lastDownAskAtEnd = 0;
  }
}
