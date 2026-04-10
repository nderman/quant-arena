/**
 * Quant Farm — Unit Tests
 *
 * Core validation for the referee's quartic fee model, toxic flow, and engine interface.
 */

import { calculateFee, calculateMergeFee, calculateFeeAdjustedEdge, cheaperExit } from "../referee";

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function approx(a: number, b: number, tolerance = 0.0001): boolean {
  return Math.abs(a - b) < tolerance;
}

// ── Quartic Fee Tests ───────────────────────────────────────────────────────
// fee = amount * 0.25 * (P * (1-P))^2
// Peaks at 1.5625% at P=0.50, drops off much faster than parabolic

console.log("\n=== Quartic Fee Model (2026) ===");

// At P=0.50: fee = 0.25 * 0.0625 = 1.5625%
const fee50 = calculateFee(0.50, 100);
assert(approx(fee50, 1.5625), `Fee at P=0.50: expected 1.5625, got ${fee50.toFixed(4)}`);
console.log(`  P=0.50: fee=$${fee50.toFixed(4)} on $100 (expected $1.5625)`);

// At P=0.90: fee = 0.25 * 0.0081 = 0.2025%
const fee90 = calculateFee(0.90, 100);
assert(approx(fee90, 0.2025), `Fee at P=0.90: expected 0.2025, got ${fee90.toFixed(4)}`);
console.log(`  P=0.90: fee=$${fee90.toFixed(4)} on $100 (expected $0.2025)`);

// At P=0.10, same as P=0.90 (symmetric)
const fee10 = calculateFee(0.10, 100);
assert(approx(fee10, fee90, 0.001), `Symmetry: P=0.10 should equal P=0.90`);
console.log(`  P=0.10: fee=$${fee10.toFixed(4)} (symmetric with P=0.90: $${fee90.toFixed(4)})`);

// At P=0.99: fee should be near zero
const fee99 = calculateFee(0.99, 100);
assert(fee99 < 0.01, `Fee at P=0.99: expected < $0.01, got ${fee99.toFixed(4)}`);
console.log(`  P=0.99: fee=$${fee99.toFixed(4)} on $100 (near zero)`);

// At P=0.01, same near-zero
const fee01 = calculateFee(0.01, 100);
assert(approx(fee01, fee99, 0.001), `Symmetry: P=0.01 should equal P=0.99`);
console.log(`  P=0.01: fee=$${fee01.toFixed(4)} (symmetric with P=0.99)`);

// Fee at P=0 should be near-zero (clamped to 0.001)
const fee0 = calculateFee(0, 100);
assert(fee0 < 0.01, `Fee at P=0: expected near-zero, got ${fee0}`);

// Fee at P=1 should be near-zero (clamped to 0.999)
const fee1 = calculateFee(1, 100);
assert(fee1 < 0.01, `Fee at P=1: expected near-zero, got ${fee1}`);

// Fee at P>1 must still be positive (no negative fee exploit)
const feeBad = calculateFee(500, 100);
assert(feeBad > 0, `Fee at P=500: must be positive, got ${feeBad}`);

// ── Merge Fee Tests ──────────────────────────────────────────────────────────

console.log("\n=== Merge Fee ===");

// Merge fee is now 0% by default (contract is free, just gas)
const mergeFee = calculateMergeFee(100);
assert(approx(mergeFee, 0), `Merge fee on $100: expected $0.00, got ${mergeFee.toFixed(4)}`);
console.log(`  Merge fee on $100: $${mergeFee.toFixed(4)} (contract is free, gas handled separately)`);

// ── Fee-Adjusted Edge Tests ──────────────────────────────────────────────────

console.log("\n=== Fee-Adjusted Edge ===");

// Model says 55%, market says 50% — 5% raw edge, but 1.5625% fee at 0.50
const edge1 = calculateFeeAdjustedEdge(0.55, 0.50);
assert(approx(edge1.rawEdge, 0.05), `Raw edge: 0.05`);
assert(approx(edge1.feeAtPrice, 0.015625), `Fee at 0.50: 1.5625%`);
assert(approx(edge1.netEdge, 0.034375), `Net edge: 3.4375%`);
assert(edge1.profitable, `Should be profitable`);
console.log(`  55% model vs 50% market: raw=${edge1.rawEdge.toFixed(3)}, fee=${edge1.feeAtPrice.toFixed(4)}, net=${edge1.netEdge.toFixed(4)} ✓`);

// Model says 51%, market says 50% — 1% raw edge, fee is 1.5625% → NOT profitable
const edge2 = calculateFeeAdjustedEdge(0.51, 0.50);
assert(!edge2.profitable, `1% edge at P=0.50 should NOT be profitable (fee=1.5625%)`);
console.log(`  51% model vs 50% market: raw=${edge2.rawEdge.toFixed(3)}, fee=${edge2.feeAtPrice.toFixed(4)}, net=${edge2.netEdge.toFixed(4)} — NOT profitable ✓`);

// Model says 96%, market says 95% — 1% edge, fee only 0.056% (quartic drops fast!)
const edge3 = calculateFeeAdjustedEdge(0.96, 0.95);
assert(edge3.profitable, `1% edge at P=0.95 SHOULD be profitable (fee tiny with quartic)`);
console.log(`  96% model vs 95% market: raw=${edge3.rawEdge.toFixed(3)}, fee=${edge3.feeAtPrice.toFixed(4)}, net=${edge3.netEdge.toFixed(4)} — profitable ✓`);

// ── Cheaper Exit Tests ───────────────────────────────────────────────────────

console.log("\n=== Cheaper Exit (SELL vs MERGE) ===");

// Without holdsOpposite, MERGE is forbidden (Flavor B was removed) — every
// price level must recommend SELL with mergeFee=Infinity.
const exit50_noOpp = cheaperExit(0.50, 100);
assert(exit50_noOpp.method === "SELL", `P=0.50 no-opposite must be SELL (got ${exit50_noOpp.method})`);
assert(exit50_noOpp.mergeFee === Number.POSITIVE_INFINITY, `P=0.50 no-opposite mergeFee must be Infinity`);
console.log(`  P=0.50 no-opp: ${exit50_noOpp.method} (mergeFee=${exit50_noOpp.mergeFee}) ✓`);

const exit95_noOpp = cheaperExit(0.95, 100);
assert(exit95_noOpp.method === "SELL", `P=0.95 no-opposite must be SELL`);
console.log(`  P=0.95 no-opp: ${exit95_noOpp.method} ✓`);

// With holdsOpposite=true, MERGE is Flavor A — gas + flat fee only. At P=0.50
// with quartic fees ~1.56%, merging should beat selling because the merge
// "fee" is just gas (~$0.04) vs sell fee on $50 proceeds.
const exit50_hasOpp = cheaperExit(0.50, 100, true);
assert(exit50_hasOpp.method === "MERGE", `P=0.50 with-opposite should prefer MERGE (Flavor A is gas-only)`);
assert(exit50_hasOpp.mergeFee < exit50_hasOpp.sellFee, `P=0.50 mergeFee must be < sellFee when held`);
console.log(`  P=0.50 with-opp: ${exit50_hasOpp.method} (sell=$${exit50_hasOpp.sellFee.toFixed(4)}, merge=$${exit50_hasOpp.mergeFee.toFixed(4)}) ✓`);

// At P=0.99 the sell fee is so tiny that even Flavor A merge isn't worth it.
const exit99_hasOpp = cheaperExit(0.99, 100, true);
assert(exit99_hasOpp.method === "SELL", `P=0.99 with-opposite should still prefer SELL (sell fee is near-zero, beats gas)`);
console.log(`  P=0.99 with-opp: ${exit99_hasOpp.method} (sell=$${exit99_hasOpp.sellFee.toFixed(4)}, merge=$${exit99_hasOpp.mergeFee.toFixed(4)}) ✓`);

// ── Fee Gradient (the quartic curve) ─────────────────────────────────────────

console.log("\n=== Fee Gradient (Quartic Curve) ===");
console.log("  Price | Fee %   | Fee on $100");
console.log("  ------|---------|------------");
for (const p of [0.01, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 0.99]) {
  const f = calculateFee(p, 100);
  const pct = (f / 100 * 100).toFixed(4);
  console.log(`  ${p.toFixed(2)}  | ${pct.padStart(7)}% | $${f.toFixed(4)}`);
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(40)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed ✓");
}
