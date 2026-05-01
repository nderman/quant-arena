import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * trend-confirmer-v1 — enter the leading side AFTER trend is confirmed.
 *
 * Problem with existing engines:
 *   - bred-4h85-maker (15-30¢ DCA): loses in chop, wins in trend
 *   - stingo43-late (60-75¢ momentum): wrong asymmetry, wins are tiny
 *   - dca-native-tick (14-18¢): slips below adverse-selection gate
 *
 * This engine's niche: buy the LEADING side at 35-45¢ AFTER Binance
 * confirms sustained directional move. Above the FIFO queue floor,
 * above the adverse-selection gate, but below mid-price — so winners
 * pay 1.5x the losers. Settle $1 → +$0.60; settle $0 → -$0.40.
 *
 * Thesis: waiting for confirmed move avoids chop entirely. If Binance
 * moved 30bps+ in 60s, the candle has "decided." The leading PM side
 * should drift from 40¢ toward 70-90¢ by settlement.
 *
 * Hold to settlement. No exits. One entry per candle.
 */
export class TrendConfirmerEngine extends AbstractEngine {
  id = "trend-confirmer-v1";
  name = "Trend Confirmer (leading-side taker)";
  version = "1.0.0";

  private readonly entryStartSec = 60;       // wait for confirmation window
  private readonly entryEndSec = 210;        // don't enter in last ~90s
  private readonly trendThreshBps = 30;      // Binance must move ≥30bps
  private readonly momentumLookback = 60;
  private readonly entryMinPrice = 0.35;
  private readonly entryMaxPrice = 0.45;
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

    // Trend confirmation: ≥30bps move in the lookback window
    const momentum = this.recentMomentum(this.momentumLookback * scale);
    const momentumBps = momentum * 10000;
    if (Math.abs(momentumBps) < this.trendThreshBps) return [];

    const buyUp = momentum > 0;
    const tokenId = buyUp ? upTokenId : downTokenId;
    const book = this.getBookForToken(tokenId);
    if (!this.isBookTradeable(book)) return [];

    const bestAsk = book.asks[0]?.price ?? 0;
    if (bestAsk < this.entryMinPrice || bestAsk > this.entryMaxPrice) return [];

    // Edge check — expect drift to ~0.80 by settlement
    const edge = this.feeAdjustedEdge(0.72, bestAsk);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / bestAsk);
    if (shares < 5) return [];

    this.enteredThisCandle = true;
    this.markPending(tokenId);
    return [this.buy(tokenId, bestAsk, shares, {
      orderType: "taker",
      note: `trend-confirmer ${buyUp ? "UP" : "DOWN"} @ ${bestAsk.toFixed(3)} (mom=${momentumBps.toFixed(1)}bps)`,
      signalSource: "trend_confirmer",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.enteredThisCandle = false;
    this.lastCandleKey = "";
  }
}
