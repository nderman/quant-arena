import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * dca-clean-bred-v1 — Gemini's "Three Friction Layers" design.
 *
 * After discovering bred-4h85's 94% rejection rate is the edge (260
 * attempts/round → 15 fills), Gemini identified three intentional
 * filters that replicate the accidental rejection behavior:
 *
 * 1. DOUBLE-CONFIRMATION: only enter when both books agree on the
 *    extreme state (upAsk < 0.18 AND downBid > 0.80). Filters stale
 *    book situations where one side hasn't updated.
 *
 * 2. PHANTOM COUNTER: count ALL ticks entering the extreme zone,
 *    whether we trade or not. Lock the candle after 15+ ticks.
 *    High tick volume in the zone = breakout (bad for underdogs),
 *    not bounce (good). bred accidentally achieves this via
 *    candleEntries++ on rejected phantom DOWN entries.
 *
 * 3. FIRST-MOVER LOCKOUT: whichever side enters the extreme band
 *    first in a candle, lock to that side. Prevents oscillating
 *    between UP and DOWN. bred does this via per-side position block
 *    + counter waste.
 *
 * Additional: single fill per candle (bred averages 1.6 fills from
 * its ~4 attempts due to phantom waste + per-side block).
 */
export class DcaCleanBredEngine extends AbstractEngine {
  id = "dca-clean-bred-v1";
  name = "DCA Clean Bred (Gemini 3-layer)";
  version = "1.0.0";

  private readonly minEntryPrice = 0.05;
  private readonly maxEntryPrice = 0.18;
  private readonly dcaStepSize = 5;
  private readonly maxFillsPerCandle = 1;
  private readonly settlementBufferSec = 15;

  // Phantom counter: lock candle after this many ticks in the zone
  private readonly maxTicksInZone = 15;

  // Double-confirmation: opposite side must be above this
  private readonly minOppositeBid = 0.80;

  private candleFills = 0;
  private ticksInZone = 0;
  private firstSideInZone: "UP" | "DOWN" | null = null;
  private lastCandleKey = "";

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    this.trackBinance(tick);
    if (tick.source !== "polymarket") return [];

    // Warm-up: wait for Binance buffer
    if (this.currentRegime(300) === "UNKNOWN") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();

    const candleKey = `${upTokenId}:${downTokenId}`;
    if (candleKey !== this.lastCandleKey) {
      this.candleFills = 0;
      this.ticksInZone = 0;
      this.firstSideInZone = null;
      this.lastCandleKey = candleKey;
    }

    const secsRemaining = this.getSecondsRemaining();
    if (secsRemaining >= 0 && secsRemaining < this.settlementBufferSec) return [];

    if (this.hasPendingOrder()) return [];
    if (this.candleFills >= this.maxFillsPerCandle) return [];

    const upBook = this.getBookForToken(upTokenId);
    const downBook = this.getBookForToken(downTokenId);
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    const upBid = upBook.bids[0]?.price ?? 0;
    const downBid = downBook.bids[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    const upCheap = upAsk >= this.minEntryPrice && upAsk <= this.maxEntryPrice;
    const downCheap = downAsk >= this.minEntryPrice && downAsk <= this.maxEntryPrice;

    // ── FRICTION LAYER 2: Phantom counter ──
    // Count EVERY tick where either side is in the extreme zone,
    // whether we trade or not. High tick count = volatile breakout
    // (bad for mean-reversion underdog bets).
    if (upCheap || downCheap) {
      this.ticksInZone++;
    }
    if (this.ticksInZone > this.maxTicksInZone) return [];

    if (!upCheap && !downCheap) return [];

    // ── FRICTION LAYER 3: First-mover lockout ──
    // Whichever side enters the band first, we're locked to it for
    // the candle. Prevents oscillating between UP and DOWN.
    if (this.firstSideInZone === null) {
      this.firstSideInZone = upCheap ? "UP" : "DOWN";
    }

    let buyUp: boolean;
    if (this.firstSideInZone === "UP") {
      if (!upCheap) return [];
      buyUp = true;
    } else {
      if (!downCheap) return [];
      buyUp = false;
    }

    // ── FRICTION LAYER 1: Double-confirmation ──
    // Both books must agree on the extreme state. If UP is cheap,
    // DOWN's bid must be high (>0.80), confirming the market isn't
    // just stale on one side.
    if (buyUp && downBid < this.minOppositeBid) return [];
    if (!buyUp && upBid < this.minOppositeBid) return [];

    const tokenId = buyUp ? upTokenId : downTokenId;
    const askPrice = buyUp ? upAsk : downAsk;

    // Per-side position block (bred's !(upPos && upPos.shares > 0))
    const existing = this.getPosition(tokenId);
    if (existing && existing.shares > 0) return [];

    // Model prob: bred uses +0.03
    const modelProb = askPrice + 0.03;
    const edge = this.feeAdjustedEdge(modelProb, askPrice);
    if (!edge.profitable) return [];

    const size = Math.floor(this.dcaStepSize / askPrice);
    if (size < 5) return [];

    this.candleFills++;
    this.markPending(tokenId);

    return [this.buy(tokenId, askPrice, size, {
      orderType: "taker",
      note: `dca-clean-bred: ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)} ticks=${this.ticksInZone} first=${this.firstSideInZone}`,
      signalSource: "dca_clean_bred",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.candleFills = 0;
    this.ticksInZone = 0;
    this.firstSideInZone = null;
    this.lastCandleKey = "";
  }
}
