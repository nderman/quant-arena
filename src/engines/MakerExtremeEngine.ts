import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Maker limit buys at extreme prices (5-18¢), hold to settlement.
 * Bred engines proved the zone: +$80/+$61/+$59 from taker entries at 4-11¢.
 * This version uses maker orders for 0% fee + 20% rebate on fills.
 * Low frequency, asymmetric payoff: risk $10-15, win $40-90.
 */
export class MakerExtremeEngine extends AbstractEngine {
  id = "maker-extreme-v1";
  name = "Maker Extreme Settle";
  version = "1.0.0";

  private readonly entryMin = 0.05;
  private readonly entryMax = 0.18;
  private readonly maxCashPct = 0.30;
  private readonly maxEntriesPerCandle = 2;
  private entriesThisCandle = 0;
  private lastCandleKey = "";

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();
    const candleKey = `${upTokenId}:${downTokenId}`;
    if (candleKey !== this.lastCandleKey) {
      this.entriesThisCandle = 0;
      this.lastCandleKey = candleKey;
    }
    if (this.hasPendingOrder()) return [];
    if (this.entriesThisCandle >= this.maxEntriesPerCandle) return [];

    const upBook = getBookForToken(upTokenId);
    const downBook = getBookForToken(downTokenId);
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;

    const upExtreme = upAsk >= this.entryMin && upAsk <= this.entryMax;
    const downExtreme = downAsk >= this.entryMin && downAsk <= this.entryMax;
    if (!upExtreme && !downExtreme) return [];

    const buyUp = upExtreme && (!downExtreme || upAsk < downAsk);
    const tokenId = buyUp ? upTokenId : downTokenId;
    const askPrice = buyUp ? upAsk : downAsk;
    const book = buyUp ? upBook : downBook;

    const edge = this.feeAdjustedEdge(0.30, askPrice);
    if (!edge.profitable) return [];

    const perEntry = state.cashBalance * this.maxCashPct / this.maxEntriesPerCandle;
    const shares = Math.floor(perEntry / askPrice);
    if (shares < 5) return [];

    const bestAsk = book.asks[0]?.price ?? 0;
    const makerPrice = Math.round((askPrice - 0.003) * 1000) / 1000;

    this.entriesThisCandle++;
    this.markPending(tokenId);

    if (makerPrice >= bestAsk) {
      return [this.buy(tokenId, askPrice, shares, {
        orderType: "taker",
        note: `maker-extreme: taker fallback ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)}`,
        signalSource: "maker_extreme",
      })];
    }

    return [this.buy(tokenId, makerPrice, shares, {
      orderType: "maker",
      note: `maker-extreme: maker ${buyUp ? "UP" : "DOWN"} @ ${makerPrice.toFixed(3)}, hold to settle`,
      signalSource: "maker_extreme",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.entriesThisCandle = 0;
  }
}
