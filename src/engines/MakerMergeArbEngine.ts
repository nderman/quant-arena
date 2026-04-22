import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * maker-merge-arb-v1 — merge arb Phase-3 proven design (hard-side-first + market chase).
 *
 * Based on live-proven pattern from polymarket-ai-bot MERGE_ARB_HISTORY.md:
 *   - Phase 1 symmetric bids at 0.48 → failed (chop-only assumption)
 *   - Phase 3 hard-side-first + market chase → +$5.23/119% in 2h on BTC
 *   - Phase 4 resting GTC at full budget → locked merges at $0.98 (fees ate profit)
 *   - Phase 7 smile curve → -$9.83/84% (complexity kills)
 *
 * Winning recipe (simple):
 *   1. Binance momentum picks "hard side" (side we commit to first)
 *   2. Taker BUY hard side at current bestAsk — fills immediately, commits capital
 *   3. On fill: taker BUY easy side at bestAsk+0.001 (chase market, don't rest GTC)
 *   4. Once both held: MERGE for $1/pair
 *   5. Mop-up at T-30s: if stranded with one leg, cross spread on other
 *   6. Killswitch at T-15s: don't initiate new pairs
 *
 * Why taker on both legs: resting GTC at full budget fills at posted price
 * (=$0.98 merges, 88% of profit eaten by fees). Taker ask+0.001 chases the
 * actual market ($0.70-0.85 merges, 10-15% fees). Net $0.68 vs $0.01.
 */
export class MakerMergeArbEngine extends AbstractEngine {
  id = "maker-merge-arb-v1";
  name = "Merge Arb (Phase 3 hard-side-first)";
  version = "1.0.0";

  private readonly entryStartSec = 60;      // skip first minute
  private readonly killswitchSec = 15;      // no new pairs in last 15s
  private readonly mopupSec = 30;            // mop-up stranded leg at T-30s
  private readonly momentumThresh = 0.0003; // 3bps minimum to call a "hard side"
  private readonly momentumLookback = 60;
  private readonly maxMergeCost = 0.92;     // reject if hard+easy sum exceeds
  private readonly sharesPerLeg = 10;

  private hardSide: "UP" | "DOWN" | null = null;
  private enteredThisCandle = false;
  private lastCandleKey = "";

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    this.trackBinance(tick);
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    const rotated = this.updatePendingOrders();
    const candleKey = `${upTokenId}:${downTokenId}`;
    if (candleKey !== this.lastCandleKey || rotated) {
      this.lastCandleKey = candleKey;
      this.hardSide = null;
      this.enteredThisCandle = false;
    }

    const upShares = this.getPosition(upTokenId)?.shares ?? 0;
    const downShares = this.getPosition(downTokenId)?.shares ?? 0;
    const holdsBoth = upShares > 0 && downShares > 0;

    // ── Priority 1: Merge when we hold both legs ──
    if (holdsBoth) {
      const pairs = Math.min(upShares, downShares);
      return [this.merge(upTokenId, pairs, {
        note: `merge ${pairs} pairs (hard=${this.hardSide})`,
        signalSource: "maker_merge_arb",
      })];
    }

    if (this.hasPendingOrder()) return [];

    const secsRemaining = this.getSecondsRemaining();
    if (secsRemaining < 0) return [];

    const upBook = this.getBookForToken(upTokenId);
    const downBook = this.getBookForToken(downTokenId);
    if (!this.isBookTradeable(upBook) || !this.isBookTradeable(downBook)) return [];
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    // ── Priority 2: Easy-side chase when hard leg already filled ──
    // Only chase if it still makes sense economically (respect maxMergeCost).
    if (upShares > 0 && downShares === 0) {
      // Stranded UP — chase DOWN
      const filledUpCost = upAsk;  // approximation; actual avg entry is in pos.avgEntry
      if (filledUpCost + downAsk <= this.maxMergeCost || secsRemaining < this.mopupSec) {
        const tokenId = downTokenId;
        const chasePrice = Math.min(downAsk + 0.001, 0.99);
        this.markPending(tokenId);
        return [this.buy(tokenId, chasePrice, this.sharesPerLeg, {
          orderType: "taker",
          note: `merge chase DOWN @ ${chasePrice.toFixed(3)}${secsRemaining < this.mopupSec ? " (mop-up)" : ""}`,
          signalSource: "maker_merge_arb",
        })];
      }
      return [];  // too expensive to complete, let UP settle as orphan
    }
    if (downShares > 0 && upShares === 0) {
      const filledDownCost = downAsk;
      if (filledDownCost + upAsk <= this.maxMergeCost || secsRemaining < this.mopupSec) {
        const tokenId = upTokenId;
        const chasePrice = Math.min(upAsk + 0.001, 0.99);
        this.markPending(tokenId);
        return [this.buy(tokenId, chasePrice, this.sharesPerLeg, {
          orderType: "taker",
          note: `merge chase UP @ ${chasePrice.toFixed(3)}${secsRemaining < this.mopupSec ? " (mop-up)" : ""}`,
          signalSource: "maker_merge_arb",
        })];
      }
      return [];
    }

    // ── Priority 3: Fresh entry (hard side first) ──
    if (this.enteredThisCandle) return [];

    const windowStart = this.getWindowStart();
    const windowEnd = this.state.marketWindowEnd || 0;
    const candleSec = Math.round((windowEnd - windowStart) / 1000);
    if (candleSec <= 0) return [];
    const elapsed = candleSec - secsRemaining;
    const scale = candleSec / 300;

    if (elapsed < this.entryStartSec * scale) return [];       // too early
    if (secsRemaining < this.killswitchSec * scale) return []; // killswitch

    // Need a clear hard side from Binance momentum
    const momentum = this.recentMomentum(this.momentumLookback);
    if (Math.abs(momentum) < this.momentumThresh) return [];

    const hard: "UP" | "DOWN" = momentum > 0 ? "UP" : "DOWN";
    const hardTokenId = hard === "UP" ? upTokenId : downTokenId;
    const hardAsk = hard === "UP" ? upAsk : downAsk;
    const easyAsk = hard === "UP" ? downAsk : upAsk;

    // Pre-check: don't enter if the merge is already unprofitable
    if (hardAsk + easyAsk > this.maxMergeCost) return [];
    // Sanity: don't enter if asks sum < $1 (someone else already arbbed it)
    if (hardAsk + easyAsk < 1.005) return [];

    this.hardSide = hard;
    this.enteredThisCandle = true;
    this.markPending(hardTokenId);
    return [this.buy(hardTokenId, hardAsk, this.sharesPerLeg, {
      orderType: "taker",
      note: `merge hard=${hard} @ ${hardAsk.toFixed(3)} (mom=${(momentum * 10000).toFixed(1)}bps, sum=${(hardAsk + easyAsk).toFixed(3)})`,
      signalSource: "maker_merge_arb",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.hardSide = null;
    this.enteredThisCandle = false;
    this.lastCandleKey = "";
  }
}
