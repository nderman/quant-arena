import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Ported from polymarket-ai-bot croissantV2Engine.
 * Exploits Binance-to-PM repricing lag: enter when Binance has moved
 * >0.10% from candle open but PM still prices the winner at 25-40¢.
 * Entry window: 60-90s into candle (direction confirmation).
 * Hold to settlement.
 */
export class CroissantV2Engine extends AbstractEngine {
  id = "croissant-v2";
  name = "Croissant V2 — Momentum Lag";
  version = "1.0.0";

  private readonly momentumThreshold = 0.001; // 0.10%
  private readonly entryMin = 0.25;
  private readonly entryMax = 0.40;
  private readonly entryWindowStartSec = 60;
  private readonly entryWindowEndSec = 90;
  private readonly velocityLookbackMs = 10_000;
  private readonly maxCashPct = 0.25;

  // Binance price tracking
  private binanceSamples: { price: number; time: number }[] = [];
  private readonly maxSamples = 30;
  private candleOpenPrice = 0;
  private candleOpenTime = 0;

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    if (tick.source === "binance") {
      const now = Date.now();
      this.binanceSamples.push({ price: tick.midPrice, time: now });
      if (this.binanceSamples.length > this.maxSamples) this.binanceSamples.shift();
      return [];
    }

    if (tick.source !== "polymarket") return [];

    const rotated = this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];

    if (rotated) {
      const latest = this.binanceSamples[this.binanceSamples.length - 1];
      if (latest) {
        this.candleOpenPrice = latest.price;
        this.candleOpenTime = latest.time;
      }
    }

    if (this.candleOpenPrice <= 0) return [];

    // Already holding — hold to settlement
    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];
    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    // Entry window: 60-90s into the 5-minute candle
    const secsRemaining = this.getSecondsRemaining();
    if (secsRemaining < 0) return [];
    const elapsed = 300 - secsRemaining;
    if (elapsed < this.entryWindowStartSec || elapsed > this.entryWindowEndSec) return [];

    // Momentum: Binance move from candle open
    const latest = this.binanceSamples[this.binanceSamples.length - 1];
    if (!latest) return [];
    const momentum = (latest.price - this.candleOpenPrice) / this.candleOpenPrice;
    const absMomentum = Math.abs(momentum);
    if (absMomentum < this.momentumThreshold) return [];

    // Velocity: still accelerating? (optional — log but don't gate)
    const velocitySample = this.binanceSamples.find(
      s => Math.abs(s.time - (Date.now() - this.velocityLookbackMs)) < 3000
    );
    const velocity = velocitySample
      ? (latest.price - velocitySample.price) / velocitySample.price
      : 0;

    // Buy the side Binance says is winning
    const buyUp = momentum > 0;
    const tokenId = buyUp ? upTokenId : downTokenId;
    const book = getBookForToken(tokenId);
    const askPrice = book.asks[0]?.price ?? 0;
    if (askPrice <= 0) return [];

    // PM price must still be cheap (the lag signal)
    if (askPrice < this.entryMin || askPrice > this.entryMax) return [];

    const edge = this.feeAdjustedEdge(0.65, askPrice);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / askPrice);
    if (shares < 5) return [];

    this.markPending(tokenId);
    return [this.buy(tokenId, askPrice, shares, {
      orderType: "taker",
      note: `croissant-v2: ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)}, mom=${(momentum * 100).toFixed(3)}%, vel=${(velocity * 100).toFixed(4)}%, T+${elapsed.toFixed(0)}s`,
      signalSource: "croissant_v2",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.binanceSamples = [];
    this.candleOpenPrice = 0;
    this.candleOpenTime = 0;
  }
}
