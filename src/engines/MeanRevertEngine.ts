/**
 * Example Engine: Mean Reversion
 *
 * Strategy: When Polymarket price diverges from $0.50 by more than a threshold,
 * bet on reversion. Fee-aware — only enters when edge > parabolic fee.
 *
 * This is a reference implementation showing how to use the BaseEngine interface.
 */

import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

export class MeanRevertEngine extends AbstractEngine {
  id = "mean-revert-v1";
  name = "Mean Revert";
  version = "1.0.0";

  // Strategy params
  private readonly entryThreshold = 0.08;     // enter when |mid - 0.50| > 8%
  private readonly exitThreshold = 0.02;       // exit when |mid - 0.50| < 2%
  private readonly maxPositionPct = 0.10;      // max 10% of bankroll per trade
  private readonly minEdgeAfterFee = 0.005;    // 0.5% minimum net edge
  private get tokenId() { return this.state.activeTokenId || "SIM-YES"; }

  private entryPrice = 0;

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const mid = tick.midPrice;
    const deviation = mid - 0.50;
    const absDeviation = Math.abs(deviation);

    // ── Exit logic ──
    const pos = this.getPosition(this.tokenId);
    if (pos && pos.shares > 0) {
      // Check if we should exit via MERGE (cheaper at mid-prices)
      if (absDeviation < this.exitThreshold) {
        const exit = this.cheapestExit(mid, pos.shares);
        if (exit.method === "MERGE") {
          return [this.merge(this.tokenId, pos.shares, {
            note: `reversion complete, merge saves $${exit.savings.toFixed(4)}`,
            signalSource: "mean_revert_exit",
          })];
        }
        return [this.sell(this.tokenId, tick.bestBid, pos.shares, {
          note: "reversion complete",
          signalSource: "mean_revert_exit",
        })];
      }
      return [];
    }

    // ── Entry logic ──
    if (absDeviation < this.entryThreshold) return [];

    // Price is too high → model says it should revert down → buy NO (sell YES equiv)
    // Price is too low → model says it should revert up → buy YES
    const modelProb = 0.50; // mean reversion assumes fair value = 0.50
    const edge = this.feeAdjustedEdge(
      deviation > 0 ? 1 - modelProb : modelProb,  // buy the underpriced side
      deviation > 0 ? 1 - mid : mid,
    );

    if (!edge.profitable || edge.netEdge < this.minEdgeAfterFee) {
      return []; // fee eats the edge — skip
    }

    // Size: fraction of bankroll, capped
    const maxSize = state.cashBalance * this.maxPositionPct;
    const price = deviation > 0 ? (1 - mid) : mid;
    const shares = Math.floor(maxSize / price);
    if (shares < 5) return []; // min size filter (CLOB rejects < 5)

    this.entryPrice = price;

    return [this.buy(this.tokenId, tick.bestAsk, shares, {
      note: `mean revert entry: dev=${deviation.toFixed(3)}, edge=${edge.netEdge.toFixed(4)}`,
      signalSource: "mean_revert_entry",
    })];
  }

  onRoundEnd(state: EngineState): void {
    this.entryPrice = 0;
  }
}
