import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Maker Settle — combines the best patterns from profitable engines:
 * - yjiz's maker-only orders (unfilled = zero cost)
 * - fade-v3's hold-to-settlement (let binary resolution pay $1 or $0)
 * - Trades both UP and DOWN (whichever is cheap)
 * - Fixed position sizing from starting cash
 * - No stop-loss, no take-profit — pure settlement play
 */
export class MakerSettleEngine extends AbstractEngine {
  id = "maker-settle-v1";
  name = "Maker Settle";
  version = "1.0.0";

  // Only place orders when a token is below this price
  private readonly maxEntryPrice = 0.20;
  // Fixed dollar amount per order (from starting cash, not current)
  private readonly orderSize = 8;
  // Max open positions per candle (limits exposure)
  private readonly maxPositionsPerCandle = 2;
  // Minimum momentum to confirm extreme (avoid placing orders in choppy mid-range)
  private readonly minMomentum = 0.003;
  // Minimum ticks between orders (don't spam)
  private readonly minTicksBetweenOrders = 5;

  // ── Tracking ──
  private lastBinanceMid = 0;
  private binanceMomentum = 0;
  private lastMarketTokens = "";
  private candlePositions = 0;
  private ticksSinceLastOrder = 999;

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    if (tick.source === "binance") {
      if (this.lastBinanceMid > 0) {
        this.binanceMomentum = (tick.midPrice - this.lastBinanceMid) / this.lastBinanceMid;
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

    this.ticksSinceLastOrder++;

    // No exits — hold everything to settlement

    // ── Entry logic: maker orders on cheap tokens ──

    if (this.candlePositions >= this.maxPositionsPerCandle) return [];
    if (this.ticksSinceLastOrder < this.minTicksBetweenOrders) return [];

    // Don't enter in last 45 seconds
    const secsLeft = this.getSecondsRemaining();
    if (secsLeft >= 0 && secsLeft < 45) return [];

    const absMomentum = Math.abs(this.binanceMomentum);
    if (absMomentum < this.minMomentum) return [];

    const upPrice = mid;
    const downPrice = 1 - mid;

    // Buy UP if it's cheap (price crashing, momentum down)
    if (upPrice <= this.maxEntryPrice && this.binanceMomentum < 0) {
      const edge = this.feeAdjustedEdge(upPrice + 0.02, upPrice);
      if (!edge.profitable) return [];

      const limitPrice = tick.bestBid + 0.001;
      const shares = Math.floor(this.orderSize / limitPrice);
      if (shares < 5) return [];

      this.ticksSinceLastOrder = 0;
      this.candlePositions++;

      return [this.buy(upTokenId, limitPrice, shares, {
        orderType: "maker",
        note: `MkrSettle UP @ ${(limitPrice * 100).toFixed(1)}¢, hold to settle`,
        signalSource: "maker_settle"
      })];
    }

    // Buy DOWN if it's cheap (price pumping, momentum up)
    if (downPrice <= this.maxEntryPrice && this.binanceMomentum > 0) {
      const edge = this.feeAdjustedEdge(downPrice + 0.02, downPrice);
      if (!edge.profitable) return [];

      const limitPrice = (1 - tick.bestAsk) + 0.001;
      const shares = Math.floor(this.orderSize / limitPrice);
      if (shares < 5) return [];

      this.ticksSinceLastOrder = 0;
      this.candlePositions++;

      return [this.buy(downTokenId, limitPrice, shares, {
        orderType: "maker",
        note: `MkrSettle DOWN @ ${(limitPrice * 100).toFixed(1)}¢, hold to settle`,
        signalSource: "maker_settle"
      })];
    }

    return [];
  }

  onRoundEnd(_state: EngineState): void {
    this.lastBinanceMid = 0;
    this.binanceMomentum = 0;
    this.lastMarketTokens = "";
    this.candlePositions = 0;
    this.ticksSinceLastOrder = 999;
  }
}
