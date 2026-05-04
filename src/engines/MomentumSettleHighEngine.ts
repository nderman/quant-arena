import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Momentum Settle — high-conviction variant.
 *
 * Same strategy as momentum-settle-v1 but only fires when the leader is
 * 0.70-0.85 (vs 0.60-0.75). Hypothesis: stronger price = stronger
 * conviction = better win rate at the cost of fewer fires. Captures the
 * "late-candle confirmed leader" pattern that 4h candles often produce
 * after 30+ minutes of directional movement. May 3 2026 cross-arena
 * experiment after sol-4h proven (70% WR, n=23).
 */
export class MomentumSettleHighEngine extends AbstractEngine {
  id = "momentum-settle-high-v1";
  name = "Momentum Settle (high-conviction)";
  version = "1.0.0";

  private readonly entryMin = 0.70;
  private readonly entryMax = 0.85;
  private readonly maxCashPct = 0.20;
  private readonly probModel = 0.80;

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
        note: `momentum-settle-high: taker ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)}, hold to settle`,
        signalSource: "momentum_settle_high",
      })];
    }

    this.markPending(tokenId);
    return [this.buy(tokenId, makerPrice, shares, {
      orderType: "maker",
      note: `momentum-settle-high: maker ${buyUp ? "UP" : "DOWN"} @ ${makerPrice.toFixed(3)}, hold to settle`,
      signalSource: "momentum_settle_high",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
