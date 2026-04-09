import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Apex Predator — Gemini's "UberEngine" design, cleaned up for arena.
 * Combines rebate harvesting, extreme-zone maker orders, and settlement holding.
 * Based on analysis of fade-v3 + bred-yjiz winning patterns.
 */
export class ApexPredatorEngine extends AbstractEngine {
  id = "apex-predator";
  name = "Apex Predator";
  version = "1.0.0";

  private readonly extremeZone = 0.18;
  private readonly makerBias = 0.90;
  private readonly orderSize = 10;            // fixed $10 per order
  private readonly maxPositionsPerCandle = 2;
  private readonly settlementBuffer = 45;

  private lastBinanceMid = 0;
  private binanceMomentum = 0;
  private consecutiveStrongMoves = 0;
  private lastMarketTokens = "";
  private candlePositions = 0;

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    if (tick.source === "binance") {
      if (this.lastBinanceMid > 0) {
        this.binanceMomentum = (tick.midPrice - this.lastBinanceMid) / this.lastBinanceMid;
        this.consecutiveStrongMoves = Math.abs(this.binanceMomentum) > 0.004
          ? this.consecutiveStrongMoves + 1
          : 0;
      }
      this.lastBinanceMid = tick.midPrice;
      return [];
    }

    if (tick.source !== "polymarket") return [];

    const mid = tick.midPrice;
    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();

    // Detect candle rotation
    const currentTokens = `${upTokenId}:${downTokenId}`;
    if (currentTokens !== this.lastMarketTokens) {
      this.candlePositions = 0;
      this.lastMarketTokens = currentTokens;
    }

    // Settlement guard — hold everything, stop trading
    const secsLeft = this.getSecondsRemaining();
    if (secsLeft >= 0 && secsLeft < this.settlementBuffer) return [];

    // No exits — hold to settlement for $1.00 payout
    // (Gemini's original had merge/SL exits but that defeats the core edge)

    // ── Entry: predatory maker at extremes ──
    if (this.candlePositions >= this.maxPositionsPerCandle) return [];

    const isUpCheap = mid <= this.extremeZone;
    const isDownCheap = (1 - mid) <= this.extremeZone;
    if (!isUpCheap && !isDownCheap) return [];

    // Require sustained momentum (>2 consecutive strong moves) to filter HFT noise
    if (this.consecutiveStrongMoves < 2) return [];

    const buyUp = isUpCheap && this.binanceMomentum < -0.005;
    const buyDown = isDownCheap && this.binanceMomentum > 0.005;

    if (!buyUp && !buyDown) return [];

    const targetTokenId = buyUp ? upTokenId : downTokenId;
    const entryPrice = buyUp ? mid : (1 - mid);
    const edge = this.feeAdjustedEdge(entryPrice + 0.03, entryPrice);
    if (!edge.profitable) return [];

    const useMaker = Math.random() < this.makerBias;
    const limitPrice = buyUp
      ? tick.bestBid + 0.001
      : (1 - tick.bestAsk) + 0.001;
    const shares = Math.floor(this.orderSize / limitPrice);
    if (shares < 5) return [];

    this.candlePositions++;

    return [this.buy(targetTokenId, limitPrice, shares, {
      orderType: useMaker ? "maker" : "taker",
      note: `Apex ${buyUp ? "UP" : "DOWN"} @ ${(limitPrice * 100).toFixed(1)}¢, hold to settle`,
      signalSource: "predatory_maker"
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.lastBinanceMid = 0;
    this.binanceMomentum = 0;
    this.consecutiveStrongMoves = 0;
    this.lastMarketTokens = "";
    this.candlePositions = 0;
  }
}
