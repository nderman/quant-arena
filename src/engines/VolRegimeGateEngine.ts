import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Uses Binance realizedVol across two horizons (5m vs 1h) to detect vol
 * regime. The ratio is the signal, not the absolute level — normalized
 * across different coins and epochs.
 *
 * Thesis:
 *   ratio = vol5m / vol1h
 *   ratio > 1.5: vol EXPANDING (5m is running hot) → directional moves are
 *     real → ride momentum, enter the leading side near 60-75¢
 *   ratio < 0.5: vol COMPRESSING → pullback likely → fade the recent leader
 *     (buy the 25-40¢ side as contra)
 *   0.5-1.5: normal, no signal
 *
 * Teaches the breeder to compare two horizons of the same signal rather
 * than reading one value.
 */
export class VolRegimeGateEngine extends AbstractEngine {
  id = "vol-regime-gate-v1";
  name = "Vol Regime Gate";
  version = "1.0.0";

  private readonly expandThreshold = 1.3;   // was 1.5 — never fired in normal markets
  private readonly compressThreshold = 0.6; // was 0.5
  private readonly maxCashPct = 0.15;

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];
    if (!signals?.realizedVol) return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    const vol5m = signals.realizedVol.vol5m;
    const vol1h = signals.realizedVol.vol1h;
    if (!vol5m || !vol1h) return [];

    const ratio = vol5m / vol1h;
    const mode: "EXPAND" | "COMPRESS" | null =
      ratio > this.expandThreshold ? "EXPAND" :
      ratio < this.compressThreshold ? "COMPRESS" :
      null;
    if (!mode) return [];

    // Read both books; pick the candidate side based on mode.
    const upBook = this.getBookForToken(upTokenId);
    const downBook = this.getBookForToken(downTokenId);
    if (!this.isBookTradeable(upBook) || !this.isBookTradeable(downBook)) return [];
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;

    let tokenId = "";
    let askPrice = 0;
    if (mode === "EXPAND") {
      // Ride the leader — whichever side has the higher ask in 0.60-0.75
      const upLeading = upAsk >= 0.60 && upAsk <= 0.75;
      const downLeading = downAsk >= 0.60 && downAsk <= 0.75;
      if (!upLeading && !downLeading) return [];
      if (upLeading && (!downLeading || upAsk > downAsk)) {
        tokenId = upTokenId; askPrice = upAsk;
      } else {
        tokenId = downTokenId; askPrice = downAsk;
      }
    } else {
      // COMPRESS: fade the leader by buying the underdog at 0.25-0.40
      const upUnder = upAsk >= 0.25 && upAsk <= 0.40;
      const downUnder = downAsk >= 0.25 && downAsk <= 0.40;
      if (!upUnder && !downUnder) return [];
      if (upUnder && (!downUnder || upAsk < downAsk)) {
        tokenId = upTokenId; askPrice = upAsk;
      } else {
        tokenId = downTokenId; askPrice = downAsk;
      }
    }

    const modelProb = mode === "EXPAND" ? 0.70 : 0.55;
    const edge = this.feeAdjustedEdge(modelProb, askPrice);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / askPrice);
    if (shares < 5) return [];

    this.markPending(tokenId);
    return [this.buy(tokenId, askPrice, shares, {
      orderType: "taker",
      note: `vol-regime: ${mode} ratio=${ratio.toFixed(2)} @ ${askPrice.toFixed(3)}`,
      signalSource: "vol_regime",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
