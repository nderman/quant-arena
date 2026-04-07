/**
 * Quant Farm — Unit Tests
 *
 * Core validation for the referee's fee model, toxic flow, and engine interface.
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

// ── Parabolic Fee Tests ──────────────────────────────────────────────────────

console.log("\n=== Parabolic Fee Model ===");

// At P=0.50, fee should equal the peak rate (1.8%)
const fee50 = calculateFee(0.50, 100);
assert(approx(fee50, 1.80), `Fee at P=0.50: expected 1.80, got ${fee50.toFixed(4)}`);
console.log(`  P=0.50: fee=$${fee50.toFixed(4)} on $100 (expected $1.80)`);

// At P=0.90, fee should be ~0.648%
const fee90 = calculateFee(0.90, 100);
assert(approx(fee90, 0.648), `Fee at P=0.90: expected 0.648, got ${fee90.toFixed(4)}`);
console.log(`  P=0.90: fee=$${fee90.toFixed(4)} on $100 (expected $0.648)`);

// At P=0.10, same as P=0.90 (symmetric)
const fee10 = calculateFee(0.10, 100);
assert(approx(fee10, fee90, 0.001), `Symmetry: P=0.10 should equal P=0.90`);
console.log(`  P=0.10: fee=$${fee10.toFixed(4)} (symmetric with P=0.90: $${fee90.toFixed(4)})`);

// At P=0.99, fee should be ~0.0713%
const fee99 = calculateFee(0.99, 100);
assert(fee99 < 0.10, `Fee at P=0.99: expected < $0.10, got ${fee99.toFixed(4)}`);
console.log(`  P=0.99: fee=$${fee99.toFixed(4)} on $100 (near zero)`);

// At P=0.01, same near-zero
const fee01 = calculateFee(0.01, 100);
assert(approx(fee01, fee99, 0.001), `Symmetry: P=0.01 should equal P=0.99`);
console.log(`  P=0.01: fee=$${fee01.toFixed(4)} (symmetric with P=0.99)`);

// Fee at P=0 should be near-zero (clamped to 0.001 to prevent negative fees)
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

const mergeFee = calculateMergeFee(100);
assert(approx(mergeFee, 0.10), `Merge fee on $100: expected $0.10, got ${mergeFee.toFixed(4)}`);
console.log(`  Merge fee on $100: $${mergeFee.toFixed(4)} (flat 0.1%)`);

// ── Fee-Adjusted Edge Tests ──────────────────────────────────────────────────

console.log("\n=== Fee-Adjusted Edge ===");

// Model says 55%, market says 50% — 5% raw edge, but 1.8% fee at 0.50
const edge1 = calculateFeeAdjustedEdge(0.55, 0.50);
assert(approx(edge1.rawEdge, 0.05), `Raw edge: 0.05`);
assert(approx(edge1.feeAtPrice, 0.018), `Fee at 0.50: 1.8%`);
assert(approx(edge1.netEdge, 0.032), `Net edge: 3.2%`);
assert(edge1.profitable, `Should be profitable`);
console.log(`  55% model vs 50% market: raw=${edge1.rawEdge.toFixed(3)}, fee=${edge1.feeAtPrice.toFixed(3)}, net=${edge1.netEdge.toFixed(3)} ✓`);

// Model says 51%, market says 50% — 1% raw edge, but 1.8% fee eats it
const edge2 = calculateFeeAdjustedEdge(0.51, 0.50);
assert(!edge2.profitable, `1% edge at P=0.50 should NOT be profitable (fee=1.8%)`);
console.log(`  51% model vs 50% market: raw=${edge2.rawEdge.toFixed(3)}, fee=${edge2.feeAtPrice.toFixed(3)}, net=${edge2.netEdge.toFixed(3)} — NOT profitable ✓`);

// Model says 96%, market says 95% — 1% edge, fee only 0.34%
const edge3 = calculateFeeAdjustedEdge(0.96, 0.95);
assert(edge3.profitable, `1% edge at P=0.95 SHOULD be profitable (fee=0.34%)`);
console.log(`  96% model vs 95% market: raw=${edge3.rawEdge.toFixed(3)}, fee=${edge3.feeAtPrice.toFixed(3)}, net=${edge3.netEdge.toFixed(3)} — profitable ✓`);

// ── Cheaper Exit Tests ───────────────────────────────────────────────────────

console.log("\n=== Cheaper Exit (SELL vs MERGE) ===");

// At P=0.50: sell fee = 1.8%, merge requires buying NO at 0.50 + merge fee
const exit50 = cheaperExit(0.50, 100);
console.log(`  P=0.50: ${exit50.method} wins (sell=$${exit50.sellFee.toFixed(4)}, merge=$${exit50.mergeFee.toFixed(4)}, saves=$${exit50.savings.toFixed(4)})`);

// At P=0.95: sell fee = 0.34%, merge requires buying NO at 0.05
const exit95 = cheaperExit(0.95, 100);
console.log(`  P=0.95: ${exit95.method} wins (sell=$${exit95.sellFee.toFixed(4)}, merge=$${exit95.mergeFee.toFixed(4)}, saves=$${exit95.savings.toFixed(4)})`);

// At P=0.99: sell fee is near zero
const exit99 = cheaperExit(0.99, 100);
console.log(`  P=0.99: ${exit99.method} wins (sell=$${exit99.sellFee.toFixed(4)}, merge=$${exit99.mergeFee.toFixed(4)}, saves=$${exit99.savings.toFixed(4)})`);

// ── Fee Gradient (the parabolic curve) ───────────────────────────────────────

console.log("\n=== Fee Gradient (Parabolic Curve) ===");
console.log("  Price | Fee %   | Fee on $100");
console.log("  ------|---------|------------");
for (const p of [0.01, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 0.99]) {
  const f = calculateFee(p, 100);
  const pct = (f / 100 * 100).toFixed(3);
  console.log(`  ${p.toFixed(2)}  | ${pct.padStart(6)}% | $${f.toFixed(4)}`);
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(40)}`);
console.log(`Tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed ✓");
}
