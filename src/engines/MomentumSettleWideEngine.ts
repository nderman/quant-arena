import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Momentum Settle — wide entry band variant.
 *
 * Same strategy as momentum-settle-v1 but accepts entries from 0.55-0.80
 * (vs 0.60-0.75). Hypothesis: less-volatile arenas (BTC, ETH) form clear
 * leaders earlier in the candle and rarely reach the tighter 0.60-0.75
 * window before the leader resolves. May 3 2026 cross-arena experiment
 * after sol-4h proven (70% WR, n=23).
 */
export class MomentumSettleWideEngine extends AbstractEngine {
  id = "momentum-settle-wide-v1";
  name = "Momentum Settle (wide)";
  version = "1.0.0";

  private readonly entryMin = 0.55;
  private readonly entryMax = 0.80;
  private readonly maxCashPct = 0.25;

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

    const edge = this.feeAdjustedEdge(0.72, askPrice);
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
        note: `momentum-settle-wide: taker ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)}, hold to settle`,
        signalSource: "momentum_settle_wide",
      })];
    }

    this.markPending(tokenId);
    return [this.buy(tokenId, makerPrice, shares, {
      orderType: "maker",
      note: `momentum-settle-wide: maker ${buyUp ? "UP" : "DOWN"} @ ${makerPrice.toFixed(3)}, hold to settle`,
      signalSource: "momentum_settle_wide",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
