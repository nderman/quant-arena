import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Momentum Settle — tight selectivity variant.
 *
 * Same strategy as momentum-settle-v1 but tighter band (0.65-0.72) and
 * higher edge threshold (0.78 prob model). Hypothesis: faster timeframes
 * (15m/1h) need stronger directional consensus before the leader is real;
 * tighter window filters out noise. May 3 2026 cross-arena experiment.
 */
export class MomentumSettleTightEngine extends AbstractEngine {
  id = "momentum-settle-tight-v1";
  name = "Momentum Settle (tight)";
  version = "1.0.0";

  private readonly entryMin = 0.65;
  private readonly entryMax = 0.72;
  private readonly maxCashPct = 0.20;
  private readonly probModel = 0.78;

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];

    this.clearStalePositions();

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    const upBook = getBookForToken(upTokenId);
    const downBook = getBookForToken(downTokenId);
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    const upLeading = upAsk >= this.entryMin && upAsk <= this.entryMax;
    const downLeading = downAsk >= this.entryMin && downAsk <= this.entryMax;
    if (!upLeading && !downLeading) return [];

    const buyUp = upLeading && (!downLeading || upAsk > downAsk);
    const tokenId = buyUp ? upTokenId : downTokenId;
    const askPrice = buyUp ? upAsk : downAsk;

    const edge = this.feeAdjustedEdge(this.probModel, askPrice);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / askPrice);
    if (shares < 5) return [];

    const makerPrice = Math.round((askPrice - 0.015) * 1000) / 1000;
    const makerBook = buyUp ? upBook : downBook;
    const bestAsk = makerBook.asks[0]?.price ?? 0;

    if (makerPrice >= bestAsk) {
      this.markPending(tokenId);
      return [this.buy(tokenId, askPrice, shares, {
        orderType: "taker",
        note: `momentum-settle-tight: taker ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)}, hold to settle`,
        signalSource: "momentum_settle_tight",
      })];
    }

    this.markPending(tokenId);
    return [this.buy(tokenId, makerPrice, shares, {
      orderType: "maker",
      note: `momentum-settle-tight: maker ${buyUp ? "UP" : "DOWN"} @ ${makerPrice.toFixed(3)}, hold to settle`,
      signalSource: "momentum_settle_tight",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
