import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * dca-edge-entry-v1 — clean re-implementation of bred-4h85's *accidental*
 * entry-zone filter.
 *
 * Context: Apr 14 2026 entry-price analysis revealed that bred-4h85's
 * buggy tick.midPrice inversion causes it to effectively only fire when
 * the cheap side is at 0.17-0.21 — the TOP of the 5-18¢ band. The bug
 * filters out deep entries (0.05-0.14) because the dual-book inversion
 * math only lands in-range when the cheap side has just entered the
 * zone, not when it has fully compressed. bred-4h85's lifetime +$1961
 * comes from this accidental edge-zone selectivity.
 *
 * dca-extreme-v1 reads books cleanly and fires across the full 5-18¢
 * band — catching the fully-compressed-and-reverting trades that bred
 * can't see. Result: dca-extreme is consistently ~$100 behind bred per
 * round on the same mechanism.
 *
 * This engine: same mechanism, same 4-entry ladder, same hold-to-settle,
 * but **narrow the band to 15-20¢** — the zone bred-4h85 effectively
 * trades. No bug, no inversion, no tick.midPrice; just a tighter band.
 *
 * Hypothesis: bred-4h85's +$79/fire at 67% WR comes from this narrow
 * zone, not from some magic in the buggy math. A clean version with
 * the same zone should match or beat it. If true, this is how we stop
 * relying on a known-buggy engine and get the same edge from clean code.
 *
 * Falsification: if dca-edge-entry-v1 doesn't reach bred-4h85's firing
 * WR within 10+ firings, the "narrow band is the edge" hypothesis is
 * wrong and we need a different mechanism (entry timing, book stability,
 * or something else bred's bug accidentally provides).
 */
export class DcaEdgeEntryEngine extends AbstractEngine {
  id = "dca-edge-entry-v1";
  name = "DCA Edge Entry (bred-4h85 clean)";
  version = "1.0.0";

  // Narrow band — the 15-20¢ "just-compressed" zone where bred-4h85
  // actually trades despite its 5-18¢ code comment.
  private readonly minEntryPrice = 0.15;
  private readonly maxEntryPrice = 0.20;
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

    const upBook = this.getBookForToken(upTokenId);
    const downBook = this.getBookForToken(downTokenId);
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    // The narrow 15-20¢ band. If neither side is in this zone, skip.
    const upCheap = upAsk >= this.minEntryPrice && upAsk <= this.maxEntryPrice;
    const downCheap = downAsk >= this.minEntryPrice && downAsk <= this.maxEntryPrice;
    if (!upCheap && !downCheap) return [];

    // Prefer the side whose ask is higher within the band. Rationale: the
    // side that just dropped INTO the band is the earlier-in-move state,
    // which is exactly bred-4h85's accidental timing. "Just compressed"
    // beats "fully compressed" in this band.
    let buyUp: boolean;
    if (upCheap && downCheap) {
      buyUp = upAsk > downAsk;
    } else {
      buyUp = upCheap;
    }

    const tokenId = buyUp ? upTokenId : downTokenId;
    const askPrice = buyUp ? upAsk : downAsk;

    // Don't pyramid — one entry per position per side
    const existing = this.getPosition(tokenId);
    if (existing && existing.shares > 0) return [];

    // Model prob: implied + small edge reflecting settlement asymmetry.
    // Slightly higher than dca-extreme-v1 because we're buying closer to
    // the resolution — fewer ticks of drift for the price to reverse.
    const modelProb = askPrice + 0.03;
    const edge = this.feeAdjustedEdge(modelProb, askPrice);
    if (!edge.profitable) return [];

    const size = Math.floor(this.dcaStepSize / askPrice);
    if (size < 5) return [];

    this.candleEntries++;
    this.markPending(tokenId);

    return [this.buy(tokenId, askPrice, size, {
      orderType: "taker",
      note: `dca-edge-entry: ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)} #${this.candleEntries}`,
      signalSource: "dca_edge_entry",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.candleEntries = 0;
    this.lastCandleKey = "";
  }
}
