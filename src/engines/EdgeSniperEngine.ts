/**
 * Example Engine: Edge Sniper
 *
 * Strategy: Only trades at the edges (price near 0 or 1) where parabolic fees
 * are lowest. Uses Binance momentum as the signal.
 *
 * This demonstrates the "trade at the edges" approach — the fee-optimal zone
 * where the P(1-P) tax is near zero.
 */

import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

export class EdgeSniperEngine extends AbstractEngine {
  id = "edge-sniper-v1";
  name = "Edge Sniper";
  version = "1.0.0";

  // Only trade when price is in the low-fee zone
  private readonly minDistanceFrom50 = 0.35;  // only trade when price > 0.85 or < 0.15
  private readonly momentumThreshold = 0.003;  // 0.3% Binance move triggers entry
  private readonly takeProfitPct = 0.03;       // 3% take profit
  private readonly maxPositionPct = 0.15;      // 15% of bankroll
  private get tokenId() { return this.state.activeTokenId || "SIM-YES"; }

  // Track Binance momentum
  private lastBinanceMid = 0;
  private binanceMomentum = 0;

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    // Update Binance momentum tracker
    if (tick.source === "binance") {
      if (this.lastBinanceMid > 0) {
        this.binanceMomentum = (tick.midPrice - this.lastBinanceMid) / this.lastBinanceMid;
      }
      this.lastBinanceMid = tick.midPrice;
      return [];
    }

    if (tick.source !== "polymarket") return [];

    const mid = tick.midPrice;

    // ── Only trade in low-fee zone ──
    if (tick.distanceFrom50 < this.minDistanceFrom50) return [];

    // ── Exit logic ──
    const pos = this.getPosition(this.tokenId);
    if (pos && pos.shares > 0) {
      const unrealizedPct = (mid - pos.avgEntry) / pos.avgEntry;
      if (unrealizedPct >= this.takeProfitPct) {
        // At edge prices, SELL is almost always cheaper than MERGE
        return [this.sell(this.tokenId, tick.bestBid, pos.shares, {
          note: `TP hit: ${(unrealizedPct * 100).toFixed(1)}%`,
          signalSource: "edge_sniper_tp",
        })];
      }
      return [];
    }

    // ── Entry: need Binance momentum signal ──
    const absMomentum = Math.abs(this.binanceMomentum);
    if (absMomentum < this.momentumThreshold) return [];

    // Momentum UP + price already high → buy YES (convergence play)
    // Momentum DOWN + price already low → buy NO
    const priceHigh = mid > 0.50;
    const momentumUp = this.binanceMomentum > 0;

    if (priceHigh && momentumUp) {
      // Check fee-adjusted edge: at P=0.90, fee is only 0.65% vs 1.8% at 0.50
      const edge = this.feeAdjustedEdge(mid + 0.02, mid); // expect 2% further push
      if (!edge.profitable) return [];

      const maxSize = state.cashBalance * this.maxPositionPct;
      const shares = Math.floor(maxSize / tick.bestAsk);
      if (shares < 5) return [];

      return [this.buy(this.tokenId, tick.bestAsk, shares, {
        note: `edge sniper: momentum=${(this.binanceMomentum * 100).toFixed(2)}%, fee=${(edge.feeAtPrice * 100).toFixed(2)}%`,
        signalSource: "binance_momentum",
      })];
    }

    return [];
  }

  onRoundEnd(_state: EngineState): void {
    this.lastBinanceMid = 0;
    this.binanceMomentum = 0;
  }
}
