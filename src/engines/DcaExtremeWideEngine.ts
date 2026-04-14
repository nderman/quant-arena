import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Wider-range variant of dca-extreme-v1.
 *
 * Same strategy — DCA into underdog, hold to settlement — but with a wider
 * price band (5-28¢ vs 5-18¢). A/B partner for dca-extreme-v1 to test
 * whether near-extreme prices (18-28¢) still have asymmetric payoff edge.
 *
 * Theoretical tradeoff:
 *   5-18¢:  higher per-win payoff ($0.82-$0.95), lower WR floor required
 *   5-28¢:  lower per-win payoff ($0.72-$0.95), wider range catches more candles
 *
 * The Apr 14 regime report showed bred-4h85 (5-18¢) winning +$83/round in
 * TREND. If the mechanism is pure asymmetric payoff at underdog prices,
 * the wider band should also win — maybe less per trade but on more trades.
 * Real-world data will tell us which band has the best expected value.
 */
export class DcaExtremeWideEngine extends AbstractEngine {
  id = "dca-extreme-wide-v1";
  name = "DCA Extreme Wide";
  version = "1.0.0";

  private readonly minEntryPrice = 0.05;
  private readonly maxEntryPrice = 0.28;
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

    // At wider entry prices (up to 28¢), we need slightly more conviction
    // for the edge to survive fees. 3¢ model edge instead of 2¢.
    const modelProb = askPrice + 0.03;
    const edge = this.feeAdjustedEdge(modelProb, askPrice);
    if (!edge.profitable) return [];

    const size = Math.floor(this.dcaStepSize / askPrice);
    if (size < 5) return [];

    this.candleEntries++;
    this.markPending(tokenId);

    return [this.buy(tokenId, askPrice, size, {
      orderType: "taker",
      note: `dca-wide: ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)} #${this.candleEntries}`,
      signalSource: "dca_extreme_wide",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.candleEntries = 0;
    this.lastCandleKey = "";
  }
}
