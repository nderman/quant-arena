import { AbstractEngine } from "./BaseEngine";
import { MeanRevertEngine } from "./MeanRevertEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Disciplined Reverter — mean-revert-v1 with a hard trade-frequency cap.
 *
 * Hypothesis tested: Top losing engines all over-trade. mean-revert-v1 fires
 * 80-170+ trades per round across coins, paying $5-15 in fees and taking
 * 10-25 toxic flow hits per round. Top winners do 1-5 trades per round.
 *
 * Are mean-reverters losing because their *thesis* is wrong, or because they
 * over-trade? This engine answers that. It wraps mean-revert-v1's logic but
 * caps it at MAX_ENTRY_TRADES BUYs per round. Exits are not capped (we always
 * want to exit cleanly).
 *
 * If disciplined-reverter loses ~$5/round vs mean-revert-v1's ~$25/round,
 * over-trading is the bug. If it loses the same amount, the thesis is broken
 * regardless of frequency.
 *
 * Implementation: composition. Delegates to inner MeanRevertEngine, intercepts
 * its actions, and rejects BUY actions after the per-round limit is hit.
 * Exit actions (SELL/MERGE) always pass through.
 */
export class DisciplinedReverterEngine extends AbstractEngine {
  id = "disciplined-reverter-v1";
  name = "Disciplined Reverter";
  version = "1.0.0";

  private readonly maxEntryTrades = 5;
  private readonly inner = new MeanRevertEngine();

  // Per-round counter. Reset by onRoundEnd() — EngineState doesn't carry
  // a roundId, so the counter relies on the arena calling onRoundEnd
  // between rounds (which it does).
  private entryTradesThisRound = 0;

  init(state: EngineState): void {
    super.init(state);
    this.inner.init(state);
  }

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    const actions = this.inner.onTick(tick, state, signals);
    if (actions.length === 0) return actions;

    const filtered: EngineAction[] = [];
    for (const action of actions) {
      if (action.side === "BUY") {
        if (this.entryTradesThisRound >= this.maxEntryTrades) continue;
        this.entryTradesThisRound++;
        filtered.push({
          ...action,
          note: `[disciplined ${this.entryTradesThisRound}/${this.maxEntryTrades}] ${action.note ?? ""}`,
        });
      } else {
        // Always allow exits (SELL/MERGE/HOLD)
        filtered.push(action);
      }
    }
    return filtered;
  }

  onRoundEnd(state: EngineState): void {
    this.inner.onRoundEnd(state);
    this.entryTradesThisRound = 0;
  }
}
