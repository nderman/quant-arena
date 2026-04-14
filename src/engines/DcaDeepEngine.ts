import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * dca-deep-v1 — ultra-extreme underdog variant of dca-extreme.
 *
 * Price band: 2-8¢ (vs dca-extreme 5-18¢, dca-extreme-wide 5-28¢).
 *
 * Hypothesis: the asymmetric-payoff edge in bred-4h85 comes from buying
 * underdogs so cheap that even a low hit rate wins. At 5¢ entry, a win
 * pays 19× and you need >5% WR to break even. At 2¢ entry, you need >2%.
 * Real 5M settlements rarely come through at <10¢ implied probability,
 * so this engine fires less often but each fill has more upside.
 *
 * Tradeoff: many candles will never show a 2-8¢ price on either side
 * (especially early in a candle before the book has moved). Expect
 * lower frequency than dca-extreme.
 *
 * A/B partner for dca-extreme-v1 (5-18¢) and dca-extreme-wide-v1 (5-28¢).
 */
export class DcaDeepEngine extends AbstractEngine {
  id = "dca-deep-v1";
  name = "DCA Deep Extremes";
  version = "1.0.0";

  private readonly minEntryPrice = 0.02;
  private readonly maxEntryPrice = 0.08;
  private readonly dcaStepSize = 5;
  private readonly maxEntriesPerCandle = 4;
  private readonly settlementBufferSec = 15;

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

    const existing = this.getPosition(tokenId);
    if (existing && existing.shares > 0) return [];

    // At 2-8¢ the fee is negligible (quartic fee ~= 0.05%). Even a tiny
    // edge above implied probability is profitable. modelProb = askPrice
    // + 0.01 (implied + 1pp) is enough.
    const modelProb = askPrice + 0.01;
    const edge = this.feeAdjustedEdge(modelProb, askPrice);
    if (!edge.profitable) return [];

    const size = Math.floor(this.dcaStepSize / askPrice);
    if (size < 5) return [];

    this.candleEntries++;
    this.markPending(tokenId);

    return [this.buy(tokenId, askPrice, size, {
      orderType: "taker",
      note: `dca-deep: ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)} #${this.candleEntries}`,
      signalSource: "dca_deep",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.candleEntries = 0;
    this.lastCandleKey = "";
  }
}
