import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "./../types";

/**
 * First engine to react to PM book microstructure (Phase B signals).
 *
 * Thesis: when one side of the book shows sustained bid/ask imbalance
 * > 0.4 for at least 10 consecutive PM ticks, demand is outstripping
 * supply and the price is likely to keep rising. Fire as a taker on the
 * heavy side. Hold to settlement.
 *
 * This contradicts the usual "fade imbalance = mean revert" thesis
 * because PM binary resolution is ≤15m away — not enough time for full
 * mean reversion, and sustained flow inside that window usually carries.
 *
 * Parameters chosen conservatively for first deployment:
 *  - imbalance threshold: |imb| ≥ 0.4 on top 3 levels
 *  - persistence: need 10 consecutive above-threshold ticks
 *  - entry price band: 0.35-0.75 (avoid extremes where fill risk dominates)
 *  - fires at most once per candle per side
 */
export class BookImbalanceEngine extends AbstractEngine {
  id = "book-imbalance-v1";
  name = "Book Imbalance";
  version = "1.0.0";

  private readonly threshold = 0.4;
  private readonly persistenceTicks = 10;
  private readonly entryMin = 0.35;
  private readonly entryMax = 0.75;
  private readonly maxCashPct = 0.20;

  // Rolling counters: how many consecutive ticks have been above threshold
  private upStreak = 0;
  private downStreak = 0;

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    // Read imbalance on each side's book. Since UP and DOWN are independent
    // books, we check each separately.
    const upImb = this.bookImbalance(upTokenId);
    const downImb = this.bookImbalance(downTokenId);

    // Update streaks. Reset to zero if below threshold this tick.
    this.upStreak = upImb >= this.threshold ? this.upStreak + 1 : 0;
    this.downStreak = downImb >= this.threshold ? this.downStreak + 1 : 0;

    let side: "UP" | "DOWN" | null = null;
    if (this.upStreak >= this.persistenceTicks) side = "UP";
    else if (this.downStreak >= this.persistenceTicks) side = "DOWN";
    if (!side) return [];

    const tokenId = side === "UP" ? upTokenId : downTokenId;
    const book = this.getBookForToken(tokenId);
    if (!this.isBookTradeable(book)) return [];

    const askPrice = book.asks[0]?.price ?? 0;
    if (askPrice < this.entryMin || askPrice > this.entryMax) return [];

    // Fee-adjusted edge gate. Imbalance implies ~70% directional confidence.
    const edge = this.feeAdjustedEdge(0.70, askPrice);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / askPrice);
    if (shares < 5) return [];

    // Reset the streak so we don't immediately re-fire on the next tick
    if (side === "UP") this.upStreak = 0;
    else this.downStreak = 0;

    this.markPending(tokenId);
    return [this.buy(tokenId, askPrice, shares, {
      orderType: "taker",
      note: `book-imbalance: ${side} imb=${side === "UP" ? upImb.toFixed(2) : downImb.toFixed(2)} @ ${askPrice.toFixed(3)}`,
      signalSource: "book_imbalance",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.upStreak = 0;
    this.downStreak = 0;
  }
}
