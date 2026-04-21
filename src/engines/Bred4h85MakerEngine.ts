import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * bred-4h85-maker — clone of bred-4h85 with a price floor and all-maker orders.
 *
 * bred-4h85 dominates the sim (+$5k lifetime) buying 5-18¢ underdogs.
 * But live PM proved 5-10¢ taker fills are unfillable on winning candles.
 * This variant keeps the exact same DCA/pyramid/toxic-flow logic but:
 *   - Raises min entry from 5¢ to 15¢ (avoids front-run zone)
 *   - Raises max entry to 30¢ (wider band for more opportunity)
 *   - Forces 100% maker orders (GTC limit, 0% fee + rebate)
 *   - Posts 3 ticks below bestAsk (sits on book, fills come to us)
 *
 * All the "weird broken shit" is preserved: single-book DOWN price
 * inversion, modelProb = price + 0.03, toxic flow acceleration,
 * candleEntries without hasPendingOrder guard.
 */
export class Bred4h85MakerEngine extends AbstractEngine {
  id = "bred-4h85-maker-v1";
  name = "DCA Settler Pro (Maker)";
  version = "1.0.0";

  private readonly minEntryPrice = 0.15;
  private readonly maxEntryPrice = 0.30;
  private readonly dcaStepSize = 5;
  private readonly maxEntriesPerCandle = 4;
  private readonly spreadTicks = 3;

  private readonly dcaAccelerationOnToxic = true;

  private lastMarketKey = "";
  private candleEntries = 0;
  private candleToxicFlowCount = 0;
  private lastBinanceMid = 0;
  private volatilityEstimate = 0;

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    if (tick.source === "binance") {
      if (this.lastBinanceMid > 0) {
        const pctMove = Math.abs((tick.midPrice - this.lastBinanceMid) / this.lastBinanceMid);
        this.volatilityEstimate = this.volatilityEstimate * 0.7 + pctMove * 0.3;
      }
      this.lastBinanceMid = tick.midPrice;
      return [];
    }

    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    const marketKey = `${upTokenId}:${downTokenId}`;

    if (marketKey !== this.lastMarketKey) {
      this.candleEntries = 0;
      this.candleToxicFlowCount = 0;
      this.lastMarketKey = marketKey;
    }

    const secsRemaining = this.getSecondsRemaining();
    if (secsRemaining >= 0 && secsRemaining < 15) return [];

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    const holdingBoth = (upPos && upPos.shares > 0) && (downPos && downPos.shares > 0);
    if (holdingBoth) return [];

    const upPrice = tick.midPrice;
    const downPrice = 1 - upPrice;

    const extremeUp = upPrice >= this.minEntryPrice && upPrice <= this.maxEntryPrice;
    const extremeDown = downPrice >= this.minEntryPrice && downPrice <= this.maxEntryPrice;

    if (!extremeUp && !extremeDown) return [];

    if (this.candleEntries >= this.maxEntriesPerCandle) return [];

    const shouldAccelerate = this.dcaAccelerationOnToxic && this.candleToxicFlowCount > 0;
    const entryLimit = shouldAccelerate ? this.maxEntriesPerCandle + 1 : this.maxEntriesPerCandle;
    if (this.candleEntries >= entryLimit) return [];

    if (extremeUp && !(upPos && upPos.shares > 0)) {
      const modelProb = upPrice + 0.03;
      const edge = this.feeAdjustedEdge(modelProb, upPrice);

      if (edge.profitable) {
        this.candleEntries++;
        const book = this.getBookForToken(upTokenId);
        const bestAsk = book.asks[0]?.price ?? 0;
        if (bestAsk <= 0) return [];
        const limitPrice = bestAsk - this.spreadTicks * 0.001;
        if (limitPrice <= 0.01 || limitPrice >= bestAsk) return [];
        const size = Math.floor(this.dcaStepSize / limitPrice);
        if (size >= 5) {
          return [this.buy(upTokenId, limitPrice, size, {
            orderType: "maker",
            note: `DCA-M UP ${(upPrice * 100).toFixed(1)}% (entry #${this.candleEntries}): maker limit ${limitPrice.toFixed(3)}`,
            signalSource: "bred_4h85_maker",
          })];
        }
      }
    }

    if (extremeDown && !(downPos && downPos.shares > 0)) {
      const modelProb = downPrice + 0.03;
      const edge = this.feeAdjustedEdge(modelProb, downPrice);

      if (edge.profitable) {
        this.candleEntries++;
        const book = this.getBookForToken(downTokenId);
        const bestAsk = book.asks[0]?.price ?? 0;
        if (bestAsk <= 0) return [];
        const limitPrice = bestAsk - this.spreadTicks * 0.001;
        if (limitPrice <= 0.01 || limitPrice >= bestAsk) return [];
        const size = Math.floor(this.dcaStepSize / limitPrice);
        if (size >= 5) {
          return [this.buy(downTokenId, limitPrice, size, {
            orderType: "maker",
            note: `DCA-M DOWN ${(downPrice * 100).toFixed(1)}% (entry #${this.candleEntries}): maker limit ${limitPrice.toFixed(3)}`,
            signalSource: "bred_4h85_maker",
          })];
        }
      }
    }

    return [];
  }

  onRoundEnd(_state: EngineState): void {
    this.lastMarketKey = "";
    this.candleEntries = 0;
    this.candleToxicFlowCount = 0;
    this.lastBinanceMid = 0;
    this.volatilityEstimate = 0;
  }
}
