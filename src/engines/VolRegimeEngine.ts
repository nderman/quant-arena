import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Vol Regime — conditional strategy that switches between mean revert and
 * momentum based on Binance realized volatility.
 *
 * Logic:
 *   - Track last ~60s of Binance mid prices, compute stddev of returns.
 *   - High vol (> threshold): candles resolve far from strike. Go with the
 *     current PM signal — whichever side is already above 0.60, buy it.
 *     (Momentum, bet the move continues.)
 *   - Low vol: candles mean-revert to 0.50. Buy whichever side is below 0.40
 *     cheap. (Mean revert, bet the move reverses.)
 *
 * Nothing in the current population conditions on the Binance vol regime —
 * mean-revert-v2 is always reverting, momentum-follower-v1 is always
 * chasing. This engine picks the right tool for the current regime.
 */
export class VolRegimeEngine extends AbstractEngine {
  id = "vol-regime-v1";
  name = "Vol Regime Switcher";
  version = "1.0.0";

  // Realized-vol threshold (stddev of pct returns). >0.0005 = ~5bps/tick = high vol
  private readonly highVolThreshold = 0.0005;
  // Entry price gates
  private readonly momentumEntryMin = 0.60;
  private readonly momentumEntryMax = 0.85; // above this, fees are fine but edge is thin
  private readonly revertEntryMax = 0.40;
  private readonly revertEntryMin = 0.15;
  // Sizing
  private readonly maxCashPct = 0.25;

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    // Feed the shared AbstractEngine Binance buffer
    this.trackBinance(tick);

    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];

    // Need enough history to compute vol
    // Don't re-enter if already holding either side
    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    // Realized vol from the shared Binance buffer (last 60s)
    const realizedVol = this.realizedVol(60);
    if (realizedVol === 0) return []; // insufficient data

    const upBook = getBookForToken(upTokenId);
    const downBook = getBookForToken(downTokenId);
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    const highVol = realizedVol > this.highVolThreshold;

    // ── Regime: HIGH VOL → momentum (buy the side already winning) ──
    if (highVol) {
      const upLeading = upAsk > this.momentumEntryMin && upAsk < this.momentumEntryMax;
      const downLeading = downAsk > this.momentumEntryMin && downAsk < this.momentumEntryMax;
      if (!upLeading && !downLeading) return [];

      // If both are in range (rare), pick the more aggressive one
      const buyUp = upLeading && (!downLeading || upAsk > downAsk);
      const tokenId = buyUp ? upTokenId : downTokenId;
      const askPrice = buyUp ? upAsk : downAsk;

      // Model prob = 70% if we're in momentum regime with confirmed move
      const edge = this.feeAdjustedEdge(0.70, askPrice);
      if (!edge.profitable) return [];

      const shares = Math.floor((state.cashBalance * this.maxCashPct) / askPrice);
      if (shares < 5) return [];

      this.markPending(tokenId);
      return [this.buy(tokenId, askPrice, shares, {
        orderType: "taker",
        note: `momentum: vol=${(realizedVol * 10000).toFixed(1)}bps, ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)}`,
        signalSource: "vol_regime_momentum",
      })];
    }

    // ── Regime: LOW VOL → mean revert (buy the cheap side, bet on reversion) ──
    const upCheap = upAsk >= this.revertEntryMin && upAsk <= this.revertEntryMax;
    const downCheap = downAsk >= this.revertEntryMin && downAsk <= this.revertEntryMax;
    if (!upCheap && !downCheap) return [];

    const buyUp = upCheap && (!downCheap || upAsk < downAsk);
    const tokenId = buyUp ? upTokenId : downTokenId;
    const askPrice = buyUp ? upAsk : downAsk;

    // Model prob = 50% in low-vol regime (true coin flip, but cheap side gives leverage)
    const edge = this.feeAdjustedEdge(0.50, askPrice);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / askPrice);
    if (shares < 5) return [];

    this.markPending(tokenId);
    return [this.buy(tokenId, askPrice, shares, {
      orderType: "taker",
      note: `revert: vol=${(realizedVol * 10000).toFixed(1)}bps, ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)}`,
      signalSource: "vol_regime_revert",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
