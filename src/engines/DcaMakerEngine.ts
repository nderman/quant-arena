import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * dca-maker-v1 — maker-only extreme underdog DCA.
 *
 * Same price band as dca-extreme-v1 (5-18¢) but uses maker orders only:
 * 0% fee + 20% rebate of taker fees that match against our orders.
 *
 * Hypothesis: at extreme prices the quartic fee is already tiny (~0.05%
 * at 10¢), but the maker rebate becomes a free 20% edge on any fills.
 * Tradeoff: maker fills have only 12% fill probability in the sim, so
 * we get far fewer entries per candle. Question: does the higher edge
 * per fill compensate for the lower frequency?
 *
 * Places limit just below current ask (3 ticks down) to stay post-only
 * but increase fill probability over setting the limit at the spread midpoint.
 */
export class DcaMakerEngine extends AbstractEngine {
  id = "dca-maker-v1";
  name = "DCA Maker Extreme";
  version = "1.0.0";

  private readonly minEntryPrice = 0.05;
  private readonly maxEntryPrice = 0.18;
  private readonly dcaStepSize = 5;
  private readonly maxEntriesPerCandle = 4;
  private readonly settlementBufferSec = 15;
  private readonly makerPriceOffset = 0.003; // 3 ticks below current ask

  private candleEntries = 0;
  private lastCandleKey = "";

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    this.trackBinance(tick);
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();

    const candleKey = `${upTokenId}:${downTokenId}`;
    if (candleKey !== this.lastCandleKey) {
      this.candleEntries = 0;
      this.lastCandleKey = candleKey;
    }

    const secsRemaining = this.getSecondsRemaining();
    if (secsRemaining >= 0 && secsRemaining < this.settlementBufferSec) return [];

    if (this.hasPendingOrder()) return [];
    if (this.candleEntries >= this.maxEntriesPerCandle) return [];

    const upBook = getBookForToken(upTokenId);
    const downBook = getBookForToken(downTokenId);
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    const upCheap = upAsk >= this.minEntryPrice && upAsk <= this.maxEntryPrice;
    const downCheap = downAsk >= this.minEntryPrice && downAsk <= this.maxEntryPrice;
    if (!upCheap && !downCheap) return [];

    const buyUp = upCheap && (!downCheap || upAsk < downAsk);
    const tokenId = buyUp ? upTokenId : downTokenId;
    const askPrice = buyUp ? upAsk : downAsk;
    const book = buyUp ? upBook : downBook;

    const existing = this.getPosition(tokenId);
    if (existing && existing.shares > 0) return [];

    // Maker limit 3 ticks below current ask. Needs to stay below bestAsk
    // for post-only acceptance; setting ask - 0.003 = ~3 ticks on 0.001
    // tick size. If the limit would cross (bid ≥ limit), bump above bid+1tick.
    const bestBid = book.bids[0]?.price ?? 0;
    let makerLimit = Math.round((askPrice - this.makerPriceOffset) * 1000) / 1000;
    if (makerLimit <= bestBid) makerLimit = Math.round((bestBid + 0.001) * 1000) / 1000;
    if (makerLimit >= askPrice) return []; // can't improve, skip

    // Edge check at the maker fill price (lower than taker)
    const modelProb = makerLimit + 0.02;
    const edge = this.feeAdjustedEdge(modelProb, makerLimit);
    if (!edge.profitable) return [];

    const size = Math.floor(this.dcaStepSize / makerLimit);
    if (size < 5) return [];

    this.candleEntries++;
    this.markPending(tokenId);

    return [this.buy(tokenId, makerLimit, size, {
      orderType: "maker",
      note: `dca-maker: ${buyUp ? "UP" : "DOWN"} @ ${makerLimit.toFixed(3)} #${this.candleEntries}`,
      signalSource: "dca_maker",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.candleEntries = 0;
    this.lastCandleKey = "";
  }
}
