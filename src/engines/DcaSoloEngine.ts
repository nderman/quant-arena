import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * dca-solo-v1 — single-shot extreme underdog (no DCA ladder).
 *
 * Same price band as dca-extreme (5-18¢) but fires exactly ONE entry per
 * candle with the full $20 budget. Control variant for the A/B: isolates
 * the question "is the DCA ladder actually necessary, or does a single
 * big entry capture the same edge?".
 *
 * Hypothesis: the asymmetric payoff comes from price alone, not from
 * averaging across multiple entries. If true, solo should match or beat
 * dca-extreme with fewer trades and lower fee drag.
 *
 * Tradeoff: one entry means you commit at one price. If the price dips
 * further after your entry, you miss the better fills DCA would have
 * caught. If the price runs away, you're done.
 */
export class DcaSoloEngine extends AbstractEngine {
  id = "dca-solo-v1";
  name = "DCA Solo (Single Entry)";
  version = "1.0.0";

  private readonly minEntryPrice = 0.05;
  private readonly maxEntryPrice = 0.18;
  private readonly totalBudget = 20; // full $20 in one shot
  private readonly settlementBufferSec = 15;

  private enteredThisCandle = false;
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
      this.enteredThisCandle = false;
      this.lastCandleKey = candleKey;
    }

    const secsRemaining = this.getSecondsRemaining();
    if (secsRemaining >= 0 && secsRemaining < this.settlementBufferSec) return [];

    if (this.hasPendingOrder()) return [];
    if (this.enteredThisCandle) return [];

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

    const modelProb = askPrice + 0.02;
    const edge = this.feeAdjustedEdge(modelProb, askPrice);
    if (!edge.profitable) return [];

    // Full budget into a single entry
    const size = Math.floor(this.totalBudget / askPrice);
    if (size < 5) return [];

    this.enteredThisCandle = true;
    this.markPending(tokenId);

    return [this.buy(tokenId, askPrice, size, {
      orderType: "taker",
      note: `dca-solo: ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)} single-shot $${this.totalBudget}`,
      signalSource: "dca_solo",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.enteredThisCandle = false;
    this.lastCandleKey = "";
  }
}
