import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick } from "../types";

/**
 * Pure Maker — buys the underdog at extreme prices, holds to settlement.
 *
 * Hypothesis: PM systematically slightly under-prices binary underdogs at the
 * extremes. A 5¢ token that wins 6% of the time has +EV. We don't know if this
 * is true; this engine is the test.
 *
 * Rules:
 *   - Only place MAKER buys (zero fees, +rebate, accept 12% fill probability)
 *   - Only at prices ≤ 0.10 (the underdog side)
 *   - Always sit at bestBid + 1 tick on the cheap side (UP if upPrice ≤ 0.10, else DOWN)
 *   - Max 2 open orders per candle, $5 each ($10 max risk per candle)
 *   - Hold all fills to settlement — no SL, no TP
 *   - Stop entering in last 30s of the candle (book thins out, fills become toxic)
 *
 * Expected behavior:
 *   - Most candles: zero fills, zero PnL
 *   - Occasional fills: ~95% lose $5, ~5% win $90
 *   - Long-run: small positive if PM mispriced extremes; small negative otherwise
 *   - Crucially: low variance, near-zero fees, near-zero toxic flow
 */
export class PureMakerEngine extends AbstractEngine {
  id = "pure-maker-v1";
  name = "Pure Maker Underdog";
  version = "1.0.0";

  private readonly maxEntryPrice = 0.10;
  private readonly orderSizeUsd = 5;
  private readonly maxOrdersPerCandle = 2;
  private readonly minSecondsRemaining = 30;
  private readonly minTicksBetweenOrders = 10;

  private lastMarketTokens = "";
  private candleOrders = 0;
  private ticksSinceLastOrder = 999;

  onTick(tick: MarketTick, _state: EngineState): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    // Reset per-candle counters when the active market changes
    const currentTokens = `${upTokenId}:${downTokenId}`;
    if (currentTokens !== this.lastMarketTokens) {
      this.candleOrders = 0;
      this.lastMarketTokens = currentTokens;
    }

    this.ticksSinceLastOrder++;

    if (this.candleOrders >= this.maxOrdersPerCandle) return [];
    if (this.ticksSinceLastOrder < this.minTicksBetweenOrders) return [];

    const secsLeft = this.getSecondsRemaining();
    if (secsLeft >= 0 && secsLeft < this.minSecondsRemaining) return [];

    // Pick the underdog side: whichever token's mid is below the threshold
    const upMid = tick.tokenSide === "UP" ? tick.midPrice : (1 - tick.midPrice);
    const downMid = 1 - upMid;

    let targetTokenId: string;
    let targetMid: number;
    let targetBestBid: number;

    if (upMid <= this.maxEntryPrice) {
      targetTokenId = upTokenId;
      targetMid = upMid;
      targetBestBid = tick.tokenSide === "UP" ? tick.bestBid : (1 - tick.bestAsk);
    } else if (downMid <= this.maxEntryPrice) {
      targetTokenId = downTokenId;
      targetMid = downMid;
      targetBestBid = tick.tokenSide === "DOWN" ? tick.bestBid : (1 - tick.bestAsk);
    } else {
      return [];
    }

    if (targetBestBid <= 0 || targetBestBid >= 1) return [];

    // One tick above best bid → sits at the front of the queue, still a maker
    const limitPrice = Math.min(targetBestBid + 0.001, this.maxEntryPrice);
    const shares = Math.floor(this.orderSizeUsd / limitPrice);
    if (shares < 5) return [];

    this.ticksSinceLastOrder = 0;
    this.candleOrders++;

    return [this.buy(targetTokenId, limitPrice, shares, {
      orderType: "maker",
      note: `PureMaker underdog @ ${(limitPrice * 100).toFixed(1)}¢ (mid ${(targetMid * 100).toFixed(1)}¢), hold to settle`,
      signalSource: "pure_maker_underdog",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.lastMarketTokens = "";
    this.candleOrders = 0;
    this.ticksSinceLastOrder = 999;
  }
}
