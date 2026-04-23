import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * second-half-decider-v1 — enter at mid-candle after direction commits.
 *
 * Designed for 1h/4h candles. Ignore the first half (noise, direction
 * not yet established). At T+50% into the candle, check if Binance has
 * committed to a direction (cumulative move ≥ threshold). If yes,
 * enter the leading PM side at a fair price. Hold to settlement.
 *
 * Why mid-candle works for longer intervals:
 *   - First hour of a 4h candle: random noise, price can bounce either way
 *   - By T+50%, if price HAS moved ≥50bps, direction is usually set
 *   - Remaining 50% of candle = time for PM price to drift toward settlement
 *
 * This avoids two failure modes:
 *   - Late entry (last 15%) → not enough drift time
 *   - Early entry (first 30%) → direction not committed
 */
export class SecondHalfDeciderEngine extends AbstractEngine {
  id = "second-half-decider-v1";
  name = "Second-Half Decider (1h/4h mid-candle)";
  version = "1.0.0";

  private readonly entryStartFrac = 0.45;
  private readonly entryEndFrac = 0.75;
  private readonly commitLookbackFrac = 0.40; // use 40% of candle as commit window
  private readonly commitThreshBps = 50;      // need ≥50bps sustained move
  private readonly entryMinPrice = 0.40;
  private readonly entryMaxPrice = 0.65;
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

    // Only runs on longer candles (15m+) — concept doesn't work on 5m
    if (candleSec < 900) return [];

    const elapsedFrac = (candleSec - secsRemaining) / candleSec;
    if (elapsedFrac < this.entryStartFrac || elapsedFrac > this.entryEndFrac) return [];

    // Commit check: cumulative Binance move over the first half-ish of candle
    const commitLookback = candleSec * this.commitLookbackFrac;
    const commitMom = this.recentMomentum(commitLookback);
    const commitBps = commitMom * 10000;
    if (Math.abs(commitBps) < this.commitThreshBps) return [];

    const buyUp = commitMom > 0;
    const tokenId = buyUp ? upTokenId : downTokenId;
    const book = this.getBookForToken(tokenId);
    if (!this.isBookTradeable(book)) return [];
    const bestAsk = book.asks[0]?.price ?? 0;
    if (bestAsk < this.entryMinPrice || bestAsk > this.entryMaxPrice) return [];

    const edge = this.feeAdjustedEdge(0.75, bestAsk);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / bestAsk);
    if (shares < 5) return [];

    this.enteredThisCandle = true;
    this.markPending(tokenId);
    return [this.buy(tokenId, bestAsk, shares, {
      orderType: "taker",
      note: `second-half ${buyUp ? "UP" : "DOWN"} @ ${bestAsk.toFixed(3)} (commit=${commitBps.toFixed(0)}bps over ${Math.round(commitLookback/60)}min)`,
      signalSource: "second_half_decider",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.enteredThisCandle = false;
    this.lastCandleKey = "";
  }
}
