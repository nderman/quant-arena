import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * VWAP-style mean reversion on 4h candles.
 *
 * Wait until the candle is at least HALFWAY through. Compute a recent
 * average price (we use SMA of the last 30min as a VWAP proxy — the
 * Binance tracker doesn't store volume so true VWAP would require
 * additional infra). When current price has drifted >MIN_STDDEV away
 * from the SMA, bet on reversion to the mean by candle end.
 *
 * This is a classic equities mean-rev signal applied to crypto candle
 * markets where it's relatively underused. Works best on 4h horizon
 * because the mean has time to pull price back.
 *
 * Gates:
 *   - 4h arenas only
 *   - Candle progress > 50% (need real momentum to mean-rev FROM)
 *   - Need ≥ 1800s (30min) of Binance samples
 *   - Z-score |distance/stddev| > MIN_Z (default 1.5)
 *   - Alpha-zone entry [0.40, 0.70]
 */
export class VwapMeanRev4hEngine extends AbstractEngine {
  id = "vwap-mean-rev-4h-v1";
  name = "VWAP Mean Rev 4h";
  version = "1.0.0";

  private readonly minProgress =
    Number(process.env.VWAP_MIN_PROGRESS) || 0.50;
  private readonly minZ = Number(process.env.VWAP_MIN_Z) || 1.5;
  private readonly maxCashPct = 0.20;

  onTick(
    tick: MarketTick,
    state: EngineState,
    _signals?: SignalSnapshot,
  ): EngineAction[] {
    if (tick.source === "binance") this.trackBinance(tick);
    if (tick.source !== "polymarket") return [];

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

    // Candle progress gate
    const elapsed = Date.now() - this.getWindowStart();
    const dur = this.candleSeconds() * 1000;
    if (dur <= 0) return [];
    const progress = elapsed / dur;
    if (progress < this.minProgress) return [];

    // Need a recent SMA + price to compare. Use the BaseEngine binance buffer
    // by computing mean and stddev directly from `realizedVol` + current price
    // vs `recentMomentum` start price.
    const lookbackSec = 1800; // 30min
    const currentPrice = this.lastBinancePrice();
    if (currentPrice <= 0) return [];

    // Approximate "30-min VWAP" as: current price × (1 - recentMomentum(1800))
    // This recovers the price 30min ago. The midpoint between then and now
    // is our crude VWAP proxy. Real VWAP needs volume; this is a placeholder.
    const mom = this.recentMomentum(lookbackSec);
    if (mom === 0) return [];
    const priceThen = currentPrice / (1 + mom);
    const sma = (currentPrice + priceThen) / 2;
    const distance = currentPrice - sma;

    // Stddev from realizedVol over same window (proportional)
    const vol = this.realizedVol(lookbackSec);
    if (vol <= 0) return [];
    const stddevPrice = currentPrice * vol * Math.sqrt(lookbackSec); // crude
    if (stddevPrice <= 0) return [];
    const z = distance / stddevPrice;

    if (Math.abs(z) < this.minZ) return [];

    // Mean rev: if price is ABOVE mean (z > 0), bet DOWN. Below → UP.
    const buyUp = z < 0;
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
        note: `vwap-mean-rev-4h: ${buyUp ? "UP" : "DOWN"} @ ${ask.toFixed(3)} z=${z.toFixed(2)} progress=${(progress * 100).toFixed(0)}%`,
        signalSource: "vwap_mean_rev_4h",
      }),
    ];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
