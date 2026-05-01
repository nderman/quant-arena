import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * dca-native-tick-v1 — tests Gemini's "Native Tick" hypothesis.
 *
 * Context (Apr 20): after 8 failed hypotheses trying to replicate
 * bred-4h85's +$4905 edge, we showed Gemini the code and the data.
 * Gemini identified that bred-4h85's bug makes it ONLY fire when the
 * tick is FROM the book it's buying — a "Native Tick Selection Bias."
 *
 * The data supports this: dca-extreme-v1's UP buys have 10.8% WR
 * while bred-4h85's UP buys have ~33% WR. Same side, 3x WR gap.
 * bred fires on fewer, higher-quality UP candles because the
 * tick.midPrice gate only triggers when the UP book itself pushes
 * an update into the [0.05, 0.18] range — a "Liquidity Velocity
 * Filter" that catches the exact moment the underdog book is moving.
 *
 * This engine: identical to dca-extreme-v1 with one addition:
 *   if (tick.tokenSide !== chosenSide) return [];
 *
 * Only fire when the tick originates from the book you want to buy.
 * This replicates bred's tick-driven entry timing without the
 * inversion bug, holdingBoth guard, or random maker split.
 *
 * Also includes bred's modelProb = price + 0.03 (vs extreme's 0.02)
 * and bred's holdingBoth guard (Gemini's #3: anti-straddle).
 *
 * Falsification: if this engine doesn't close the WR gap with bred
 * over 10+ firings, the "native tick" hypothesis is wrong and we
 * need to look at Math.random taker/maker or something else entirely.
 */
export class DcaNativeTickEngine extends AbstractEngine {
  id = "dca-native-tick-v1";
  name = "DCA Native Tick (Gemini hypothesis)";
  version = "1.0.0";

  private readonly minEntryPrice = 0.05;
  private readonly maxEntryPrice = 0.18;
  private readonly dcaStepSize = 5;
  private readonly maxEntriesPerCandle = 4;
  private readonly settlementBufferSec = 15;

  private candleEntries = 0;
  private lastCandleKey = "";
  private enteredSide: "UP" | "DOWN" | null = null;

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
      this.candleEntries = 0;
      this.enteredSide = null;
      this.lastCandleKey = candleKey;
    }

    const secsRemaining = this.getSecondsRemaining();
    if (secsRemaining >= 0 && secsRemaining < this.settlementBufferSec) return [];

    if (this.hasPendingOrder()) return [];
    if (this.candleEntries >= this.maxEntriesPerCandle) return [];

    // ── Anti-straddle (Gemini #3): once committed to a side, stay there ──
    // bred-4h85 has `if (holdingBoth) return [];` which prevents buying
    // both sides. We go further: once we pick a side this candle, we're
    // locked to it. Prevents oscillating between UP and DOWN on choppy
    // books within the same 5-minute window.

    const upBook = this.getBookForToken(upTokenId);
    const downBook = this.getBookForToken(downTokenId);
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    const upCheap = upAsk >= this.minEntryPrice && upAsk <= this.maxEntryPrice;
    const downCheap = downAsk >= this.minEntryPrice && downAsk <= this.maxEntryPrice;
    if (!upCheap && !downCheap) return [];

    // Decide which side to buy
    let buyUp: boolean;
    if (this.enteredSide === "UP") {
      if (!upCheap) return [];
      buyUp = true;
    } else if (this.enteredSide === "DOWN") {
      if (!downCheap) return [];
      buyUp = false;
    } else {
      buyUp = upCheap && (!downCheap || upAsk < downAsk);
    }

    // ═══════════════════════════════════════════════════════════════
    // THE KEY GATE (Gemini hypothesis #1): Native Tick Filter
    // Only fire if this tick is FROM the book we want to buy.
    // bred-4h85 accidentally does this because its tick.midPrice
    // gate only succeeds when the tick is for the correct book.
    // This replicates that behavior explicitly.
    // ═══════════════════════════════════════════════════════════════
    const wantedSide = buyUp ? "UP" : "DOWN";
    if (tick.tokenSide !== wantedSide) return [];

    const tokenId = buyUp ? upTokenId : downTokenId;
    const askPrice = buyUp ? upAsk : downAsk;

    // Model prob: bred uses +0.03, our extreme used +0.02
    const modelProb = askPrice + 0.03;
    const edge = this.feeAdjustedEdge(modelProb, askPrice);
    if (!edge.profitable) return [];

    const size = Math.floor(this.dcaStepSize / askPrice);
    if (size < 5) return [];

    this.candleEntries++;
    this.enteredSide = wantedSide;
    this.markPending(tokenId);

    return [this.buy(tokenId, askPrice, size, {
      orderType: "taker",
      note: `dca-native-tick: ${wantedSide} @ ${askPrice.toFixed(3)} #${this.candleEntries} (native tick)`,
      signalSource: "dca_native_tick",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.candleEntries = 0;
    this.enteredSide = null;
    this.lastCandleKey = "";
  }
}
