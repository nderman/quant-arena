import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Merge Arb Sniper — taker-side cousin of the maker-only bred-gkci.
 *
 * The insight: UP and DOWN books on PM are INDEPENDENT. When UP_ask + DOWN_ask
 * drift below $1.00 (e.g. 0.48 + 0.48 = 0.96), the referee allows buying both
 * sides + merging for a risk-free $1/pair payout. Our referee charges quartic
 * fees on each leg and $0.10 gas for the merge.
 *
 * Profit per pair = $1.00 - (UP_ask + DOWN_ask) - fees - gas.
 *
 * The existing bred-gkci targets this but in a hyper-conservative maker-only
 * way, so it never fires. This engine accepts quartic fees to grab the profit
 * when the gap is wide enough to still net positive, and uses the sequential
 * fill pattern required by the referee (BUY both → wait for fills → MERGE on
 * next tick).
 *
 * State machine:
 *   IDLE → (sum < threshold) → BUYING (emit both BUYs) → PENDING (wait tick)
 *   PENDING → (both positions confirmed) → MERGE → IDLE
 *   PENDING → (rotation) → IDLE  (stranded legs will settle naturally)
 */
export class MergeArbSniperEngine extends AbstractEngine {
  id = "merge-arb-sniper-v1";
  name = "Merge Arb Sniper";
  version = "1.0.0";

  // Fire when sum < this. 0.94 leaves ~2.5% after 1.5%-ish fees + gas.
  private readonly maxSum = 0.94;
  // Minimum per-entry size to be worth the gas
  private readonly minShares = 20;
  // Don't let a single arb consume more than this fraction of cash
  private readonly maxCashPct = 0.40;
  // Once we hold both sides, emit MERGE next tick
  private armMergeNextTick = false;

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    // Reset on rotation — stranded legs will settle on their own.
    const rotated = this.updatePendingOrders();
    if (rotated) this.armMergeNextTick = false;

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    const holdsBoth = !!(upPos && downPos && upPos.shares > 0 && downPos.shares > 0);

    // If we hold both legs, fire the merge. Amount = min(upShares, downShares).
    if (holdsBoth) {
      const pairs = Math.min(upPos!.shares, downPos!.shares);
      if (pairs >= 1) {
        this.armMergeNextTick = false;
        return [this.merge(upTokenId, pairs, {
          note: `merge ${pairs} pairs`,
          signalSource: "merge_arb_complete",
        })];
      }
    }

    // Wait for in-flight BUYs to finalize before evaluating a new arb.
    if (this.hasPendingOrder()) return [];

    // Don't re-enter if we're partially stranded (one leg filled, the other
    // didn't) — let it settle. This is rare (both fills should land within
    // 50ms) but if it happens we accept the single-leg settlement outcome.
    if ((upPos && upPos.shares > 0) !== (downPos && downPos.shares > 0)) return [];
    if (holdsBoth) return [];

    const upBook = getBookForToken(upTokenId);
    const downBook = getBookForToken(downTokenId);
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    const sum = upAsk + downAsk;
    if (sum >= this.maxSum) return [];

    // Size to available depth on both sides
    const upDepth = upBook.asks[0]?.size ?? 0;
    const downDepth = downBook.asks[0]?.size ?? 0;
    const maxByDepth = Math.floor(Math.min(upDepth, downDepth));

    const maxByCash = Math.floor((state.cashBalance * this.maxCashPct) / sum);
    const shares = Math.min(maxByDepth, maxByCash);
    if (shares < this.minShares) return [];

    // Mark both pending — the buys will fill ~50ms later and we'll pick up
    // holdsBoth on a subsequent tick.
    this.markPending(upTokenId);
    this.markPending(downTokenId);
    this.armMergeNextTick = true;

    const grossProfit = (1 - sum) * shares;
    return [
      this.buy(upTokenId, upAsk, shares, {
        orderType: "taker",
        note: `merge-arb UP @ ${upAsk.toFixed(3)}, sum=${sum.toFixed(3)}, est=$${grossProfit.toFixed(2)}`,
        signalSource: "merge_arb_entry",
      }),
      this.buy(downTokenId, downAsk, shares, {
        orderType: "taker",
        note: `merge-arb DOWN @ ${downAsk.toFixed(3)}, sum=${sum.toFixed(3)}`,
        signalSource: "merge_arb_entry",
      }),
    ];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.armMergeNextTick = false;
  }
}
