import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * bonereader-sniper-v1 — last-second confirmed-winner sniper.
 *
 * Based on live PM trader 0xd84c ("BoneReader"): 95%+ WR at 0.93-0.99 entry.
 * The 1-5% margin is small but the WR is enormous because they buy only
 * AFTER external data confirms the winner. No direction bet — just grab
 * the remaining edge when settlement is all-but-certain.
 *
 * Our external data = Binance price vs candle open. At T-20s in a 5M
 * candle, if Binance is +20bps above the open, UP is essentially certain.
 * Buy UP at 0.95, settle $1.00 = 5¢ margin, minus tiny fee (P=0.95 → 0.05% fee).
 *
 * Requires fast execution: engine fires every tick in the last 30s
 * window. When all conditions align, submit taker.
 */
export class BoneReaderSniperEngine extends AbstractEngine {
  id = "bonereader-sniper-v1";
  name = "BoneReader Last-Second Sniper";
  version = "1.0.0";

  private readonly windowStartSec = 30;      // fire only in last 30s
  private readonly windowEndSec = 10;        // killswitch at T-10 (too late to fill)
  private readonly entryMinPrice = 0.92;
  private readonly entryMaxPrice = 0.99;
  private readonly maxSpread = 0.02;         // must be tight book
  private readonly confirmThreshBps = 15;    // Binance must be >= this much from open
  private readonly maxCashPct = 0.20;

  private enteredThisCandle = false;
  private lastCandleKey = "";
  private binancePriceAtWindowStart = 0;
  private windowStartTrackedKey = "";

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
      this.binancePriceAtWindowStart = 0;
      this.windowStartTrackedKey = "";
    }

    // Capture Binance price at candle-window-start (the strike reference)
    // We snapshot it once per candle as early as possible so we know the
    // reference price that will be compared for UP/DOWN resolution.
    if (this.binancePriceAtWindowStart === 0) {
      const lastPx = this.lastBinancePrice();
      if (lastPx > 0) {
        this.binancePriceAtWindowStart = lastPx;
        this.windowStartTrackedKey = candleKey;
      }
    }
    if (this.binancePriceAtWindowStart === 0) return [];

    if (this.enteredThisCandle) return [];
    if (this.hasPendingOrder()) return [];

    const secsRemaining = this.getSecondsRemaining();
    if (secsRemaining < 0) return [];
    if (secsRemaining > this.windowStartSec) return [];  // too early
    if (secsRemaining < this.windowEndSec) return [];    // too late

    // Confirm which side has essentially won based on current Binance
    const currentPx = this.lastBinancePrice();
    if (currentPx <= 0) return [];
    const binanceMoveBps = ((currentPx - this.binancePriceAtWindowStart) / this.binancePriceAtWindowStart) * 10000;
    if (Math.abs(binanceMoveBps) < this.confirmThreshBps) return [];

    const buyUp = binanceMoveBps > 0;
    const tokenId = buyUp ? upTokenId : downTokenId;
    const book = this.getBookForToken(tokenId);
    if (!this.isBookTradeable(book)) return [];

    const bestAsk = book.asks[0]?.price ?? 0;
    const bestBid = book.bids[0]?.price ?? 0;
    if (bestAsk < this.entryMinPrice || bestAsk > this.entryMaxPrice) return [];
    if (bestAsk - bestBid > this.maxSpread) return [];  // book too wide

    const edge = this.feeAdjustedEdge(0.98, bestAsk);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / bestAsk);
    if (shares < 5) return [];

    this.enteredThisCandle = true;
    this.markPending(tokenId);
    return [this.buy(tokenId, bestAsk, shares, {
      orderType: "taker",
      note: `bonereader ${buyUp ? "UP" : "DOWN"} @ ${bestAsk.toFixed(3)} (binance ${binanceMoveBps >= 0 ? "+" : ""}${binanceMoveBps.toFixed(1)}bps, ${secsRemaining}s left)`,
      signalSource: "bonereader_sniper",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.enteredThisCandle = false;
    this.lastCandleKey = "";
    this.binancePriceAtWindowStart = 0;
    this.windowStartTrackedKey = "";
  }
}
