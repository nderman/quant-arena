/**
 * Phase 0 smoke test — validates risk manager, graduation, and dry run adapter.
 * No network calls, no signing. Run with: npx ts-node src/live/smokeTest.ts
 */

import { canTrade, RISK_CONFIG } from "./riskManager";
import { computeStats, passesCriteria, GRADUATION_CRITERIA } from "./graduation";
import { dryRunPlaceOrder, dryRunStats } from "./dryRunAdapter";
import { createLiveState } from "./liveState";
import type { EngineAction } from "../types";
import type { RoundHistoryEntry } from "../historyStore";

// Test helper: build a synthetic round entry
const round = (roundId: string, engineId: string, totalPnl: number): RoundHistoryEntry => ({
  roundId,
  allResults: [{
    engineId, totalPnl, tradeCount: 5,
    finalCash: 50 + totalPnl, positionValue: 0,
    feePaid: 0, slippageCost: 0, winRate: 0, sharpeRatio: 0,
  }],
});

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}

console.log("\n[smoke] Risk Manager");
{
  const state = createLiveState("test", "0xfake", 50, "R1");

  // Valid BUY
  const buy: EngineAction = { side: "BUY", tokenId: "tok1", price: 0.10, size: 20 };
  const r1 = canTrade(buy, state);
  check("valid BUY passes", r1.ok);

  // Order too big (size × price > 5% of 50 = $2.50)
  const tooBig: EngineAction = { side: "BUY", tokenId: "tok1", price: 0.10, size: 100 };
  const r2 = canTrade(tooBig, state);
  check("oversized BUY rejected", !r2.ok && r2.reason!.includes("exceeds max"));

  // Below min order
  const tooSmall: EngineAction = { side: "BUY", tokenId: "tok1", price: 0.01, size: 5 };
  const r3 = canTrade(tooSmall, state);
  check("undersized BUY rejected", !r3.ok && r3.reason!.includes("below min"));

  // MERGE without position rejected
  const mergeNoPos: EngineAction = { side: "MERGE", tokenId: "tok1", price: 0.10, size: 20 };
  const r4 = canTrade(mergeNoPos, state);
  check("MERGE without position rejected", !r4.ok && r4.reason!.includes("MERGE without"));

  // MERGE with position accepted (planMerge handles sizing)
  state.positions.set("tok1", { tokenId: "tok1", side: "YES", shares: 50, avgEntry: 0.10, costBasis: 5 } as any);
  const mergeOk: EngineAction = { side: "MERGE", tokenId: "tok1", price: 0.10, size: 20 };
  const r4b = canTrade(mergeOk, state);
  check("MERGE with position accepted", r4b.ok);
  state.positions.delete("tok1");

  // Daily loss hit
  state.dailyLossUsd = 51;
  const r5 = canTrade(buy, state);
  check("daily loss limit triggers", !r5.ok && r5.reason!.includes("daily loss"));
  state.dailyLossUsd = 0;

  // SELL without position (small enough to pass size cap)
  const sell: EngineAction = { side: "SELL", tokenId: "tok1", price: 0.20, size: 10 };
  const r6 = canTrade(sell, state);
  check("SELL without position rejected", !r6.ok && r6.reason!.includes("cannot sell"), r6.reason);

  // Paused engine
  state.paused = true;
  state.pauseReason = "test";
  const r7 = canTrade(buy, state);
  check("paused engine rejected", !r7.ok && r7.reason!.includes("paused"));
  state.paused = false;
}

console.log("\n[smoke] Graduation");
{
  // Build a synthetic round history
  const history: RoundHistoryEntry[] = [
    round("R1", "winner", 100), round("R2", "winner", 80),
    round("R3", "winner", -20), round("R4", "winner", 120),
    round("R5", "winner", 60), round("R6", "winner", 100),
    round("R7", "winner", 90), round("R8", "winner", -25),
    round("R9", "winner", 110), round("R10", "winner", 85),
  ];
  const stats = computeStats("winner", history);
  check("computes 10 rounds", stats.rounds === 10);
  check("computes cumulative > 500", stats.cumulativePnl > 500, `got ${stats.cumulativePnl}`);
  check("win rate ≥ 80%", stats.winRate >= 0.80);
  check("worst round = -25", stats.worstRound === -25);
  check("sharpe > 1", stats.sharpe > 1, `got ${stats.sharpe.toFixed(2)}`);

  const result = passesCriteria(stats);
  check("passes graduation", result.ok, result.reasons.join(", "));

  // Failing case: high variance
  const lossy: RoundHistoryEntry[] = [
    ...history.slice(0, 9),
    round("R10", "winner", -49),
  ];
  const lossyStats = computeStats("winner", lossy);
  const lossyResult = passesCriteria(lossyStats);
  check("rejects worst-round-too-low", !lossyResult.ok);
}

console.log("\n[smoke] Dry Run Adapter");
{
  const action: EngineAction = { side: "BUY", tokenId: "tok1", price: 0.10, size: 20 };
  const order = dryRunPlaceOrder(action);
  check("dry run order placed", order.status === "FILLED");
  const stats = dryRunStats();
  check("dry run tracks orders", stats.filled === 1);
}

console.log(`\n[smoke] ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
