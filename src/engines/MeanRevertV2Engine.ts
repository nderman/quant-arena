import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

export class MeanRevertV2Engine extends AbstractEngine {
  id = "mean-revert-v2";
  name = "Mean Revert v2";
  version = "2.0.0";

  private readonly entryThreshold = 0.08;
  private readonly exitThreshold = 0.02;
  private readonly maxPositionPct = 0.10;
  private readonly minEdgeAfterFee = 0.005;

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const mid = tick.midPrice;
    const deviation = mid - 0.50;
    const absDeviation = Math.abs(deviation);

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();

    // ── Exit logic: check both positions ──
    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    const hasPosition = (upPos && upPos.shares > 0) || (downPos && downPos.shares > 0);

    if (hasPosition) {
      if (absDeviation < this.exitThreshold) {
        const actions: EngineAction[] = [];
        if (upPos && upPos.shares > 0) {
          const exit = this.cheapestExit(mid, upPos.shares, upTokenId);
          if (exit.method === "MERGE") {
            actions.push(this.merge(upTokenId, upPos.shares, {
              note: `reversion complete (UP), merge saves $${exit.savings.toFixed(4)}`,
              signalSource: "mean_revert_exit",
            }));
          } else {
            actions.push(this.sell(upTokenId, tick.bestBid, upPos.shares, {
              note: "reversion complete (UP)",
              signalSource: "mean_revert_exit",
            }));
          }
        }
        if (downPos && downPos.shares > 0) {
          const downPrice = 1 - mid;
          const exit = this.cheapestExit(downPrice, downPos.shares, downTokenId);
          if (exit.method === "MERGE") {
            actions.push(this.merge(downTokenId, downPos.shares, {
              note: `reversion complete (DOWN), merge saves $${exit.savings.toFixed(4)}`,
              signalSource: "mean_revert_exit",
            }));
          } else {
            actions.push(this.sell(downTokenId, 1 - tick.bestAsk, downPos.shares, {
              note: "reversion complete (DOWN)",
              signalSource: "mean_revert_exit",
            }));
          }
        }
        return actions;
      }
      return [];
    }

    // ── Entry logic ──
    if (absDeviation < this.entryThreshold) return [];

    // Price high → buy DOWN (cheap side). Price low → buy UP (cheap side).
    const buyDown = deviation > 0;
    const tokenId = buyDown ? downTokenId : upTokenId;
    const price = buyDown ? (1 - mid) : mid;

    const edge = this.feeAdjustedEdge(0.50, price);
    if (!edge.profitable || edge.netEdge < this.minEdgeAfterFee) return [];

    const maxSize = state.cashBalance * this.maxPositionPct;
    const shares = Math.floor(maxSize / price);
    if (shares < 5) return [];

    const side = buyDown ? "DOWN" : "UP";
    const askPrice = buyDown ? (1 - tick.bestBid) : tick.bestAsk;

    return [this.buy(tokenId, askPrice, shares, {
      note: `mean revert ${side}: dev=${deviation.toFixed(3)}, price=${price.toFixed(3)}, edge=${edge.netEdge.toFixed(4)}`,
      signalSource: "mean_revert_entry",
    })];
  }

  onRoundEnd(_state: EngineState): void {}
}
