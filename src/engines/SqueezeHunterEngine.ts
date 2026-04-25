import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * SqueezeHunterEngine-v1
 *
 * Thesis: Identifies "squeeze" opportunities where Binance perp funding is
 * heavily biased AGAINST the current local price trend — the crowd is
 * positioned wrong and getting forced to cover. Authored by Gemini, fixed
 * by human review (currentRegimeStable was returning bool used as string).
 *
 * Logic:
 *  - Funding < -0.02% (shorts paying — crowded short) AND price trending UP → buy UP
 *  - Funding > +0.02% (longs paying — crowded long) AND price trending DOWN → buy DOWN
 *  - Only fire in TREND regime (squeezes don't happen in CHOP/QUIET)
 *  - Maker order 2 ticks below ask: 0% fee + 20% rebate, fills when desperate
 *    takers cross
 *  - Mid-price band (20-80¢) where the rebate is most valuable vs spread
 */
export class SqueezeHunterEngine extends AbstractEngine {
  id = "squeeze-hunter-v1";
  name = "Short Squeeze Sniper";
  version = "1.0.0";

  private readonly FUNDING_THRESHOLD = 0.0002;  // 0.02% — significant crowding
  private readonly MIN_IMBALANCE = 0.25;
  private readonly TICK_SIZE = 0.01;

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();
    if (this.hasPendingOrder() || this.hasPosition(upTokenId) || this.hasPosition(downTokenId)) {
      return [];
    }

    // Read signals
    this.trackBinance(tick);
    const regime = this.currentRegime(60);  // returns regime label string
    const fundingRate = signals?.funding?.rate ?? 0;
    const binanceMom = this.recentMomentum(60);

    // Gate: only fire in TREND. Squeezes happen when price moves AGAINST
    // the crowded position — needs sustained directional pressure.
    if (regime !== "TREND") return [];

    // Identify divergence between funding and price action
    let targetTokenId: string | null = null;
    let reason = "";

    // Short squeeze: shorts paying (negative funding) + price climbing
    if (fundingRate < -this.FUNDING_THRESHOLD && binanceMom > 1.002) {
      targetTokenId = upTokenId;
      reason = `short_squeeze fund=${fundingRate.toFixed(5)} mom=${binanceMom.toFixed(4)}`;
    }
    // Long liquidation: longs paying (positive funding) + price falling
    else if (fundingRate > this.FUNDING_THRESHOLD && binanceMom < 0.998) {
      targetTokenId = downTokenId;
      reason = `long_liq fund=${fundingRate.toFixed(5)} mom=${binanceMom.toFixed(4)}`;
    }

    if (!targetTokenId) return [];

    // Book micro-confirmation
    const book = this.getBookForToken(targetTokenId);
    if (!this.isBookTradeable(book)) return [];

    const imbalance = this.bookImbalance(targetTokenId, 3);
    if (imbalance < this.MIN_IMBALANCE) return [];

    const bestAsk = book.asks[0]?.price ?? 0;
    if (bestAsk <= 0) return [];

    // Maker price 2 ticks below ask — captures fill from desperate takers
    const makerPrice = Math.round((bestAsk - this.TICK_SIZE * 2) * 100) / 100;
    if (makerPrice < 0.20 || makerPrice > 0.80) return [];

    // Edge gate
    const edge = this.feeAdjustedEdge(0.65, makerPrice);
    if (!edge.profitable) return [];

    // Sizing: ~25% cash with 5-25 share band
    const sharesAffordable = Math.floor((state.cashBalance * 0.25) / makerPrice);
    const size = Math.max(5, Math.min(sharesAffordable, 25));
    if (size < 5) return [];

    this.markPending(targetTokenId);
    return [
      this.buy(targetTokenId, makerPrice, size, {
        orderType: "maker",
        note: `${reason} imb=${imbalance.toFixed(2)}`,
        signalSource: "squeeze_hunter",
      }),
    ];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
