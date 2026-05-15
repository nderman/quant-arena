import { AbstractEngine } from "./BaseEngine";
import { startPolling, getFundingAnnualizedBps } from "../live/binanceFunding";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Funding-rate fader — uses Binance perp funding as a sentiment-extreme
 * signal and bets the FADE direction on 4h candles.
 *
 * Funding rate = cost longs pay shorts (or vice versa) every 8h on perps.
 * Annualized:
 *   - > +50 bps:  longs are crowded paying heavily → expect mean rev DOWN
 *   - < -30 bps:  shorts are crowded → expect mean rev UP
 *
 * Crowded sentiment historically reverses on 4-12h horizons. 4h candles
 * are the sweet spot — long enough for the unwind to play out, short
 * enough to avoid waiting for new sentiment to form.
 *
 * Gates:
 *   - 4h arenas only
 *   - Funding extreme: |annualized bps| > MIN_EXTREME_BPS (default 50)
 *   - Alpha-zone entry [0.40, 0.70]
 *   - Need ≥ 2h remaining (let unwind develop)
 */
export class FundingRateFaderEngine extends AbstractEngine {
  id = "funding-rate-fader-v1";
  name = "Funding Rate Fader";
  version = "1.0.0";

  private readonly minExtremeBps =
    Number(process.env.FUNDING_MIN_EXTREME_BPS) || 50;
  private readonly minRemainingSec =
    Number(process.env.FUNDING_MIN_REMAINING_SEC) || 7200;
  private readonly maxCashPct = 0.20;
  private startedPolling = false;

  onTick(
    tick: MarketTick,
    state: EngineState,
    _signals?: SignalSnapshot,
  ): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    if (!this.startedPolling) {
      startPolling();
      this.startedPolling = true;
    }

    if (this.candleSeconds() !== 14400) return [];

    this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];
    this.clearStalePositions();

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    const remaining = this.getSecondsRemaining();
    if (remaining < this.minRemainingSec) return [];

    const symbol = this.getMarketSymbol();
    if (!symbol) return [];
    const fundingBps = getFundingAnnualizedBps(symbol);
    if (fundingBps === null) return [];
    if (Math.abs(fundingBps) < this.minExtremeBps) return [];

    // Fade: positive funding (crowded long) → bet DOWN. Negative → UP.
    const buyUp = fundingBps < 0;
    const tokenId = buyUp ? upTokenId : downTokenId;
    const book = this.getBookForToken(tokenId);
    if (!this.isBookTradeable(book)) return [];
    const ask = book.asks[0]?.price ?? 0;
    if (ask < 0.40 || ask > 0.70) return [];

    const edge = this.feeAdjustedEdge(0.60, ask);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / ask);
    if (shares < 5) return [];

    this.markPending(tokenId);
    return [
      this.buy(tokenId, ask, shares, {
        orderType: "taker",
        note: `funding-fader: ${buyUp ? "UP" : "DOWN"} @ ${ask.toFixed(3)} funding=${fundingBps.toFixed(0)}bps annualized`,
        signalSource: "funding_rate_fader",
      }),
    ];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
