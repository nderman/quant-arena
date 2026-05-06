import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * FundingImbalanceComboEngine
 *
 * Thesis: when futures funding rate disagrees with PM book imbalance,
 * the PM market is taking the contrarian view. Funding moves on 8h
 * cycles (much faster than F&G's daily cadence) so this fires more
 * reliably than signal-contrarian-v1.
 *
 * Specifically:
 *  - Funding > +0.0002 (longs paying — futures crowd is bullish-positioned)
 *    AND PM UP-token bookImbalance > 0.4 (PM also leaning bullish)
 *    → both agreeing means we FADE: buy DOWN underdog
 *  - Funding < -0.0002 AND PM DOWN-token bookImbalance > 0.4
 *    → both agreeing bearishly → buy UP underdog
 *
 * Why agreement = fade: when futures sentiment AND PM order flow both
 * point the same way, the consensus is overcrowded. Bet against the
 * agreement, take the underdog at 25-40¢.
 *
 * Differs from signal-contrarian-v1: that engine uses F&G+funding as
 * macro gates with imbalance as a secondary check. This explicitly
 * REQUIRES funding-imbalance AGREEMENT and fades it.
 */
export class FundingImbalanceComboEngine extends AbstractEngine {
  id = "funding-imbalance-combo-v1";
  name = "Funding-Imbalance Combo (fade agreement)";
  version = "1.0.0";

  private readonly fundingThreshold = 0.0002;
  private readonly imbalanceThreshold = 0.4;
  private readonly underdogMin = 0.25;
  private readonly underdogMax = 0.45;
  private readonly maxCashPct = 0.15;

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];
    if (!signals?.funding) return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    const fundingRate = signals.funding.rate;
    if (Math.abs(fundingRate) < this.fundingThreshold) return [];

    const upImbalance = this.bookImbalance(upTokenId, 3);
    const downImbalance = this.bookImbalance(downTokenId, 3);

    // Detect funding+imbalance agreement (both bullish or both bearish)
    let fadeSide: "UP" | "DOWN" | null = null;
    if (fundingRate > this.fundingThreshold && upImbalance > this.imbalanceThreshold) {
      // Both bullish → fade by buying DOWN underdog
      fadeSide = "DOWN";
    } else if (fundingRate < -this.fundingThreshold && downImbalance > this.imbalanceThreshold) {
      // Both bearish → fade by buying UP underdog
      fadeSide = "UP";
    }
    if (!fadeSide) return [];

    const tokenId = fadeSide === "UP" ? upTokenId : downTokenId;
    const book = this.getBookForToken(tokenId);
    if (!this.isBookTradeable(book)) return [];
    const askPrice = book.asks[0]?.price ?? 0;
    if (askPrice < this.underdogMin || askPrice > this.underdogMax) return [];

    // Underdog fade: 60% conviction (they're at 30¢, payout 70¢ if right)
    const edge = this.feeAdjustedEdge(0.60, askPrice);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / askPrice);
    if (shares < 5) return [];

    this.markPending(tokenId);
    return [this.buy(tokenId, askPrice, shares, {
      orderType: "taker",
      note: `fund-imb-fade: ${fadeSide} fund=${fundingRate.toFixed(5)} imb=${(fadeSide === "UP" ? downImbalance : upImbalance).toFixed(2)} @${askPrice.toFixed(3)}`,
      signalSource: "funding_imbalance_combo",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
