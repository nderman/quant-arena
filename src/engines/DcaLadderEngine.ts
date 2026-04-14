import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * dca-ladder-v1 — aggressive 8-entry DCA variant.
 *
 * Same price band as dca-extreme (5-18¢) but doubles the DCA ladder from
 * 4 entries to 8. Smaller per-entry size to keep total risk bounded.
 *
 * Hypothesis: bred-4h85 fires 4 entries per candle. weidan (#3 Polymarket
 * daily LB) averaged ~18 DCA entries per position. More entries capture
 * more of the candle's price range — you buy dips as they come. Question:
 * does aggressive DCA improve the average fill price enough to boost WR,
 * or does it just scale both wins and losses proportionally?
 *
 * Size per entry: $2.50 (vs dca-extreme's $5) so 8 × $2.50 = $20 total
 * budget per candle, same as dca-extreme's 4 × $5 = $20.
 */
export class DcaLadderEngine extends AbstractEngine {
  id = "dca-ladder-v1";
  name = "DCA 8-Entry Ladder";
  version = "1.0.0";

  private readonly minEntryPrice = 0.05;
  private readonly maxEntryPrice = 0.18;
  private readonly dcaStepSize = 2.5; // half of dca-extreme's $5
  private readonly maxEntriesPerCandle = 8;
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

    // Pyramid allowed: unlike other variants, the ladder intentionally
    // adds to an existing position at different entry prices. Skip only
    // if we just filled (pending guard already handles this).

    const modelProb = askPrice + 0.02;
    const edge = this.feeAdjustedEdge(modelProb, askPrice);
    if (!edge.profitable) return [];

    const size = Math.floor(this.dcaStepSize / askPrice);
    if (size < 5) return [];

    this.candleEntries++;
    this.markPending(tokenId);

    return [this.buy(tokenId, askPrice, size, {
      orderType: "taker",
      note: `dca-ladder: ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)} #${this.candleEntries}/8`,
      signalSource: "dca_ladder",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.candleEntries = 0;
    this.lastCandleKey = "";
  }
}
