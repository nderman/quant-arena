import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Compares spread BPS on UP's book vs DOWN's book to detect MM conviction
 * asymmetry. The side with the TIGHTER spread has MORE MM interest — they
 * quote tight because they believe that side is easier to hedge (= more
 * likely to settle their way).
 *
 * Thesis:
 *   - When UP's spread is < 60% of DOWN's spread (UP markedly tighter),
 *     MMs have higher conviction on UP → buy UP.
 *   - Vice versa for DOWN.
 *   - Both must have reasonable absolute spreads (not 0 or > 800bps).
 *
 * Teaches the breeder to compare the same signal across UP and DOWN books
 * — cross-book analysis is often richer than single-book. Also shows
 * null-safety against empty/crossed books.
 */
export class SpreadCompressionEngine extends AbstractEngine {
  id = "spread-compression-v1";
  name = "Spread Compression";
  version = "1.0.0";

  private readonly ratioThreshold = 0.60;  // one side's spread < 60% of other
  private readonly minSpread = 50;         // ≥5bps (book must be live)
  private readonly maxSpread = 800;        // ≤80bps (book must be normal)
  private readonly entryMin = 0.35;
  private readonly entryMax = 0.75;
  private readonly maxCashPct = 0.15;

  // Hysteresis: require the ratio condition to hold for 5 consecutive
  // ticks to avoid trading on transient spread flicker.
  private upTighterStreak = 0;
  private downTighterStreak = 0;
  private readonly persistenceTicks = 5;

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

    const upSpread = this.spreadBps(upTokenId);
    const downSpread = this.spreadBps(downTokenId);
    const bothValid =
      upSpread >= this.minSpread && upSpread <= this.maxSpread &&
      downSpread >= this.minSpread && downSpread <= this.maxSpread;

    if (!bothValid) {
      this.upTighterStreak = 0;
      this.downTighterStreak = 0;
      return [];
    }

    // Update streaks based on which side is markedly tighter
    const upTighter = upSpread <= downSpread * this.ratioThreshold;
    const downTighter = downSpread <= upSpread * this.ratioThreshold;
    this.upTighterStreak = upTighter ? this.upTighterStreak + 1 : 0;
    this.downTighterStreak = downTighter ? this.downTighterStreak + 1 : 0;

    let side: "UP" | "DOWN" | null = null;
    if (this.upTighterStreak >= this.persistenceTicks) side = "UP";
    else if (this.downTighterStreak >= this.persistenceTicks) side = "DOWN";
    if (!side) return [];

    const tokenId = side === "UP" ? upTokenId : downTokenId;
    const book = this.getBookForToken(tokenId);
    if (!this.isBookTradeable(book)) return [];
    const askPrice = book.asks[0]?.price ?? 0;
    if (askPrice < this.entryMin || askPrice > this.entryMax) return [];

    const edge = this.feeAdjustedEdge(0.66, askPrice);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / askPrice);
    if (shares < 5) return [];

    // Reset so we don't re-fire on the next tick
    if (side === "UP") this.upTighterStreak = 0;
    else this.downTighterStreak = 0;

    const makerPrice = Math.round((askPrice - 0.015) * 1000) / 1000;
    this.markPending(tokenId);
    if (makerPrice >= askPrice) {
      return [this.buy(tokenId, askPrice, shares, {
        orderType: "taker",
        note: `spread-compression: ${side} upSp=${upSpread.toFixed(0)}bps downSp=${downSpread.toFixed(0)}bps`,
        signalSource: "spread_compression",
      })];
    }
    return [this.buy(tokenId, makerPrice, shares, {
      orderType: "maker",
      note: `spread-compression: ${side} maker upSp=${upSpread.toFixed(0)}bps downSp=${downSpread.toFixed(0)}bps`,
      signalSource: "spread_compression",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.upTighterStreak = 0;
    this.downTighterStreak = 0;
  }
}
