import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Buy the leading side at 60-75¢ and hold to settlement.
 * Discovered empirically: vol-regime-v1 accidentally ran as pure momentum
 * (broken vol calc) and hit 81% settlement WR on ETH at 61-68¢ entries.
 * This engine formalizes that signal with maker orders for better economics.
 */
export class MomentumSettleEngine extends AbstractEngine {
  id = "momentum-settle-v1";
  name = "Momentum Settle";
  version = "1.0.0";

  private readonly entryMin = 0.60;
  private readonly entryMax = 0.75;
  private readonly maxCashPct = 0.25;
  private pendingTokens = new Set<string>();
  private lastMarketKey = "";

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    const marketKey = `${upTokenId}:${downTokenId}`;
    if (marketKey !== this.lastMarketKey) {
      this.pendingTokens.clear();
      this.lastMarketKey = marketKey;
    }
    for (const t of [...this.pendingTokens]) {
      const pos = this.getPosition(t);
      if (pos && pos.shares > 0) this.pendingTokens.delete(t);
    }
    if (this.pendingTokens.size > 0) return [];

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

    // Maker limit just below ask for 0% fee + 20% rebate
    const makerPrice = Math.round((askPrice - 0.005) * 1000) / 1000;
    const makerBook = buyUp ? upBook : downBook;
    const bestAsk = makerBook.asks[0]?.price ?? 0;

    if (makerPrice >= bestAsk) {
      // Would cross spread — fall back to taker
      this.pendingTokens.add(tokenId);
      return [this.buy(tokenId, askPrice, shares, {
        orderType: "taker",
        note: `momentum-settle: taker ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)}, hold to settle`,
        signalSource: "momentum_settle",
      })];
    }

    this.pendingTokens.add(tokenId);
    return [this.buy(tokenId, makerPrice, shares, {
      orderType: "maker",
      note: `momentum-settle: maker ${buyUp ? "UP" : "DOWN"} @ ${makerPrice.toFixed(3)}, hold to settle`,
      signalSource: "momentum_settle",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.pendingTokens.clear();
    this.lastMarketKey = "";
  }
}
