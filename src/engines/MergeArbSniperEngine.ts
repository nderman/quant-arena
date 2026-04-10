import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick } from "../types";
import { getBookForToken } from "../pulse";
import { CONFIG } from "../config";

/**
 * Merge Arb Sniper — the only risk-free strategy in the arena.
 *
 * In real Polymarket, UP and DOWN orderbooks are independent. Most of the time
 * UP_ask + DOWN_ask > $1 (the spread the market makers eat). But occasionally
 * the books drift such that UP_ask + DOWN_ask < $1 — that's a free dollar.
 *
 * Strategy:
 *   1. Watch both books every PM tick
 *   2. When (UP_ask + DOWN_ask) < threshold, buy both sides at best ask (taker)
 *   3. Next tick (after the buys settle into positions), submit a MERGE — the
 *      referee notices we hold both sides and uses Flavor A (gas only).
 *   4. Net profit = $1 - (UP_ask + DOWN_ask) - fees - gas
 *
 * Threshold math (5 share trade):
 *   - Fees: ~1.5% per leg × 2 = 3% × cost = ~$0.15 on a $5 trade
 *   - Gas: ~$0.04
 *   - Merge fee: 0
 *   - Need (1 - sum) × 5 > $0.20 → sum < $0.96
 *
 * We use 0.96 as the threshold for safety.
 *
 * Failure modes the merge finality guard already handles:
 *   - Submitting a merge in the last 3s of the candle → rejected (can't land
 *     on-chain before settlement)
 *
 * Failure modes this engine accepts:
 *   - Only one leg fills → engine ends up holding just one side. We'll just hold
 *     that to settlement and take whatever payout the candle gives us.
 *   - Books move between tick and fill → already modelled by the per-tick
 *     book snapshot in the referee. Engines share depleted liquidity within a
 *     tick, so a stale arb won't be hallucinated.
 *
 * Expected behavior:
 *   - Trades almost never (real arbs are rare and competed for)
 *   - When it does trade, every fill is structurally positive
 *   - Total trades may be 0 across many rounds — that's the result, not a bug
 */
export class MergeArbSniperEngine extends AbstractEngine {
  id = "merge-arb-sniper-v1";
  name = "Merge Arb Sniper";
  version = "1.0.0";

  // Conservative threshold: only fire when the gap covers fees + gas with margin.
  private readonly maxAskSum = 0.96;
  // Stay tiny — this is a precision strategy, not a size game.
  private readonly tradeShares = 5;
  // Don't fire in the last N seconds of a candle — merge finality guard would
  // reject the merge anyway, no point eating the buys.
  private readonly minSecondsRemaining = 10;
  // Cooldown after each fire — avoid re-firing on a stale tick before fills land.
  private readonly minTicksBetweenFires = 5;

  private ticksSinceLastFire = 999;
  private lastMarketTokens = "";

  onTick(tick: MarketTick, state: EngineState): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    // Reset cooldown when market rotates
    const currentTokens = `${upTokenId}:${downTokenId}`;
    if (currentTokens !== this.lastMarketTokens) {
      this.ticksSinceLastFire = 999;
      this.lastMarketTokens = currentTokens;
    }
    this.ticksSinceLastFire++;

    // Step 1: if we already hold both sides, MERGE them (Flavor A — gas only).
    const upPos = state.positions.get(upTokenId);
    const downPos = state.positions.get(downTokenId);
    if (upPos && downPos && upPos.shares >= CONFIG.MIN_MERGE_SIZE && downPos.shares >= CONFIG.MIN_MERGE_SIZE) {
      const mergeShares = Math.floor(Math.min(upPos.shares, downPos.shares));
      // The referee's merge finality guard will reject this if the candle is
      // about to settle — we don't double-check here; the rejection is silent
      // and we'll just hold both legs to settlement (each pays $1 on the
      // winning side, $0 on the losing side — same total payout as merge).
      return [this.merge(upTokenId, mergeShares, {
        note: `MergeArb Flavor A: ${mergeShares} pairs locked in @ $1`,
        signalSource: "merge_arb_sniper",
      })];
    }

    if (this.ticksSinceLastFire < this.minTicksBetweenFires) return [];

    const secsLeft = this.getSecondsRemaining();
    if (secsLeft >= 0 && secsLeft < this.minSecondsRemaining) return [];

    // Step 2: scan for an arb opportunity. Read both books directly — the
    // per-tick MarketTick only gives us one side at a time.
    const upBook = getBookForToken(upTokenId);
    const downBook = getBookForToken(downTokenId);
    const upAsk = upBook.asks[0]?.price;
    const downAsk = downBook.asks[0]?.price;
    if (!upAsk || !downAsk || upAsk <= 0 || downAsk <= 0) return [];

    const sum = upAsk + downAsk;
    if (sum >= this.maxAskSum) return [];

    // Need enough size on both books to fill our target trade
    const upSize = upBook.asks[0]?.size ?? 0;
    const downSize = downBook.asks[0]?.size ?? 0;
    if (upSize < this.tradeShares || downSize < this.tradeShares) return [];

    // Need enough cash for both legs
    const totalCost = (upAsk + downAsk) * this.tradeShares;
    if (state.cashBalance < totalCost) return [];

    this.ticksSinceLastFire = 0;

    const expectedProfit = (1 - sum) * this.tradeShares;

    return [
      this.buy(upTokenId, upAsk, this.tradeShares, {
        orderType: "taker",
        note: `MergeArb leg UP @ ${(upAsk * 100).toFixed(1)}¢, sum=${sum.toFixed(3)}, est=$${expectedProfit.toFixed(2)}`,
        signalSource: "merge_arb_sniper",
      }),
      this.buy(downTokenId, downAsk, this.tradeShares, {
        orderType: "taker",
        note: `MergeArb leg DOWN @ ${(downAsk * 100).toFixed(1)}¢, sum=${sum.toFixed(3)}`,
        signalSource: "merge_arb_sniper",
      }),
    ];
  }

  onRoundEnd(_state: EngineState): void {
    this.ticksSinceLastFire = 999;
    this.lastMarketTokens = "";
  }
}
