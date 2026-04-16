import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Clean hand-built version of bred-4h85's "DCA Settler Pro".
 *
 * Strategy: DCA up to 4 entries per candle into extreme underdogs (5-18¢),
 * hold to settlement. Pure pattern, no inversions, no random tie-breaks.
 * A/B partner for bred-4h85 — identical strategy intent, bugs removed.
 *
 * Bugs fixed vs bred-4h85:
 *  1. tokenSide guard — only process UP ticks, look up DOWN book directly
 *  2. Dual books read via getBookForToken (no 1-x inversions)
 *  3. Proper model probability: implied + floor edge based on fee savings
 *  4. Deterministic maker/taker split (entry count parity)
 *  5. Removed dead volatility tracking
 */
export class DcaExtremeEngine extends AbstractEngine {
  id = "dca-extreme-v1";
  name = "DCA Extreme Settle";
  version = "1.0.0";

  private readonly minEntryPrice = 0.05;
  private readonly maxEntryPrice = 0.18;
  private readonly dcaStepSize = 5;
  private readonly maxEntriesPerCandle = 2; // was 4 — bred-4h85 averages 1.6 entries/candle
  private readonly settlementBufferSec = 15;

  private candleEntries = 0;
  private lastCandleKey = "";

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    this.trackBinance(tick);
    if (tick.source !== "polymarket") return [];

    // Warm-up gate: don't fire until the Binance buffer has 300+ samples
    // (~5 min). Round 8 forensic showed dca-extreme-v1 bust in 3 candles
    // at round start (-$49 in 30 min) while bred-4h85 waited 34 min then
    // caught 5/11 wins (+$125). bred's delay is accidental (tick.midPrice
    // gate needs specific book conditions that don't exist at round start);
    // we replicate with an explicit buffer check. currentRegime(300) returns
    // UNKNOWN when the buffer has fewer than 300 samples.
    if (this.currentRegime(300) === "UNKNOWN") return [];

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

    // No regime gate: Apr 14 engineRegimeReport showed bred-4h85 wins in
    // BOTH CHOP (+$17/round) and TREND (+$83/round). The earlier TREND
    // gate was fit on 3-round data and gated out profitable CHOP trades.
    // The strategy's edge is in asymmetric price payoff, not direction.

    const upBook = this.getBookForToken(upTokenId);
    const downBook = this.getBookForToken(downTokenId);
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    const upCheap = upAsk >= this.minEntryPrice && upAsk <= this.maxEntryPrice;
    const downCheap = downAsk >= this.minEntryPrice && downAsk <= this.maxEntryPrice;
    if (!upCheap && !downCheap) return [];

    // Prefer the cheaper side when both qualify
    const buyUp = upCheap && (!downCheap || upAsk < downAsk);
    const tokenId = buyUp ? upTokenId : downTokenId;
    const askPrice = buyUp ? upAsk : downAsk;
    const book = buyUp ? upBook : downBook;

    // PYRAMIDING ALLOWED WITHIN A CANDLE (Apr 15 fix):
    // The previous "don't pyramid" block was the exact bug that made this
    // engine lose vs bred-4h85. bred's lifetime edge comes from adding
    // entries at progressively better prices within the same candle —
    // the original meaning of DCA. When the cheap side keeps dropping
    // from 0.18 → 0.10 → 0.05, we want 3 entries with a lowered basis,
    // not 1 entry stuck at 0.18.
    //
    // The maxEntriesPerCandle=4 cap + pendingOrder guard + dcaStepSize
    // together bound per-candle exposure to $20 regardless of pyramiding.
    // Cross-candle pyramiding doesn't happen because candleEntries resets
    // on rotation.

    // Model prob: implied by price + small edge reflecting settlement payoff
    // asymmetry at extremes (winner pays $1, loser pays $0)
    const modelProb = askPrice + 0.02;
    const edge = this.feeAdjustedEdge(modelProb, askPrice);
    if (!edge.profitable) return [];

    const size = Math.floor(this.dcaStepSize / askPrice);
    if (size < 5) return [];

    // Deterministic maker/taker: 85% taker (every 7th entry is maker)
    const useMaker = this.candleEntries % 7 === 6;
    this.candleEntries++;
    this.markPending(tokenId);

    if (useMaker) {
      const bestBid = book.bids[0]?.price ?? 0;
      const makerLimit = Math.max(bestBid + 0.001, askPrice - 0.003);
      if (makerLimit >= askPrice) {
        // Would cross — fall through to taker
      } else {
        return [this.buy(tokenId, makerLimit, size, {
          orderType: "maker",
          note: `dca-extreme: maker ${buyUp ? "UP" : "DOWN"} @ ${makerLimit.toFixed(3)} #${this.candleEntries}`,
          signalSource: "dca_extreme",
        })];
      }
    }

    return [this.buy(tokenId, askPrice, size, {
      orderType: "taker",
      note: `dca-extreme: taker ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)} #${this.candleEntries}`,
      signalSource: "dca_extreme",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.candleEntries = 0;
    this.lastCandleKey = "";
  }
}
