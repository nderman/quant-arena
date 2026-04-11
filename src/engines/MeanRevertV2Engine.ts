import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

export class MeanRevertV2Engine extends AbstractEngine {
  id = "mean-revert-v2";
  name = "Mean Revert v2";
  version = "2.0.0";

  private readonly entryThreshold = 0.08;
  private readonly exitThreshold = 0.02;
  private readonly maxPositionPct = 0.10;
  private readonly minEdgeAfterFee = 0.005;

  // In-flight BUY tracking. Prevents the round-start race where the referee's
  // 50ms fill latency causes onTick to fire ~10 times before the first fill
  // updates state.positions, leading to cash-exhausting pyramiding. Cleared
  // when we observe the position landed, or on round boundaries.
  private pendingTokens = new Set<string>();
  private lastMarketKey = "";

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    // Reset pending set on market rotation (new 5m candle = new tokens).
    const marketKey = `${upTokenId}:${downTokenId}`;
    if (marketKey !== this.lastMarketKey) {
      this.pendingTokens.clear();
      this.lastMarketKey = marketKey;
    }

    // Clear pending for any token where the fill has now landed.
    for (const pendingId of [...this.pendingTokens]) {
      const pos = this.getPosition(pendingId);
      if (pos && pos.shares > 0) this.pendingTokens.delete(pendingId);
    }

    // Read BOTH books directly. Never derive one side's price from the other
    // via 1-x — UP and DOWN have independent dual orderbooks.
    const upBook = getBookForToken(upTokenId);
    const downBook = getBookForToken(downTokenId);
    const upBestBid = upBook.bids[0]?.price ?? 0;
    const upBestAsk = upBook.asks[0]?.price ?? 0;
    const downBestBid = downBook.bids[0]?.price ?? 0;
    const downBestAsk = downBook.asks[0]?.price ?? 0;
    if (upBestAsk <= 0 || downBestAsk <= 0) return [];

    // Use UP token's mid as the "market mid" reference for the mean-reversion
    // deviation calculation (same semantic as before — UP price represents
    // probability UP wins, deviation from 0.50 = how far from coin-flip).
    const upMid = (upBestBid + upBestAsk) / 2;
    const deviation = upMid - 0.50;
    const absDeviation = Math.abs(deviation);

    // If a BUY is in flight (submitted but referee hasn't filled yet), wait
    // for it to resolve before doing anything else. Prevents the pyramiding
    // race on round start where onTick fires ~10× before positions update.
    if (this.pendingTokens.size > 0) return [];

    // ── Exit logic: check both positions ──
    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    const hasPosition = (upPos && upPos.shares > 0) || (downPos && downPos.shares > 0);

    if (hasPosition) {
      if (absDeviation < this.exitThreshold) {
        const actions: EngineAction[] = [];
        if (upPos && upPos.shares > 0) {
          const exit = this.cheapestExit(upMid, upPos.shares, upTokenId);
          if (exit.method === "MERGE") {
            actions.push(this.merge(upTokenId, upPos.shares, {
              note: `reversion complete (UP), merge saves $${exit.savings.toFixed(4)}`,
              signalSource: "mean_revert_exit",
            }));
          } else {
            actions.push(this.sell(upTokenId, upBestBid, upPos.shares, {
              note: "reversion complete (UP)",
              signalSource: "mean_revert_exit",
            }));
          }
        }
        if (downPos && downPos.shares > 0) {
          const downMid = (downBestBid + downBestAsk) / 2;
          const exit = this.cheapestExit(downMid, downPos.shares, downTokenId);
          if (exit.method === "MERGE") {
            actions.push(this.merge(downTokenId, downPos.shares, {
              note: `reversion complete (DOWN), merge saves $${exit.savings.toFixed(4)}`,
              signalSource: "mean_revert_exit",
            }));
          } else {
            actions.push(this.sell(downTokenId, downBestBid, downPos.shares, {
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
    // Use each token's OWN best ask — not a 1-x derivation from the other side.
    const askPrice = buyDown ? downBestAsk : upBestAsk;

    const edge = this.feeAdjustedEdge(0.50, askPrice);
    if (!edge.profitable || edge.netEdge < this.minEdgeAfterFee) return [];

    const maxSize = state.cashBalance * this.maxPositionPct;
    const shares = Math.floor(maxSize / askPrice);
    if (shares < 5) return [];

    const side = buyDown ? "DOWN" : "UP";

    // Mark token as having an in-flight BUY. Cleared next tick once the
    // position appears in state.positions (fill completed), or on rotation.
    this.pendingTokens.add(tokenId);

    return [this.buy(tokenId, askPrice, shares, {
      note: `mean revert ${side}: dev=${deviation.toFixed(3)}, ask=${askPrice.toFixed(3)}, edge=${edge.netEdge.toFixed(4)}`,
      signalSource: "mean_revert_entry",
    })];
  }

  onRoundEnd(_state: EngineState): void {}
}
