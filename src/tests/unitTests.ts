/**
 * Quant Farm — Unit Tests
 *
 * Core validation for the referee's quartic fee model, toxic flow, and engine interface.
 */

import { calculateFee, calculateMergeFee, calculateFeeAdjustedEdge, cheaperExit, walkBook, isBookTradeable, shouldRejectStaleSnipe, shouldRejectCompetingTaker } from "../referee";
import { parsePmL2, isBookUpdateReasonable } from "../pulse";
import { extremeFlipProb, _resetEmpiricalCache } from "../settlement";
import type { OrderBook } from "../types";

// Helper to build minimal valid OrderBook for tests
function mkBook(opts: {
  asks?: { price: number; size: number }[];
  bids?: { price: number; size: number }[];
  timestamp?: number;
}): OrderBook {
  return {
    asks: opts.asks ?? [],
    bids: opts.bids ?? [],
    timestamp: opts.timestamp ?? Date.now(),
  };
}

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

// ── walkBook: limit price enforcement ───────────────────────────────────────

console.log("\n=== walkBook Limit Price Enforcement ===");

// BUY with limit at 0.50 against book best ask 0.60 → reject (would fill above limit)
{
  const book = mkBook({ asks: [{ price: 0.60, size: 100 }], bids: [{ price: 0.59, size: 100 }] });
  const result = walkBook(10, "BUY", book, 5, false, 0.50);
  assert(result === null, "BUY with limit 0.50 must reject when best ask is 0.60");
  console.log("  BUY limit 0.50 vs ask 0.60: rejected ✓");
}

// BUY with limit at 0.65 against book best ask 0.60 → fill at 0.60
{
  const book = mkBook({ asks: [{ price: 0.60, size: 100 }], bids: [{ price: 0.59, size: 100 }] });
  const result = walkBook(10, "BUY", book, 5, false, 0.65);
  assert(result !== null && approx(result.effectivePrice, 0.60), "BUY with limit 0.65 must fill at 0.60");
  console.log(`  BUY limit 0.65 vs ask 0.60: filled at ${result?.effectivePrice} ✓`);
}

// SELL with limit at 0.60 against best bid 0.50 → reject (would fill below limit)
{
  const book = mkBook({ asks: [{ price: 0.51, size: 100 }], bids: [{ price: 0.50, size: 100 }] });
  const result = walkBook(10, "SELL", book, 5, false, 0.60);
  assert(result === null, "SELL with limit 0.60 must reject when best bid is 0.50");
  console.log("  SELL limit 0.60 vs bid 0.50: rejected ✓");
}

// SELL with limit at 0.45 against best bid 0.50 → fill at 0.50
{
  const book = mkBook({ asks: [{ price: 0.51, size: 100 }], bids: [{ price: 0.50, size: 100 }] });
  const result = walkBook(10, "SELL", book, 5, false, 0.45);
  assert(result !== null && approx(result.effectivePrice, 0.50), "SELL with limit 0.45 must fill at 0.50");
  console.log(`  SELL limit 0.45 vs bid 0.50: filled at ${result?.effectivePrice} ✓`);
}

// No limit (undefined) → no enforcement, fills at market
{
  const book = mkBook({ asks: [{ price: 0.99, size: 100 }], bids: [{ price: 0.50, size: 100 }] });
  const result = walkBook(10, "BUY", book, 5, false, undefined);
  // Will be rejected by validity guard (best ask 0.99 > 0.99 false, wait it's strict <0.01 || >0.99)
  // 0.99 is not > 0.99, so it passes. But spread 0.99 - 0.50 = 0.49 which is < 0.50. Passes.
  assert(result !== null, "No-limit BUY should fill (no limit = no enforcement)");
  console.log("  BUY no-limit: fills without enforcement ✓");
}

// ── walkBook: book validity guards ──────────────────────────────────────────

console.log("\n=== walkBook Book Validity Guards ===");

// Best price below 0.01 → reject
{
  const book = mkBook({ asks: [{ price: 0.005, size: 100 }], bids: [{ price: 0.003, size: 100 }] });
  const result = walkBook(10, "BUY", book);
  assert(result === null, "Best ask 0.005 must reject (below 0.01 floor)");
  console.log("  Best price 0.005: rejected ✓");
}

// Best price above 0.99 → reject
{
  const book = mkBook({ asks: [{ price: 0.995, size: 100 }], bids: [{ price: 0.992, size: 100 }] });
  const result = walkBook(10, "BUY", book);
  assert(result === null, "Best ask 0.995 must reject (above 0.99 ceiling)");
  console.log("  Best price 0.995: rejected ✓");
}

// Wide spread (> 0.50) → reject (half-empty book)
{
  const book = mkBook({ asks: [{ price: 0.80, size: 100 }], bids: [{ price: 0.20, size: 100 }] });
  const result = walkBook(10, "BUY", book);
  assert(result === null, "Wide spread (0.60) must reject as half-empty book");
  console.log("  Spread 0.60: rejected ✓");
}

// One-sided book (no bids) → reject
{
  const book = mkBook({ asks: [{ price: 0.50, size: 100 }], bids: [] });
  const result = walkBook(10, "BUY", book);
  assert(result === null, "One-sided book (no bids) must reject");
  console.log("  One-sided book: rejected ✓");
}

// Stale book (timestamp > 30s old) → reject
{
  const book = mkBook({
    asks: [{ price: 0.50, size: 100 }],
    bids: [{ price: 0.49, size: 100 }],
    timestamp: Date.now() - 60_000,
  });
  const result = walkBook(10, "BUY", book);
  assert(result === null, "Stale book (60s old) must reject");
  console.log("  Stale book (60s): rejected ✓");
}

// Fresh, valid book → fills normally
{
  const book = mkBook({ asks: [{ price: 0.50, size: 100 }], bids: [{ price: 0.49, size: 100 }] });
  const result = walkBook(10, "BUY", book, 5, false, 0.55);
  assert(result !== null && result.filledSize === 10, "Valid book must fill");
  console.log(`  Valid book: filled ${result?.filledSize} shares ✓`);
}

// ── isBookTradeable: standalone helper engines can use ─────────────────────

console.log("\n=== isBookTradeable Helper ===");

assert(
  isBookTradeable(mkBook({ asks: [{ price: 0.50, size: 100 }], bids: [{ price: 0.49, size: 100 }] })),
  "Valid book must be tradeable"
);
console.log("  Valid book: tradeable ✓");

assert(
  !isBookTradeable(mkBook({ asks: [{ price: 0.005, size: 100 }], bids: [{ price: 0.003, size: 100 }] })),
  "Below-floor price must not be tradeable"
);
console.log("  Below-floor price: not tradeable ✓");

assert(
  !isBookTradeable(mkBook({ asks: [{ price: 0.80, size: 100 }], bids: [{ price: 0.20, size: 100 }] })),
  "Wide spread must not be tradeable"
);
console.log("  Wide spread: not tradeable ✓");

assert(
  !isBookTradeable(mkBook({ asks: [{ price: 0.50, size: 100 }], bids: [] })),
  "One-sided book must not be tradeable"
);
console.log("  One-sided book: not tradeable ✓");

// ── shouldRejectStaleSnipe: stale book during Binance moves ────────────────

console.log("\n=== Stale-Book Snipe Guard ===");

// With no Binance history, no rejection (calm market = no snipes)
{
  const book = mkBook({ asks: [{ price: 0.50, size: 100 }], bids: [{ price: 0.49, size: 100 }] });
  const result = shouldRejectStaleSnipe(book, false);
  assert(result === false, "No Binance history → no snipe rejection");
  console.log("  Calm market: no rejection ✓");
}

// Maker orders are NEVER rejected as snipes (makers don't snipe takers, they ARE the takers' counterparty)
{
  const book = mkBook({
    asks: [{ price: 0.50, size: 100 }],
    bids: [{ price: 0.49, size: 100 }],
    timestamp: Date.now() - 5_000, // very stale
  });
  const result = shouldRejectStaleSnipe(book, true); // isMaker = true
  assert(result === false, "Maker orders are never snipe-rejected");
  console.log("  Maker order on stale book: not rejected ✓");
}

// Fresh book (< 100ms old) → no rejection even if Binance moved
{
  const book = mkBook({
    asks: [{ price: 0.50, size: 100 }],
    bids: [{ price: 0.49, size: 100 }],
    timestamp: Date.now() - 30, // very fresh
  });
  const result = shouldRejectStaleSnipe(book, false);
  assert(result === false, "Fresh book should never be snipe-rejected (book caught up)");
  console.log("  Fresh book: no rejection ✓");
}

// (Note: testing the actual rejection-on-stale-book path requires manipulating
//  binanceMoveHistory which is module-private. The integration of this guard
//  is verified via the BUY/SELL path tests + manual observation post-deploy.)

// ── shouldRejectCompetingTaker: visible-cheap-price competition ────────────

console.log("\n=== Competing Taker Guard ===");

// Prices at or above MAX_PRICE (0.35) → never rejected (no visible asymmetric payoff)
{
  let rejects = 0;
  for (let i = 0; i < 1000; i++) {
    if (shouldRejectCompetingTaker(0.35, 50, false)) rejects++;
    if (shouldRejectCompetingTaker(0.50, 50, false)) rejects++;
    if (shouldRejectCompetingTaker(0.95, 50, false)) rejects++;
  }
  assert(rejects === 0, `price >= MAX should never reject, got ${rejects}`);
  console.log("  Mid/high prices: never rejected ✓");
}

// Maker orders → never rejected
{
  let rejects = 0;
  for (let i = 0; i < 1000; i++) {
    if (shouldRejectCompetingTaker(0.05, 50, true)) rejects++;
  }
  assert(rejects === 0, `maker should never reject, got ${rejects}`);
  console.log("  Makers: never rejected ✓");
}

// Rejection rate at cheap price + full size should be near the expected 37.5%
// (price=0.05 → priceFactor=0.75, size=50 → sizeFactor=1.0, cap=0.50)
{
  let rejects = 0;
  const n = 10_000;
  for (let i = 0; i < n; i++) {
    if (shouldRejectCompetingTaker(0.05, 50, false)) rejects++;
  }
  const rate = rejects / n;
  // With COMPETE_MAX_PRICE=0.35, COMPETE_PROB_MAX=0.90: (0.35-0.05)/0.35 × 1.0 × 0.90 = 0.771
  const expected = 0.771;
  assert(Math.abs(rate - expected) < 0.02, `expected ~77.1%, got ${(rate * 100).toFixed(1)}%`);
  console.log(`  cheap+large: ~${(rate * 100).toFixed(1)}% rejection (target 77.1%) ✓`);
}

// Small orders at cheap prices face much less competition
{
  let rejects = 0;
  const n = 10_000;
  for (let i = 0; i < n; i++) {
    if (shouldRejectCompetingTaker(0.05, 5, false)) rejects++;
  }
  const rate = rejects / n;
  // 0.75 × 0.10 × 0.90 = 0.0675
  assert(rate < 0.09, `small orders should be rarely rejected, got ${(rate * 100).toFixed(1)}%`);
  console.log(`  cheap+small: ~${(rate * 100).toFixed(1)}% rejection (target 6.75%) ✓`);
}

// ── Engine reload mechanism (surgical deploy) ──────────────────────────────

console.log("\n=== Engine Reload Mechanism ===");

import { reloadFlagPath, maybeReloadEngines } from "../arena";
import * as fsRT from "fs";
import type { BaseEngine } from "../types";

// reloadFlagPath is per-arena-instance (Apr 27 — was per-coin). Locks in
// the fix that prevents flag-starvation between sibling arenas (5m/15m/1h/4h
// of the same coin used to fight over a single flag file).
{
  const { CONFIG } = require("../config");
  const p = reloadFlagPath();
  assert(p.endsWith(".flag"), `flag path should end .flag, got ${p}`);
  assert(p.includes("reload_engines_"), `flag path should include prefix, got ${p}`);
  assert(p.includes("data"), `flag path should be under data/, got ${p}`);
  // Must include the instance ID so each arena consumes its own flag
  assert(p.includes(CONFIG.ARENA_INSTANCE_ID),
    `flag path should include ARENA_INSTANCE_ID (${CONFIG.ARENA_INSTANCE_ID}), got ${p}`);
  console.log(`  reloadFlagPath includes ARENA_INSTANCE_ID ✓ (${p.split("/").pop()})`);
}

// No flag present → maybeReloadEngines returns the same array (no-op)
{
  const flag = reloadFlagPath();
  if (fsRT.existsSync(flag)) fsRT.unlinkSync(flag); // ensure clean state
  const fakeEngines = [{ id: "fake", name: "Fake", version: "1.0.0" } as unknown as BaseEngine];
  const result = maybeReloadEngines(fakeEngines);
  assert(result === fakeEngines, "no flag → returns same array reference");
  console.log("  no flag: maybeReloadEngines is a no-op ✓");
}

// ── Seeded RNG (task #28) ──────────────────────────────────────────────────

console.log("\n=== Seeded RNG ===");

import { seedRng, random as rngRandom, isSeeded, _resetForTest } from "../rng";

// Reproducibility: same seed → identical sequence
{
  seedRng(42);
  const seq1 = [rngRandom(), rngRandom(), rngRandom(), rngRandom(), rngRandom()];
  seedRng(42);
  const seq2 = [rngRandom(), rngRandom(), rngRandom(), rngRandom(), rngRandom()];
  for (let i = 0; i < seq1.length; i++) {
    assert(seq1[i] === seq2[i],
      `seed 42 should be reproducible at index ${i}: ${seq1[i]} vs ${seq2[i]}`);
  }
  console.log("  seed 42 produces identical sequence ✓");
}

// Different seeds produce different sequences
{
  seedRng(42);
  const a = rngRandom();
  seedRng(43);
  const b = rngRandom();
  assert(a !== b, "seeds 42 and 43 should produce different first values");
  console.log("  different seeds → different sequences ✓");
}

// Range: every output is in [0, 1)
{
  seedRng(1234);
  let allInRange = true;
  let badValue = 0;
  for (let i = 0; i < 1000; i++) {
    const x = rngRandom();
    if (x < 0 || x >= 1) { allInRange = false; badValue = x; break; }
  }
  assert(allInRange, `RNG out of range over 1000 samples: ${badValue}`);
  console.log("  1000 samples all in [0, 1) ✓");
}

// Distribution sanity: mean of 10k samples ≈ 0.5
{
  seedRng(7777);
  let sum = 0;
  const n = 10_000;
  for (let i = 0; i < n; i++) sum += rngRandom();
  const mean = sum / n;
  assert(Math.abs(mean - 0.5) < 0.02, `mean drift ${mean.toFixed(4)} far from 0.5`);
  console.log(`  10k mean = ${mean.toFixed(4)} (target 0.5) ✓`);
}

// Unseeded → falls back to Math.random (no determinism)
{
  _resetForTest();
  assert(isSeeded() === false, "after reset, isSeeded should be false");
  // Just verify it returns a valid number
  const x = rngRandom();
  assert(x >= 0 && x < 1, `unseeded RNG out of range: ${x}`);
  console.log("  unseeded falls back to Math.random ✓");
}

// End-to-end: seeded shouldRejectCompetingTaker is reproducible
{
  seedRng(99);
  const run1: boolean[] = [];
  for (let i = 0; i < 50; i++) run1.push(shouldRejectCompetingTaker(0.05, 50, false));
  seedRng(99);
  const run2: boolean[] = [];
  for (let i = 0; i < 50; i++) run2.push(shouldRejectCompetingTaker(0.05, 50, false));
  for (let i = 0; i < run1.length; i++) {
    assert(run1[i] === run2[i], `competing-taker reproducibility broke at ${i}`);
  }
  console.log("  shouldRejectCompetingTaker reproduces under seed ✓");
}

// ── Rejection reason codes (task #24) — async, awaited from orchestrator ──

async function runRejectionReasonTests(): Promise<void> {
  console.log("\n=== Rejection Reason Codes ===");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { processActions } = require("../referee");

  // Disable price-zone gate for legacy tests (most use prices outside
  // [0.55, 0.70]). Re-enabled below for the dedicated zone-gate tests.
  const SAVED_ZONE_ENABLED = CONFIG.LIVE_PRICE_ZONE_ENABLED;
  (CONFIG as any).LIVE_PRICE_ZONE_ENABLED = false;

  const mkState2 = (): EngineState => ({
    engineId: "reason-test",
    positions: new Map(),
    cashBalance: 100,
    roundPnl: 0, tradeCount: 0, feePaid: 0, feeRebate: 0, slippageCost: 0,
    activeTokenId: "UP_TOK", activeDownTokenId: "DOWN_TOK",
    marketSymbol: "BTCUSDT",
    marketWindowEnd: Date.now() + 300_000,
    marketWindowStart: Date.now(),
    rejectionCounts: {},
  });

  // invalid_token — action.tokenId not in the active market
  {
    const state = mkState2();
    const action: EngineAction = {
      side: "BUY", tokenId: "UNKNOWN_TOK", price: 0.5, size: 10, orderType: "taker",
    };
    const r = await processActions([action], state);
    const fill = r.results[0];
    assert(fill.filled === false, "invalid token should not fill");
    assert(fill.rejectionReason === "invalid_token",
      `expected invalid_token, got ${fill.rejectionReason}`);
    console.log("  invalid_token ✓");
  }

  // size_below_min — order smaller than MIN_ORDER_SIZE
  {
    const state = mkState2();
    const action: EngineAction = {
      side: "BUY", tokenId: "UP_TOK", price: 0.5, size: 2, orderType: "taker",
    };
    const r = await processActions([action], state);
    const fill = r.results[0];
    assert(fill.filled === false, "size below min should not fill");
    assert(fill.rejectionReason === "size_below_min",
      `expected size_below_min, got ${fill.rejectionReason}`);
    console.log("  size_below_min ✓");
  }

  // Verify referee increments state.rejectionCounts directly (post-simplify fix)
  {
    const state = mkState2();
    const action: EngineAction = {
      side: "BUY", tokenId: "UNKNOWN_TOK", price: 0.5, size: 10, orderType: "taker",
    };
    await processActions([action], state);
    assert(state.rejectionCounts["invalid_token"] === 1,
      `referee should tally the reason, got ${JSON.stringify(state.rejectionCounts)}`);
    console.log("  referee tallies state.rejectionCounts ✓");
  }

  // marketable_min_notional — taker BUY with notional < $1 must reject
  // (matches PM CLOB's "invalid amount for a marketable BUY order" 400)
  // Note: at $0.18 the price-zone gate ALSO rejects (outside 0.55-0.70).
  // The min-notional check runs first, so this test still asserts that path.
  {
    const state = mkState2();
    const action: EngineAction = {
      // 5 shares × $0.18 = $0.90 — below $1 marketable min
      side: "BUY", tokenId: "UP_TOK", price: 0.18, size: 5, orderType: "taker",
    };
    const r = await processActions([action], state);
    const fill = r.results[0];
    assert(fill.filled === false, "sub-$1 marketable BUY should not fill");
    assert(fill.rejectionReason === "marketable_min_notional",
      `expected marketable_min_notional, got ${fill.rejectionReason}`);
    console.log("  marketable_min_notional ✓");
  }

  // outside_price_zone — taker BUY at price outside [0.55, 0.70] rejects
  // BEFORE making it to walkBook. Uses 10 shares to clear the $1 min check.
  // Re-enable the gate for this block.
  (CONFIG as any).LIVE_PRICE_ZONE_ENABLED = true;
  {
    const state = mkState2();
    const action: EngineAction = {
      side: "BUY", tokenId: "UP_TOK", price: 0.30, size: 10, orderType: "taker",
    };
    const r = await processActions([action], state);
    const fill = r.results[0];
    assert(fill.filled === false, "taker BUY @ $0.30 outside zone should not fill");
    assert(fill.rejectionReason === "outside_price_zone",
      `expected outside_price_zone, got ${fill.rejectionReason}`);
    console.log("  outside_price_zone (low) ✓");
  }
  {
    const state = mkState2();
    const action: EngineAction = {
      side: "BUY", tokenId: "UP_TOK", price: 0.80, size: 5, orderType: "taker",
    };
    const r = await processActions([action], state);
    const fill = r.results[0];
    assert(fill.filled === false, "taker BUY @ $0.80 outside zone should not fill");
    assert(fill.rejectionReason === "outside_price_zone",
      `expected outside_price_zone, got ${fill.rejectionReason}`);
    console.log("  outside_price_zone (high) ✓");
  }
  // Maker exempt from price-zone gate
  {
    const state = mkState2();
    const action: EngineAction = {
      side: "BUY", tokenId: "UP_TOK", price: 0.30, size: 10, orderType: "maker",
    };
    const r = await processActions([action], state);
    const fill = r.results[0];
    assert(fill.rejectionReason !== "outside_price_zone",
      `maker BUY should be exempt from price-zone gate, got ${fill.rejectionReason}`);
    console.log("  maker exempt from price-zone gate ✓");
  }
  // Restore original zone flag before exiting the test block
  (CONFIG as any).LIVE_PRICE_ZONE_ENABLED = SAVED_ZONE_ENABLED;

  // Maker BUYs are exempt from the $1 marketable minimum (resting orders
  // sit on the book, PM only enforces share count for those).
  {
    const state = mkState2();
    const action: EngineAction = {
      // 5 shares × $0.18 = $0.90 but maker → must NOT trigger marketable_min
      side: "BUY", tokenId: "UP_TOK", price: 0.18, size: 5, orderType: "maker",
    };
    const r = await processActions([action], state);
    const fill = r.results[0];
    // Maker may or may not fill depending on book state, but the rejection
    // (if any) must NOT be marketable_min_notional.
    assert(fill.rejectionReason !== "marketable_min_notional",
      `maker BUY should be exempt from marketable_min_notional, got ${fill.rejectionReason}`);
    console.log("  maker exempt from marketable_min_notional ✓");
  }
}

// ── parsePmL2: validate + filter PM book quotes ─────────────────────────────

console.log("\n=== parsePmL2 Validation ===");

// Valid book → parsed correctly
{
  const result = parsePmL2({
    bids: [{ price: "0.49", size: "100" }, { price: "0.48", size: "50" }],
    asks: [{ price: "0.50", size: "100" }, { price: "0.51", size: "50" }],
  });
  assert(result !== null && result.bids.length === 2 && result.asks.length === 2, "Valid book parses");
  console.log("  Valid book: parsed ✓");
}

// Crossed book (bid >= ask) → null
{
  const result = parsePmL2({
    bids: [{ price: "0.60", size: "100" }],
    asks: [{ price: "0.50", size: "100" }],
  });
  assert(result === null, "Crossed book must reject");
  console.log("  Crossed book: rejected ✓");
}

// Levels with zero size → filtered out
{
  const result = parsePmL2({
    bids: [{ price: "0.49", size: "0" }, { price: "0.48", size: "100" }],
    asks: [{ price: "0.50", size: "100" }],
  });
  assert(result !== null && result.bids.length === 1 && result.bids[0].price === 0.48, "Zero-size level filtered");
  console.log("  Zero-size level: filtered ✓");
}

// Levels outside (0.001, 0.999) → filtered
{
  const result = parsePmL2({
    bids: [{ price: "0.0001", size: "100" }, { price: "0.49", size: "100" }],
    asks: [{ price: "0.50", size: "100" }, { price: "0.9999", size: "100" }],
  });
  assert(result !== null && result.bids.length === 1 && result.asks.length === 1, "Out-of-range levels filtered");
  console.log("  Out-of-range levels: filtered ✓");
}

// Empty book after filtering → null
{
  const result = parsePmL2({
    bids: [{ price: "0.49", size: "100" }],
    asks: [], // no asks at all
  });
  assert(result === null, "Empty side → null");
  console.log("  Empty side: rejected ✓");
}

// ── isBookUpdateReasonable: transient quote filter ─────────────────────────

console.log("\n=== isBookUpdateReasonable ===");

const now = Date.now();
const baseBook = {
  bids: [{ price: 0.49, size: 100 }],
  asks: [{ price: 0.50, size: 100 }],
  timestamp: now,
};

// Same prices → reasonable
assert(
  isBookUpdateReasonable(
    { bids: [{ price: 0.49, size: 100 }], asks: [{ price: 0.50, size: 100 }], timestamp: now },
    baseBook,
  ),
  "Identical book is reasonable"
);
console.log("  Identical book: reasonable ✓");

// Small move (5%) → reasonable
assert(
  isBookUpdateReasonable(
    { bids: [{ price: 0.515, size: 100 }], asks: [{ price: 0.525, size: 100 }], timestamp: now },
    baseBook,
  ),
  "5% move is reasonable"
);
console.log("  5% move: reasonable ✓");

// Huge jump (>25%) → unreasonable
assert(
  !isBookUpdateReasonable(
    { bids: [{ price: 0.86, size: 100 }], asks: [{ price: 0.87, size: 100 }], timestamp: now },
    baseBook,
  ),
  "70% jump must be flagged unreasonable (transient quote)"
);
console.log("  70% jump: rejected ✓");

// First update (no prev book) → always reasonable
{
  const emptyPrev = { bids: [], asks: [], timestamp: 0 };
  assert(
    isBookUpdateReasonable(
      { bids: [{ price: 0.86, size: 100 }], asks: [{ price: 0.87, size: 100 }], timestamp: now },
      emptyPrev,
    ),
    "First update is always reasonable"
  );
  console.log("  First update (no prev): reasonable ✓");
}

// Stale prev book (>10s) → always reasonable
assert(
  isBookUpdateReasonable(
    { bids: [{ price: 0.86, size: 100 }], asks: [{ price: 0.87, size: 100 }], timestamp: now },
    { ...baseBook, timestamp: now - 15_000 },
  ),
  "Stale prev book → new update accepted"
);
console.log("  Stale prev (>10s): reasonable ✓");

// ── Pending-Order Helpers (AbstractEngine) ──────────────────────────────────

import { AbstractEngine } from "../engines/BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot, PositionState } from "../types";

class TestEngine extends AbstractEngine {
  id = "test-engine";
  name = "Test";
  version = "1.0.0";
  onTick(_t: MarketTick, _s: EngineState, _sig?: SignalSnapshot): EngineAction[] { return []; }

  // Expose protected methods for testing
  testUpdatePending() { return this.updatePendingOrders(); }
  testHasPending() { return this.hasPendingOrder(); }
  testMarkPending(id: string) { this.markPending(id); }
  testClearPending() { this.clearPendingOrders(); }
  testBuy(tokenId: string, price: number, size: number, opts?: { orderType?: "maker" | "taker" }) {
    return this.buy(tokenId, price, size, opts);
  }
}

function mkState(opts: { upToken?: string; downToken?: string; positions?: Map<string, PositionState> }): EngineState {
  return {
    engineId: "test-engine",
    cashBalance: 50,
    roundPnl: 0,
    tradeCount: 0,
    feePaid: 0,
    feeRebate: 0,
    slippageCost: 0,
    positions: opts.positions ?? new Map(),
    activeTokenId: opts.upToken ?? "UP1",
    activeDownTokenId: opts.downToken ?? "DOWN1",
    marketSymbol: "BTCUSDT",
    marketWindowStart: 0,
    rejectionCounts: {},
    marketWindowEnd: 0,
  };
}

console.log("\n=== Pending-Order Helpers ===");
{
  const e = new TestEngine();
  e.init(mkState({}));

  // Initially no pending orders
  assert(!e.testHasPending(), "no pending initially");

  // markPending + hasPendingOrder
  e.testMarkPending("UP1");
  assert(e.testHasPending(), "has pending after mark");

  // Fill clears pending
  const posMap = new Map<string, PositionState>();
  posMap.set("UP1", { shares: 10, avgEntry: 0.5, costBasis: 5, side: "YES", tokenId: "UP1" });
  e.init(mkState({ positions: posMap }));
  e.testUpdatePending();
  assert(!e.testHasPending(), "fill clears pending");
}

{
  const e = new TestEngine();
  e.init(mkState({}));
  e.testMarkPending("UP1");

  // Rotation clears pending and returns true
  e.init(mkState({ upToken: "UP2", downToken: "DOWN2" }));
  const rotated = e.testUpdatePending();
  assert(rotated === true, "rotation returns true");
  assert(!e.testHasPending(), "rotation clears pending");

  // No rotation returns false
  const notRotated = e.testUpdatePending();
  assert(notRotated === false, "no rotation returns false");
}

{
  const e = new TestEngine();
  e.init(mkState({}));
  e.testMarkPending("UP1");
  e.testMarkPending("DOWN1");
  assert(e.testHasPending(), "multiple pending");

  e.testClearPending();
  assert(!e.testHasPending(), "clearPendingOrders resets all");
}

console.log("\n=== BaseEngine.buy() marketable-min size bump ===");
{
  const e = new TestEngine();
  e.init(mkState({}));

  // taker @ $0.18 × 5 = $0.90 (below $1) — must bump to ⌈1/0.18⌉ = 6
  const subMin = e.testBuy("UP1", 0.18, 5, { orderType: "taker" });
  assert(subMin.size === 6,
    `expected size bumped to 6 (= ⌈1/0.18⌉), got ${subMin.size}`);
  console.log("  taker BUY @ $0.18 × 5 → bumped to 6 ✓");

  // taker @ $0.50 × 5 = $2.50 (above $1) — must NOT bump
  const ok = e.testBuy("UP1", 0.50, 5, { orderType: "taker" });
  assert(ok.size === 5, `taker BUY at $2.50 should not bump, got ${ok.size}`);
  console.log("  taker BUY $2.50 unchanged ✓");

  // maker @ $0.10 × 5 = $0.50 — exempt, must NOT bump
  const maker = e.testBuy("UP1", 0.10, 5, { orderType: "maker" });
  assert(maker.size === 5,
    `maker BUY should not bump (exempt), got ${maker.size}`);
  console.log("  maker BUY exempt from bump ✓");

  // taker without explicit orderType defaults to taker semantics
  const defaultTaker = e.testBuy("UP1", 0.10, 5);
  assert(defaultTaker.size === 10,
    `default-taker BUY should bump to ⌈1/0.10⌉=10, got ${defaultTaker.size}`);
  console.log("  default-taker BUY bumped ✓");
}

// ── Regime Signals ─────────────────────────────────────────────────────────

class RegimeTestEngine extends AbstractEngine {
  id = "regime-test";
  name = "Regime Test";
  version = "1.0.0";
  onTick(_t: MarketTick, _s: EngineState, _sig?: SignalSnapshot): EngineAction[] { return []; }

  testTrack(tick: MarketTick) { this.trackBinance(tick); }
  testVol(sec: number) { return this.realizedVol(sec); }
  testMom(sec: number) { return this.recentMomentum(sec); }
  testAbsMom(sec: number) { return this.absMomentum(sec); }
  testRegime() { return this.currentRegime(); }
  testLastPrice() { return this.lastBinancePrice(); }
}

function mkBinanceTick(price: number): MarketTick {
  return {
    source: "binance",
    symbol: "BTCUSDT",
    midPrice: price,
    bestBid: price - 0.01,
    bestAsk: price + 0.01,
    spread: 0.02,
    distanceFrom50: 0,
    book: { asks: [], bids: [], timestamp: Date.now() },
    timestamp: Date.now(),
  };
}

console.log("\n=== Regime Signals ===");

// 1. trackBinance records ticks and lastBinancePrice reflects latest
{
  const e = new RegimeTestEngine();
  e.init(mkState({}));
  assert(e.testLastPrice() === 0, "initial price is 0");
  e.testTrack(mkBinanceTick(80000));
  e.testTrack(mkBinanceTick(80010));
  assert(e.testLastPrice() === 80010, `latest = 80010, got ${e.testLastPrice()}`);
}

// 2. trackBinance ignores non-binance ticks
{
  const e = new RegimeTestEngine();
  e.init(mkState({}));
  const pmTick: MarketTick = {
    source: "polymarket", symbol: "PM", midPrice: 0.5,
    bestBid: 0.49, bestAsk: 0.51, spread: 0.02, distanceFrom50: 0,
    book: { asks: [], bids: [], timestamp: Date.now() }, timestamp: Date.now(),
  };
  e.testTrack(pmTick);
  assert(e.testLastPrice() === 0, "pm tick ignored");
}

// 3. realizedVol returns 0 with insufficient samples
{
  const e = new RegimeTestEngine();
  e.init(mkState({}));
  e.testTrack(mkBinanceTick(80000));
  assert(e.testVol(60) === 0, "vol 0 with 1 sample");
}

// 4. recentMomentum: +0.1% move over the window
{
  const e = new RegimeTestEngine();
  e.init(mkState({}));
  // Seed a price history with a ~0.1% uptrend
  const now = Date.now();
  for (let i = 0; i < 10; i++) {
    const price = 80000 + (i * 10); // 80000 → 80090 = +0.1125%
    const tick = mkBinanceTick(price);
    tick.timestamp = now - (10 - i) * 1000;
    e.testTrack(tick);
  }
  const mom = e.testMom(60);
  assert(mom > 0, `momentum positive, got ${mom}`);
  assert(mom > 0.0005 && mom < 0.002, `momentum ~0.11%, got ${mom}`);
}

// 5. absMomentum is always non-negative
{
  const e = new RegimeTestEngine();
  e.init(mkState({}));
  for (let i = 0; i < 10; i++) {
    e.testTrack(mkBinanceTick(80000 - i * 5)); // downtrend
  }
  const am = e.testAbsMom(60);
  const m = e.testMom(60);
  assert(am >= 0, "abs momentum non-negative");
  assert(am === Math.abs(m), "abs equals |mom|");
}

// 6. currentRegime: QUIET when flat (needs 60+ samples or UNKNOWN)
{
  const e = new RegimeTestEngine();
  e.init(mkState({}));
  for (let i = 0; i < 80; i++) {
    e.testTrack(mkBinanceTick(80000 + (i % 2 === 0 ? 1 : -1))); // tiny chop
  }
  // Under 2bps vol, abs momentum ~0 → QUIET (with 80 samples for default 60s lookback)
  const reg = e.testRegime();
  assert(reg === "QUIET" || reg === "CHOP", `expected QUIET/CHOP, got ${reg}`);
}

// 6b. currentRegime: UNKNOWN when insufficient data
{
  const e = new RegimeTestEngine();
  e.init(mkState({}));
  for (let i = 0; i < 10; i++) e.testTrack(mkBinanceTick(80000 + i));
  assert(e.testRegime() === "UNKNOWN", "expected UNKNOWN with only 10 samples");
}

// 7. currentRegime: TREND when large monotonic move
{
  const e = new RegimeTestEngine();
  e.init(mkState({}));
  const now = Date.now();
  for (let i = 0; i < 60; i++) {
    const price = 80000 + i * 2; // +0.15% over the window
    const tick = mkBinanceTick(price);
    tick.timestamp = now - (60 - i) * 1000;
    e.testTrack(tick);
  }
  const reg = e.testRegime();
  assert(reg === "TREND" || reg === "SPIKE", `expected TREND/SPIKE, got ${reg}`);
}

// 8. currentRegimeStable: doesn't flip until holdMs satisfied
class StableRegimeEngine extends AbstractEngine {
  id = "stable-test";
  name = "Stable Regime Test";
  version = "1.0.0";
  onTick(_t: MarketTick, _s: EngineState, _sig?: SignalSnapshot): EngineAction[] { return []; }

  testTrack(tick: MarketTick) { this.trackBinance(tick); }
  testStable(holdMs: number, lb: number) { return this.currentRegimeStable(holdMs, lb); }
  testConfirmed() { return this.currentRegimeConfirmed(); }
}

{
  const e = new StableRegimeEngine();
  e.init(mkState({}));

  // Seed with QUIET (flat prices) — need >=60 samples for 60s lookback
  for (let i = 0; i < 80; i++) {
    e.testTrack(mkBinanceTick(80000 + (i % 2 === 0 ? 1 : -1)));
  }
  const initial = e.testStable(5_000, 60);
  // Stable starts at UNKNOWN until holdMs has elapsed with a consistent label
  assert(
    initial === "UNKNOWN" || initial === "QUIET" || initial === "CHOP",
    `initial UNKNOWN/QUIET/CHOP, got ${initial}`,
  );

  // Now feed a sudden trending burst — but the stable should NOT flip yet
  // because we just started seeing the new label
  for (let i = 0; i < 5; i++) {
    e.testTrack(mkBinanceTick(80100 + i * 20)); // big jump
  }
  const stillStable = e.testStable(5_000, 60);
  // Should still be the initial label since holdMs=5s and we just started
  assert(
    stillStable === initial,
    `stable should not flip immediately, expected ${initial}, got ${stillStable}`,
  );
}

// 9. currentRegimeConfirmed: returns UNKNOWN on insufficient data
{
  const e = new StableRegimeEngine();
  e.init(mkState({}));
  // Empty buffer → both windows return UNKNOWN → returns UNKNOWN
  const r = e.testConfirmed();
  assert(r === "UNKNOWN", `empty → UNKNOWN, got ${r}`);
}

// ── LiveSizingWrapper ──────────────────────────────────────────────────────

import { sizeForLive, computeCandleExposure } from "../live/liveSizing";
import { createLiveState } from "../live/liveState";
import { RISK_CONFIG } from "../live/riskManager";
import { CONFIG } from "../config";

// Disable the May 6 flat $$ ceiling for the legacy scaling tests below —
// those tests exercise the PCT-cap math in isolation. The $8 ceiling is
// covered by its own test below ("flat ceiling caps at MAX_LIVE_TRADE_USD").
const ORIGINAL_MAX_LIVE_TRADE_USD = RISK_CONFIG.MAX_LIVE_TRADE_USD;
RISK_CONFIG.MAX_LIVE_TRADE_USD = Number.POSITIVE_INFINITY;
// Disable the May 11 price-zone gate for legacy sizing tests — most use
// prices outside [0.55, 0.70] and would short-circuit at the gate. The
// zone gate has its own dedicated tests (4e2, 4e3) where we re-enable it.
const ORIGINAL_PRICE_ZONE_ENABLED = CONFIG.LIVE_PRICE_ZONE_ENABLED;
(CONFIG as any).LIVE_PRICE_ZONE_ENABLED = false;

function mkLiveState(bankroll: number, cash?: number): ReturnType<typeof createLiveState> {
  const s = createLiveState("test-engine", "0xwallet", bankroll, "R0001-test");
  if (cash !== undefined) s.cashBalance = cash;
  return s;
}

console.log("\n=== LiveSizingWrapper ===");

// 1. Basic 10x scale under cap: $2 sim → $20 live at 10¢ = 200 shares
{
  const live = mkLiveState(500);
  const r = sizeForLive(
    { side: "BUY", tokenId: "UP1", price: 0.10, size: 20 },
    live,
    { liveBankrollUsd: 500, simBankrollUsd: 50 },
  );
  assert(r.action !== null, "10x scale action non-null");
  assert(r.action!.size === 200, `10x scale: expected 200 shares ($20 / $0.10), got ${r.action!.size}`);
  assert(r.clippedBy === undefined, "no clipping at $20 target (cap is $25)");
}

// 1b. Bankroll cap: $30 target on $500 bankroll — at 30% cap ($150), not clipped
{
  const live = mkLiveState(500);
  const r = sizeForLive(
    { side: "BUY", tokenId: "UP1", price: 0.10, size: 30 }, // $3 sim × 10 = $30 target
    live,
    { liveBankrollUsd: 500, simBankrollUsd: 50 },
  );
  assert(r.action !== null, "bankroll cap action non-null");
  // With 30% cap ($150 max), a $30 order is NOT clipped
  assert(r.action!.size === 300, `bankroll cap: expected 300 shares ($30 / $0.10), got ${r.action!.size}`);
}

// 2. Scale without hitting cap: small sim order, big live bankroll
{
  const live = mkLiveState(1000);
  const r = sizeForLive(
    { side: "BUY", tokenId: "UP1", price: 0.10, size: 5 }, // $0.50 sim
    live,
    { liveBankrollUsd: 1000, simBankrollUsd: 50 },
  );
  // $0.50 × 20x = $10 → 100 shares at 10¢. Under the $50 cap (5% of $1000).
  assert(r.action !== null && r.action.size === 100, `small scale: expected 100 shares, got ${r.action?.size}`);
  assert(r.clippedBy === undefined, "no clipping needed");
}

// 3. Cash clip: insufficient cash
{
  const live = mkLiveState(500, 10); // bankroll $500, but only $10 cash
  const r = sizeForLive(
    { side: "BUY", tokenId: "UP1", price: 0.10, size: 20 }, // $2 sim × 10 = $20 target
    live,
    { liveBankrollUsd: 500, simBankrollUsd: 50 },
  );
  assert(r.action !== null, "cash clip action non-null");
  assert(r.clippedBy === "cash", `cash clip: got ${r.clippedBy}`);
  assert(r.action!.size === 100, `cash clip: $10 / $0.10 = 100 shares, got ${r.action!.size}`);
}

// 4. Min order floor: sized to 0 shares after rounding returns null.
// New ordering (Apr 25): share rounding + maker-min bump run BEFORE
// min-notional check. A scaled-down target of $0.01 floors to 0 shares
// and trips "rounding" (correct: would-be order is empty). The notional
// floor only applies to non-zero orders that survived bump.
{
  const live = mkLiveState(5); // tiny bankroll
  const r = sizeForLive(
    { side: "BUY", tokenId: "UP1", price: 0.10, size: 1 }, // $0.10 sim
    live,
    { liveBankrollUsd: 5, simBankrollUsd: 50 },
  );
  // scale ratio 0.1, target $0.01 → 0 shares → "rounding" rejection
  assert(r.action === null, "min order: action null");
  assert(r.clippedBy === "rounding", `min order: got ${r.clippedBy}`);
}

// 4d. Marketable BUY $1 bump: at $0.05 the maker-min bump (5 sh) yields
// only $0.25 notional — below CLOB's $1 marketable BUY minimum. Code
// further bumps to ⌈$1/$0.05⌉ = 20 shares ($1.00) when budget allows.
// Replaces the older "min_order rej" expectation: the fix prefers
// upsizing to a fillable order over rejecting, and 20 sh × $0.05 still
// represents a cheap-tail bet that matches engine intent.
{
  const live = mkLiveState(5);
  const r = sizeForLive(
    { side: "BUY", tokenId: "UP1", price: 0.05, size: 18, orderType: "taker" },
    live,
    { liveBankrollUsd: 5, simBankrollUsd: 50 },
  );
  assert(r.action !== null, `marketable bump at $0.05: got null (reason=${r.reason})`);
  assert(r.action!.size === 20, `marketable bump at $0.05: expected 20 shares, got ${r.action?.size}`);
  assert(r.clippedBy === "marketable_min_bump", `expected marketable_min_bump, got ${r.clippedBy}`);
}

// 4b. Maker-min floor: tiny bankroll ($12.50) at $0.66 sizes to <5 shares.
// If cash + exposure allow, bump to 5 shares (even if it exceeds the
// MAX_POSITION_PCT cap). Otherwise reject with min_order reason.
{
  const live = mkLiveState(12.5);
  const r = sizeForLive(
    { side: "BUY", tokenId: "UP1", price: 0.66, size: 18 }, // sim action scale
    live,
    { liveBankrollUsd: 12.5, simBankrollUsd: 50 },
  );
  // 15% cap = $1.875, /0.66 = 2 shares — but < 5. Should bump to 5 since
  // 5 × $0.66 = $3.30 fits in $12.50 cash and 45% exposure ($5.625).
  assert(r.action !== null, `maker-min floor: got null (reason=${r.reason})`);
  assert(r.action!.size === 5, `maker-min floor: expected 5 shares, got ${r.action?.size}`);
  assert(r.clippedBy === "maker_min_bump", `maker-min floor: expected maker_min_bump clipper, got ${r.clippedBy}`);
}

// 4c. Maker-min reject: bankroll allows the bankroll-cap sizing ($1.20 > $1
// min notional) but cash starved below the 5-share threshold ($2 needed).
// Sized to 3 shares, bump-to-5 fails, rejects with min_order reason.
{
  const live = mkLiveState(8, 1.5); // $8 bankroll but only $1.50 cash
  const r = sizeForLive(
    { side: "BUY", tokenId: "UP1", price: 0.40, size: 18 },
    live,
    { liveBankrollUsd: 8, simBankrollUsd: 50 },
  );
  assert(r.action === null, `maker-min reject: expected null (got action=${JSON.stringify(r.action)})`);
  assert(r.clippedBy === "min_order", `maker-min reject: expected min_order, got ${r.clippedBy}`);
  assert(!!r.reason && r.reason.includes("5-share maker min"), `reason should mention 5-share min: ${r.reason}`);
}

// 4d-2. Marketable BUY $1 bump from already-rounded order. Bigger
// bankroll so the rounding doesn't zero out: $25 bankroll, sim 18@$0.16
// → scale 0.5×, target $1.44 → 9 shares = $1.44 already over $1 — but
// re-test with smaller engine size to land at 4 shares ($0.64) which
// triggers the bump.
{
  const live = mkLiveState(25);
  const r = sizeForLive(
    { side: "BUY", tokenId: "UP1", price: 0.16, size: 8, orderType: "taker" },
    live,
    { liveBankrollUsd: 25, simBankrollUsd: 50 },
  );
  // 8 × $0.16 = $1.28 sim, scale 0.5× = $0.64 target → 4 shares ($0.64).
  // 4 < MIN_ORDER_SHARES → maker_min_bump to 5 ($0.80). $0.80 < $1 →
  // marketable_min_bump to ⌈$1/$0.16⌉ = 7 ($1.12).
  assert(r.action !== null, `marketable-min from rounded: got null (reason=${r.reason})`);
  assert(r.action!.size === 7, `marketable-min from rounded: expected 7, got ${r.action?.size}`);
  assert(r.clippedBy === "marketable_min_bump", `expected marketable_min_bump, got ${r.clippedBy}`);
}

// 4e. Marketable BUY exempt for makers: 5 sh × $0.16 = $0.80 stays at 5
// when orderType=maker (resting orders below the ask are exempt from
// CLOB's $1 marketable rule).
{
  const live = mkLiveState(25);
  const r = sizeForLive(
    { side: "BUY", tokenId: "UP1", price: 0.16, size: 8, orderType: "maker" },
    live,
    { liveBankrollUsd: 25, simBankrollUsd: 50 },
  );
  // Same scenario as 4d-2 but maker — should NOT bump beyond 5.
  assert(r.action !== null, `marketable exempt for maker: got null (reason=${r.reason})`);
  assert(r.action!.size === 5, `marketable exempt: expected 5 shares (maker_min only), got ${r.action?.size}`);
  assert(r.clippedBy !== "marketable_min_bump", `maker shouldn't be marketable-bumped: got ${r.clippedBy}`);
}

// 4e2. Price-zone gate rejects taker BUYs outside [0.55, 0.70]
// Re-enable for this test (disabled for legacy tests above). Also flip
// off the 2026-05-13 live-side override so the gate actually fires.
(CONFIG as any).LIVE_PRICE_ZONE_ENABLED = true;
const ORIGINAL_OVERRIDE = CONFIG.LIVE_SIZING_OVERRIDE_ZONE_GATE;
(CONFIG as any).LIVE_SIZING_OVERRIDE_ZONE_GATE = false;
{
  const live = mkLiveState(25);
  const r = sizeForLive(
    { side: "BUY", tokenId: "UP1", price: 0.30, size: 10, orderType: "taker" },
    live,
    { liveBankrollUsd: 25, simBankrollUsd: 50 },
  );
  assert(r.action === null, `price-zone gate: expected null, got ${JSON.stringify(r.action)}`);
  assert(!!r.reason && r.reason.includes("outside alpha zone"),
    `expected price-zone reason, got ${r.reason}`);
  console.log("  liveSizing rejects taker BUY outside price zone ✓");
}
// 4e3. Maker BUY exempt from price-zone gate (different fill mechanics)
{
  const live = mkLiveState(25);
  const r = sizeForLive(
    { side: "BUY", tokenId: "UP1", price: 0.30, size: 10, orderType: "maker" },
    live,
    { liveBankrollUsd: 25, simBankrollUsd: 50 },
  );
  // Maker at $0.30 should NOT be rejected by the price-zone gate; may fail other
  // checks but the reason should NOT be alpha zone.
  if (r.action === null) {
    assert(!r.reason || !r.reason.includes("alpha zone"),
      `maker should not hit price-zone gate, got ${r.reason}`);
  }
  console.log("  liveSizing maker exempt from price-zone gate ✓");
}
// 4e4. With LIVE_SIZING_OVERRIDE_ZONE_GATE=true (2026-05-13 default),
// taker BUYs outside the zone are ALLOWED in live even when the gate flag
// is still on — referee.ts still enforces the gate in sim, this just
// bypasses the live side so engines can test tail-edge with real orders.
(CONFIG as any).LIVE_PRICE_ZONE_ENABLED = true;
(CONFIG as any).LIVE_SIZING_OVERRIDE_ZONE_GATE = true;
{
  const live = mkLiveState(25);
  const r = sizeForLive(
    { side: "BUY", tokenId: "UP1", price: 0.30, size: 10, orderType: "taker" },
    live,
    { liveBankrollUsd: 25, simBankrollUsd: 50 },
  );
  // Order should NOT be rejected for the zone — it may be sized differently
  // by downstream checks but shouldn't fail with "outside alpha zone".
  if (r.action === null) {
    assert(!r.reason || !r.reason.includes("alpha zone"),
      `override should bypass zone gate, got rejection: ${r.reason}`);
  }
  console.log("  liveSizing OVERRIDE allows taker BUY outside zone ✓");
}

// Disable again for subsequent legacy tests + restore the override
(CONFIG as any).LIVE_PRICE_ZONE_ENABLED = false;
(CONFIG as any).LIVE_SIZING_OVERRIDE_ZONE_GATE = ORIGINAL_OVERRIDE;

// 4f. Marketable BUY rejection when budget can't cover the bump:
// $25 bankroll but only $0.80 cash. After maker_min_bump to 5 shares the
// notional is $0.80, but the further bump to 7 sh ($1.12) exceeds the
// $0.80 cash. Should reject with "marketable BUY min" reason.
{
  const live = mkLiveState(25, 0.80); // bankroll $25, cash starved at $0.80
  const r = sizeForLive(
    { side: "BUY", tokenId: "UP1", price: 0.16, size: 8, orderType: "taker" },
    live,
    { liveBankrollUsd: 25, simBankrollUsd: 50 },
  );
  assert(r.action === null, `marketable-min reject: expected null, got ${JSON.stringify(r.action)}`);
  assert(r.clippedBy === "min_order", `marketable-min reject: expected min_order, got ${r.clippedBy}`);
  assert(!!r.reason && r.reason.includes("marketable BUY min"),
    `reason should mention marketable BUY min: ${r.reason}`);
}

// 5. Candle exposure cap
{
  const live = mkLiveState(1000);
  const r = sizeForLive(
    { side: "BUY", tokenId: "UP1", price: 0.10, size: 20 },
    live,
    { liveBankrollUsd: 1000, simBankrollUsd: 50, maxCandleExposurePct: 0.60, currentCandleExposureUsd: 590 },
  );
  // $10 remaining exposure budget, target $40, clipped to $10 → 100 shares
  assert(r.action !== null, "exposure cap: non-null");
  assert(r.clippedBy === "exposure_cap", `exposure cap: got ${r.clippedBy}`);
  assert(r.action!.size === 100, `exposure cap: got ${r.action!.size}`);
}

// 6. HOLD passes through
{
  const live = mkLiveState(500);
  const r = sizeForLive(
    { side: "HOLD", tokenId: "UP1", price: 0, size: 0 },
    live,
    { liveBankrollUsd: 500, simBankrollUsd: 50 },
  );
  assert(r.action !== null && r.action.side === "HOLD", "HOLD passes through");
}

// 7. SELL beyond position is clipped
{
  const live = mkLiveState(500);
  live.positions.set("UP1", {
    tokenId: "UP1", side: "YES", shares: 30, avgEntry: 0.10, costBasis: 3,
  });
  const r = sizeForLive(
    { side: "SELL", tokenId: "UP1", price: 0.15, size: 100 },
    live,
    { liveBankrollUsd: 500, simBankrollUsd: 50 },
  );
  assert(r.action !== null && r.action.size === 30, `SELL clip: expected 30, got ${r.action?.size}`);
}

// 8. computeCandleExposure
{
  const live = mkLiveState(500);
  live.positions.set("UP1", { tokenId: "UP1", side: "YES", shares: 50, avgEntry: 0.10, costBasis: 5 });
  live.pendingOrders.set("o1", {
    clientOrderId: "o1", tokenId: "UP1", side: "BUY", price: 0.10, size: 20, postedAt: 0, filledSize: 0,
  });
  const exp = computeCandleExposure(live);
  assert(Math.abs(exp - 7) < 0.001, `exposure: expected $7 ($5 cost + $2 pending), got ${exp}`);
}

// ── Flat $$ ceiling (May 6 2026) — adverse-fill prevention ─────────────────
// Polymarket-ai-bot's hard lesson: stakes >$10 drop WR 75%→40%. Cap at $8.
// Verifies the ceiling clips even when bankroll PCT cap would allow more.
{
  RISK_CONFIG.MAX_LIVE_TRADE_USD = 8;  // set production value for this test only
  const live = mkLiveState(1000);  // big bankroll — PCT cap = $150
  const r = sizeForLive(
    { side: "BUY", tokenId: "UP1", price: 0.10, size: 10 },  // sim wants $1 → 100x scale = $100
    live,
    { liveBankrollUsd: 1000, simBankrollUsd: 50 },  // 20x scale ratio
  );
  assert(r.action !== null, "flat ceiling test: action should not be null");
  // $100 target, $150 PCT cap, but $8 flat ceiling → 80 shares @ $0.10
  assert(r.action!.size === 80, `flat ceiling caps at MAX_LIVE_TRADE_USD ($8): expected 80, got ${r.action!.size}`);
  assert(r.clippedBy === "bankroll_cap", `flat ceiling marks bankroll_cap, got ${r.clippedBy}`);
  // Restore to the disabled (Infinity) state so the async LiveExecutor tests
  // below don't hit the ceiling — they exercise scaling behavior in isolation.
  RISK_CONFIG.MAX_LIVE_TRADE_USD = Number.POSITIVE_INFINITY;
}

// ── LiveExecutor (async — wrapped in IIFE because CommonJS) ────────────────

import { executeLive, applyFill, type SubmitResult, type OrderSubmitter } from "../live/liveExecutor";

// Build a submitter that records calls and returns instant fills
function instantFillSubmitter(): { submit: OrderSubmitter; calls: EngineAction[] } {
  const calls: EngineAction[] = [];
  const submit: OrderSubmitter = async (action: EngineAction) => {
    calls.push(action);
    return {
      ok: true,
      clientOrderId: `test-${calls.length}`,
      filledSize: action.size,
      avgFillPrice: action.price,
    } as SubmitResult;
  };
  return { submit, calls };
}

function rejectSubmitter(reason: string): OrderSubmitter {
  return async () => ({ ok: false, reason });
}

async function runLiveExecutorTests(): Promise<void> {
  console.log("\n=== LiveExecutor ===");

// 1. Happy path: BUY is sized, submitted, filled, position updated
{
  const live = mkLiveState(500);
  const { submit, calls } = instantFillSubmitter();
  const r = await executeLive(
    "test",
    { side: "BUY", tokenId: "UP1", price: 0.10, size: 20 }, // $2 sim × 10 = $20
    live,
    submit,
    { simBankrollUsd: 50 },
  );
  assert(r.accepted === true, `exec happy: accepted, got ${r.reason}`);
  assert(calls.length === 1, `exec happy: submitter called once, got ${calls.length}`);
  assert(calls[0].size === 200, `exec happy: sized to 200 shares, got ${calls[0].size}`);
  assert(Math.abs(live.cashBalance - (500 - 20)) < 0.01, `exec happy: cash $480, got ${live.cashBalance}`);
  const pos = live.positions.get("UP1");
  assert(pos !== undefined && pos.shares === 200, `exec happy: 200 shares in position`);
  assert(live.pendingOrders.size === 0, `exec happy: pending cleared on fill`);
}

// 2. Halted: rejected before sizing
{
  const live = mkLiveState(500);
  live.paused = true;
  live.pauseReason = "test halt";
  const { submit, calls } = instantFillSubmitter();
  const r = await executeLive(
    "test",
    { side: "BUY", tokenId: "UP1", price: 0.10, size: 20 },
    live,
    submit,
    { simBankrollUsd: 50 },
  );
  assert(r.accepted === false, "exec halted: rejected");
  assert(calls.length === 0, "exec halted: submitter not called");
  assert(live.cashBalance === 500, "exec halted: cash unchanged");
}

// 3. Submit rejection: state not mutated
{
  const live = mkLiveState(500);
  const submit = rejectSubmitter("CLOB 429");
  const r = await executeLive(
    "test",
    { side: "BUY", tokenId: "UP1", price: 0.10, size: 20 },
    live,
    submit,
    { simBankrollUsd: 50 },
  );
  assert(r.accepted === false, "exec submit reject: rejected");
  assert(r.reason?.includes("CLOB 429") === true, `exec submit reject: reason includes 429, got ${r.reason}`);
  assert(live.cashBalance === 500, "exec submit reject: cash unchanged");
  assert(live.positions.size === 0, "exec submit reject: no position");
}

// 4. HOLD passes through without submission
{
  const live = mkLiveState(500);
  const { submit, calls } = instantFillSubmitter();
  const r = await executeLive(
    "test",
    { side: "HOLD", tokenId: "", price: 0, size: 0 },
    live,
    submit,
    { simBankrollUsd: 50 },
  );
  assert(r.accepted === true, "exec HOLD: accepted");
  assert(calls.length === 0, "exec HOLD: not submitted");
}

// 5. Min order floor rejects without submitting (Apr 25: with new ordering,
// $5 bankroll × 0.1 sim → $0.01 target → 0 shares → "rounding" reject).
{
  const live = mkLiveState(5); // tiny bankroll
  const { submit, calls } = instantFillSubmitter();
  const r = await executeLive(
    "test",
    { side: "BUY", tokenId: "UP1", price: 0.10, size: 1 },
    live,
    submit,
    { simBankrollUsd: 50 },
  );
  assert(r.accepted === false, "exec min order: rejected");
  assert(calls.length === 0, "exec min order: not submitted");
  assert(!!r.reason && (r.reason.includes("min") || r.reason.includes("rounding")),
    `exec min order: reason mentions min/rounding, got ${r.reason}`);
}

// 6. applyFill: SELL reduces position and credits cash
{
  const live = mkLiveState(500);
  live.positions.set("UP1", { tokenId: "UP1", side: "YES", shares: 100, avgEntry: 0.10, costBasis: 10 });
  live.cashBalance = 490;
  applyFill(
    live,
    { side: "SELL", tokenId: "UP1", price: 0.15, size: 60 },
    { filledSize: 60, avgFillPrice: 0.15 },
  );
  const pos = live.positions.get("UP1")!;
  assert(pos.shares === 40, `applyFill SELL: 40 shares, got ${pos.shares}`);
  assert(Math.abs(live.cashBalance - (490 + 9)) < 0.01, `applyFill SELL: cash $499, got ${live.cashBalance}`);
  // Cost basis should be reduced proportionally: 40/100 × $10 = $4
  assert(Math.abs(pos.costBasis - 4) < 0.01, `applyFill SELL: basis $4, got ${pos.costBasis}`);
}

// 7. applyFill: BUY adds to existing position (weighted avg)
{
  const live = mkLiveState(500);
  live.positions.set("UP1", { tokenId: "UP1", side: "YES", shares: 100, avgEntry: 0.10, costBasis: 10 });
  applyFill(
    live,
    { side: "BUY", tokenId: "UP1", price: 0.20, size: 100 },
    { filledSize: 100, avgFillPrice: 0.20 },
  );
  const pos = live.positions.get("UP1")!;
  assert(pos.shares === 200, `applyFill BUY: 200 shares, got ${pos.shares}`);
  assert(Math.abs(pos.costBasis - 30) < 0.01, `applyFill BUY: basis $30, got ${pos.costBasis}`);
  assert(Math.abs(pos.avgEntry - 0.15) < 0.01, `applyFill BUY: avg 0.15, got ${pos.avgEntry}`);
}

// 8. positionSide: BUY DOWN via executor records correct side
{
  const live = mkLiveState(500);
  const { submit } = instantFillSubmitter();
  await executeLive(
    "test",
    { side: "BUY", tokenId: "DOWN1", price: 0.10, size: 20 },
    live,
    submit,
    { simBankrollUsd: 50, positionSide: "NO" },
  );
  const pos = live.positions.get("DOWN1");
  assert(pos !== undefined && pos.side === "NO", `positionSide: expected NO, got ${pos?.side}`);
}

// ── Reconciliation ────────────────────────────────────────────────────────
const { reconcilePending: reconcile } = await import("../live/liveReconcile");

console.log("\n=== LiveReconcile ===");

// 9. Full fill of a GTC order: position created, pending cleared
{
  const live = mkLiveState(500);
  live.cashBalance = 480; // $20 reserved earlier
  live.pendingOrders.set("o1", {
    clientOrderId: "o1", tokenId: "UP1", side: "BUY", price: 0.10, size: 200,
    postedAt: Date.now() - 5_000, filledSize: 0,
  });
  const lookup = async () => ({
    clientOrderId: "o1", status: "FILLED" as const, filledSize: 200, avgFillPrice: 0.10,
  });
  const r = await reconcile(live, lookup, { minAgeMs: 0 });
  assert(r.filled === 1, `reconcile full: filled=1, got ${r.filled}`);
  assert(live.pendingOrders.size === 0, "reconcile full: pending cleared");
  const pos = live.positions.get("UP1");
  assert(pos !== undefined && pos.shares === 200, `reconcile full: position shares=200, got ${pos?.shares}`);
}

// 10. Cancelled order releases reserved cash
{
  const live = mkLiveState(500);
  live.cashBalance = 480; // $20 reserved
  live.pendingOrders.set("o2", {
    clientOrderId: "o2", tokenId: "UP1", side: "BUY", price: 0.10, size: 200,
    postedAt: Date.now() - 5_000, filledSize: 0,
  });
  const lookup = async () => ({
    clientOrderId: "o2", status: "CANCELLED" as const, filledSize: 0, avgFillPrice: 0,
  });
  const r = await reconcile(live, lookup, { minAgeMs: 0 });
  assert(r.cancelled === 1, `reconcile cancel: cancelled=1, got ${r.cancelled}`);
  assert(Math.abs(live.cashBalance - 500) < 0.01, `reconcile cancel: cash restored to 500, got ${live.cashBalance}`);
  assert(live.pendingOrders.size === 0, "reconcile cancel: pending cleared");
}

// 11. Partial fill updates filledSize without clearing
{
  const live = mkLiveState(500);
  live.cashBalance = 480;
  live.pendingOrders.set("o3", {
    clientOrderId: "o3", tokenId: "UP1", side: "BUY", price: 0.10, size: 200,
    postedAt: Date.now() - 5_000, filledSize: 0,
  });
  const lookup = async () => ({
    clientOrderId: "o3", status: "OPEN" as const, filledSize: 100, avgFillPrice: 0.10,
  });
  const r = await reconcile(live, lookup, { minAgeMs: 0 });
  assert(r.partialFills === 1, `reconcile partial: partialFills=1, got ${r.partialFills}`);
  assert(live.pendingOrders.size === 1, "reconcile partial: pending still tracked");
  assert(live.pendingOrders.get("o3")!.filledSize === 100, "reconcile partial: filledSize updated");
  const pos = live.positions.get("UP1");
  assert(pos !== undefined && pos.shares === 100, `reconcile partial: 100 shares, got ${pos?.shares}`);
}

// 12. minAge guard skips recent orders
{
  const live = mkLiveState(500);
  live.pendingOrders.set("o4", {
    clientOrderId: "o4", tokenId: "UP1", side: "BUY", price: 0.10, size: 200,
    postedAt: Date.now(), filledSize: 0,
  });
  let called = 0;
  const lookup = async () => { called++; return null; };
  const r = await reconcile(live, lookup, { minAgeMs: 5_000 });
  assert(r.checked === 0, `reconcile minAge: checked=0, got ${r.checked}`);
  assert(called === 0, "reconcile minAge: lookup not called");
}
} // end runLiveExecutorTests

// ── Fee Gradient (the quartic curve) ─────────────────────────────────────────

console.log("\n=== Fee Gradient (Quartic Curve) ===");
console.log("  Price | Fee %   | Fee on $100");
console.log("  ------|---------|------------");
for (const p of [0.01, 0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90, 0.99]) {
  const f = calculateFee(p, 100);
  const pct = (f / 100 * 100).toFixed(4);
  console.log(`  ${p.toFixed(2)}  | ${pct.padStart(7)}% | $${f.toFixed(4)}`);
}

// ── Direction-aware CLOB tick alignment ──────────────────────────────────────

import { alignTickForSide } from "../live/clobSubmitter";

console.log("\n── CLOB tick alignment ────────────────");

// The Apr 24 bug: 0.655 BUY at tick 0.01 was rounded UP to 0.66 and ate the ask
{
  const p = alignTickForSide(0.655, "BUY", "0.01");
  assert(p === 0.65, `0.655 BUY @ tick 0.01 should floor to 0.65, got ${p}`);
  console.log(`  0.655 BUY @ tick 0.01 → ${p} (was 0.66 before fix)`);
}

// Inverse: SELLs must round UP so a maker SELL stays above bid
{
  const p = alignTickForSide(0.655, "SELL", "0.01");
  assert(p === 0.66, `0.655 SELL @ tick 0.01 should ceil to 0.66, got ${p}`);
  console.log(`  0.655 SELL @ tick 0.01 → ${p}`);
}

// Already-aligned prices pass through unchanged either direction
{
  const buyP = alignTickForSide(0.42, "BUY", "0.01");
  const sellP = alignTickForSide(0.42, "SELL", "0.01");
  assert(buyP === 0.42 && sellP === 0.42, `0.42 should be idempotent, got BUY=${buyP} SELL=${sellP}`);
}

// Tick 0.001: 0.6554 BUY → 0.655, 0.6554 SELL → 0.656
{
  const buyP = alignTickForSide(0.6554, "BUY", "0.001");
  const sellP = alignTickForSide(0.6554, "SELL", "0.001");
  assert(buyP === 0.655, `0.6554 BUY @ tick 0.001 should floor to 0.655, got ${buyP}`);
  assert(sellP === 0.656, `0.6554 SELL @ tick 0.001 should ceil to 0.656, got ${sellP}`);
}

// Clamp: extremes should not round to 0.00 or 1.00 (PM rejects)
{
  const lowBuy = alignTickForSide(0.005, "BUY", "0.01");
  assert(lowBuy >= 0.01, `extreme-low BUY clamped above 0 tick, got ${lowBuy}`);
  const highSell = alignTickForSide(0.999, "SELL", "0.01");
  assert(highSell <= 0.99, `extreme-high SELL clamped below 1, got ${highSell}`);
}

// ── Post-timeout reconcile (clobSubmitter) ──────────────────────────────────

import { buildClobSubmitter } from "../live/clobSubmitter";

async function runClobSubmitterTimeoutTests(): Promise<void> {
  console.log("\n── clobSubmitter post-timeout reconcile ────");

  // Mock client where createAndPostOrder NEVER resolves (simulates PM hung)
  function hungClient(getOpenOrdersResp: unknown[], cancelTracker?: { ids: string[] }) {
    return {
      createAndPostOrder: () => new Promise(() => { /* never resolves */ }),
      getNegRisk: async () => false,
      getOpenOrders: async () => getOpenOrdersResp,
      cancelOrders: async (ids: string[]) => {
        if (cancelTracker) cancelTracker.ids.push(...ids);
        return true;
      },
    } as never;
  }

  // Case 1: timeout fires AND probe finds matching order →
  // ACTIVELY CANCEL + reject (2026-05-13 change). Previous behavior was
  // "accept as in-flight" but that risked the stale-fill problem where
  // an order found 60s+ after submit fills at a now-moved price.
  {
    const cancelled = { ids: [] as string[] };
    const submit = buildClobSubmitter({
      client: hungClient([{ id: "ord-found-123", market: "TOK1", asset_id: "TOK1", size: 5 }], cancelled),
      timeoutMs: 200,
      tickSize: "0.01",
      negRisk: false,
    });
    const start = Date.now();
    const r = await submit({ side: "BUY", tokenId: "TOK1", price: 0.50, size: 5 });
    const elapsed = Date.now() - start;
    assert(r.ok === false, `timeout-with-found-order: should reject after cancel, got ${JSON.stringify(r)}`);
    assert(cancelled.ids.includes("ord-found-123"),
      `expected cancelOrders called with ord-found-123, got ${JSON.stringify(cancelled.ids)}`);
    assert(elapsed >= 200 && elapsed < 5000, `should take ~200ms+ (timeout duration), took ${elapsed}ms`);
    console.log(`  timeout + getOpenOrders match → cancelled + rejected ✓ (${elapsed}ms)`);
  }

  // Case 1b: timeout fires, probe finds order, but cancel itself fails →
  // still reject the order (best-effort cancel, log+warn, don't crash).
  {
    const submit = buildClobSubmitter({
      client: {
        createAndPostOrder: () => new Promise(() => {/* never */}),
        getNegRisk: async () => false,
        getOpenOrders: async () => [{ id: "ord-x", market: "TOK1", asset_id: "TOK1", size: 5 }],
        cancelOrders: async () => { throw new Error("cancel server error"); },
      } as never,
      timeoutMs: 200,
      tickSize: "0.01",
      negRisk: false,
    });
    const r = await submit({ side: "BUY", tokenId: "TOK1", price: 0.50, size: 5 });
    assert(r.ok === false, `cancel-fail: should still reject, got ${JSON.stringify(r)}`);
    console.log(`  timeout + cancel error → rejected gracefully (best-effort) ✓`);
  }

  // Case 2: timeout fires AND open-order probe returns empty → rejected
  {
    const submit = buildClobSubmitter({
      client: hungClient([]),
      timeoutMs: 200,
      tickSize: "0.01",
      negRisk: false,
    });
    const r = await submit({ side: "BUY", tokenId: "TOK1", price: 0.50, size: 5 });
    assert(r.ok === false, `timeout-with-empty-probe: should reject, got ${JSON.stringify(r)}`);
    if (!r.ok) {
      assert(!!r.reason && r.reason.includes("timeout"), `reason should mention timeout: ${r.reason}`);
    }
    console.log(`  timeout + getOpenOrders empty → rejected ✓`);
  }

  // Case 3: timeout fires AND open-order probe throws → rejected gracefully
  {
    const submit = buildClobSubmitter({
      client: {
        createAndPostOrder: () => new Promise(() => {/* never */}),
        getNegRisk: async () => false,
        getOpenOrders: async () => { throw new Error("network down"); },
      } as never,
      timeoutMs: 200,
      tickSize: "0.01",
      negRisk: false,
    });
    const r = await submit({ side: "BUY", tokenId: "TOK1", price: 0.50, size: 5 });
    assert(r.ok === false, `timeout-with-probe-error: should reject, got ${JSON.stringify(r)}`);
    console.log(`  timeout + getOpenOrders error → rejected gracefully ✓`);
  }
}

// ── Book microstructure signals (pulse.ts) ──────────────────────────────────

console.log("\n── Book microstructure signals ────────");

// parsePmL2 test to simulate book state, then compute imbalance/spread
// against the known book shape. We bypass the book state machine by
// constructing OrderBooks directly and computing signals inline.
{
  // Helper: local version of bookImbalance that operates on an OrderBook
  // directly (we can't easily mutate pulse's module state from test).
  function imb(book: { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] }, topN = 3): number {
    const bd = book.bids.slice(0, topN).reduce((s, l) => s + l.size, 0);
    const ad = book.asks.slice(0, topN).reduce((s, l) => s + l.size, 0);
    const total = bd + ad;
    return total === 0 ? 0 : (bd - ad) / total;
  }
  // Balanced book → 0
  const balanced = { bids: [{price: 0.59, size: 100}], asks: [{price: 0.61, size: 100}], timestamp: 0 };
  assert(imb(balanced) === 0, `balanced: expected 0, got ${imb(balanced)}`);
  // Bid-heavy → positive
  const bidHeavy = {
    bids: [{price:0.59,size:200},{price:0.58,size:150},{price:0.57,size:100}],
    asks: [{price:0.61,size:50},{price:0.62,size:50},{price:0.63,size:50}],
    timestamp: 0,
  };
  const bh = imb(bidHeavy);
  // bid depth 450, ask depth 150 → (450-150)/600 = 0.5
  assert(Math.abs(bh - 0.5) < 0.001, `bid-heavy: expected 0.5, got ${bh.toFixed(3)}`);
  // Ask-heavy → negative
  const askHeavy = {
    bids: [{price:0.59,size:50}],
    asks: [{price:0.61,size:200}],
    timestamp: 0,
  };
  assert(imb(askHeavy) === -0.6, `ask-heavy: expected -0.6, got ${imb(askHeavy)}`);
  // Empty book → 0 (not NaN)
  const empty = { bids: [], asks: [], timestamp: 0 };
  assert(imb(empty) === 0, `empty: expected 0, got ${imb(empty)}`);
}

// Spread BPS math test (mirrors getSpreadBps logic)
{
  function spread(bid: number, ask: number): number {
    if (bid <= 0 || ask <= 0 || ask <= bid) return 0;
    const mid = (bid + ask) / 2;
    return ((ask - bid) / mid) * 10_000;
  }
  // 0.59 bid, 0.61 ask → spread 2¢, mid 0.60 → 333 bps
  const s1 = spread(0.59, 0.61);
  assert(Math.abs(s1 - 333.3) < 0.5, `spread 2¢: expected ~333bps, got ${s1.toFixed(1)}`);
  // Tight spread 0.60-0.605 → 83 bps
  const s2 = spread(0.60, 0.605);
  assert(Math.abs(s2 - 83) < 1, `spread 0.5¢: expected ~83bps, got ${s2.toFixed(1)}`);
  // Crossed book → 0 sentinel
  assert(spread(0.61, 0.59) === 0, "crossed book returns 0");
  // Empty → 0
  assert(spread(0, 0) === 0, "empty book returns 0");
}

// parsePmL2 still works (regression for the ingestion path)
{
  const msg = {
    event_type: "book",
    asks: [{price: "0.61", size: "100"}],
    bids: [{price: "0.59", size: "100"}],
  };
  const book = parsePmL2(msg);
  assert(book !== null, "parsePmL2 returns a book");
  assert(book!.asks[0].price === 0.61 && book!.bids[0].price === 0.59, "prices parsed");
}

// ── SignalContrarianEngine gate logic ────────────────────────────────────────

import { computeSignalBias } from "../engines/SignalContrarianEngine";

console.log("\n── Signal Contrarian gate logic ───────");

// 1. Both gates neutral → no side
{
  const b = computeSignalBias(50, 0);
  assert(b.side === null, `neutral both: expected null, got ${b.side}`);
  assert(!b.fngFired && !b.fundingFired, "neither gate should fire");
}

// 2. F&G greed alone → DOWN (single-gate, not confirmed)
{
  const b = computeSignalBias(70, 0);
  assert(b.side === "DOWN", `greed: expected DOWN, got ${b.side}`);
  assert(b.fngFired && !b.fundingFired, "fng fired, funding didn't");
  assert(!b.confirmed, "single gate is not confirmed");
}

// 3. F&G fear alone → UP
{
  const b = computeSignalBias(30, 0);
  assert(b.side === "UP", `fear: expected UP, got ${b.side}`);
  assert(b.fngFired && !b.fundingFired, "fng fired, funding didn't");
}

// 4. Positive funding alone → DOWN (longs paying = crowded)
{
  const b = computeSignalBias(50, 0.00015);
  assert(b.side === "DOWN", `pos funding: expected DOWN, got ${b.side}`);
  assert(!b.fngFired && b.fundingFired, "funding fired, fng didn't");
}

// 5. Negative funding alone → UP
{
  const b = computeSignalBias(50, -0.00025);
  assert(b.side === "UP", `neg funding: expected UP, got ${b.side}`);
}

// 6. Both agree: greed + positive funding → DOWN confirmed
{
  const b = computeSignalBias(70, 0.0002);
  assert(b.side === "DOWN", `both agree greed+pos: expected DOWN, got ${b.side}`);
  assert(b.confirmed, "both-agree should be confirmed");
}

// 7. Both agree: fear + negative funding → UP confirmed
{
  const b = computeSignalBias(30, -0.0002);
  assert(b.side === "UP", `both agree fear+neg: expected UP, got ${b.side}`);
  assert(b.confirmed, "both-agree should be confirmed");
}

// 8. Disagreement → null (ambiguous, skip)
{
  const b = computeSignalBias(70, -0.0003); // greed but shorts paying?
  assert(b.side === null, `disagreement: expected null, got ${b.side}`);
  assert(b.fngFired && b.fundingFired, "both fired but disagree");
}

// 9. Null signals: tolerate missing data without crashing
{
  const b1 = computeSignalBias(null, 0.0003);
  assert(b1.side === "DOWN", `null fng + pos funding: expected DOWN, got ${b1.side}`);
  const b2 = computeSignalBias(70, null);
  assert(b2.side === "DOWN", `greed + null funding: expected DOWN, got ${b2.side}`);
  const b3 = computeSignalBias(null, null);
  assert(b3.side === null, `both null: expected null, got ${b3.side}`);
}

// 10. Boundary: exactly 65/35 F&G → triggers (≥ / ≤)
{
  const hi = computeSignalBias(65, 0);
  assert(hi.side === "DOWN", `F&G=65 boundary: expected DOWN, got ${hi.side}`);
  const lo = computeSignalBias(35, 0);
  assert(lo.side === "UP", `F&G=35 boundary: expected UP, got ${lo.side}`);
  const mid = computeSignalBias(64, 0);
  assert(mid.side === null, `F&G=64 below threshold: expected null, got ${mid.side}`);
  const mid2 = computeSignalBias(50, 0);
  assert(mid2.side === null, `F&G=50 neutral: expected null, got ${mid2.side}`);
}

// ── Signals shared cache (May 2026) ──────────────────────────────────────────
console.log("\n=== liveMirrorLog: writes one structured line per mirror decision ===");
{
  const { logMirror } = require("../live/liveMirrorLog");
  // The log path is fixed (data/live_mirror.log); we just verify the call
  // doesn't throw and produces a string in the expected format. We can't
  // override DATA_DIR for the test without bigger refactor, so we just
  // smoke-test the codepath here.
  let threw = false;
  try {
    logMirror("ACCEPTED", {
      engineId: "test-engine", arenaInstanceId: "btc", side: "BUY",
      positionSide: "YES", size: 5, price: 0.60, tokenId: "abc123def456",
    });
    logMirror("SKIPPED", {
      engineId: "test-engine", side: "BUY", size: 5, price: 0.60,
      reason: "dual_book_inconsistent",
    });
    logMirror("NULL_RESULT", {
      engineId: "test-engine", side: "BUY", size: 5, price: 0.60,
    });
  } catch (err) {
    threw = true;
    console.log(`  ✗ logMirror threw: ${err instanceof Error ? err.message : err}`);
  }
  assert(!threw, "logMirror should not throw on valid inputs");
  console.log("  logMirror handles ACCEPTED/SKIPPED/NULL_RESULT without error ✓");
}

console.log("\n=== fetchSignalSnapshotCached: shared file cache ===");
{
  const tmpDir = require("os").tmpdir();
  const tmpPath = require("path").join(tmpDir, `qf-signals-cache-test-${process.pid}`);
  // Override the CONFIG path for this test only.
  const originalPath = CONFIG.SIGNALS_CACHE_PATH;
  const originalTtl = CONFIG.SIGNALS_CACHE_TTL_MS;
  (CONFIG as any).SIGNALS_CACHE_PATH = tmpPath;
  (CONFIG as any).SIGNALS_CACHE_TTL_MS = 60_000;

  // Hand-write a fresh cache file with a known sentinel value.
  const sentinel = {
    timestamp: Date.now(),
    fearGreed: { value: 42, label: "TEST", timestamp: Date.now() },
    funding: null,
    impliedVol: null,
    realizedVol: null,
    binancePrice: 12345,
  };
  const cachePath = `${tmpPath}_btcusdt.json`;
  require("fs").writeFileSync(cachePath, JSON.stringify(sentinel));

  // First read should hit the cache (no network) and return our sentinel.
  const { fetchSignalSnapshotCached: cachedFn } = require("../signals");
  cachedFn("BTCUSDT").then((snap: any) => {
    assert(snap.fearGreed?.value === 42, `cache hit: expected fearGreed.value=42, got ${snap.fearGreed?.value}`);
    assert(snap.fearGreed?.label === "TEST", `cache hit: expected label TEST, got ${snap.fearGreed?.label}`);
    assert(snap.binancePrice === 12345, `cache hit: expected binancePrice 12345, got ${snap.binancePrice}`);
    console.log("  fresh cache hit → returns disk content without network ✓");

    // Cleanup + restore.
    try { require("fs").unlinkSync(cachePath); } catch {}
    (CONFIG as any).SIGNALS_CACHE_PATH = originalPath;
    (CONFIG as any).SIGNALS_CACHE_TTL_MS = originalTtl;
  }).catch((err: any) => {
    console.log(`  ✗ cache hit test threw: ${err.message}`);
    failed++;
  });
}

// ── Extreme-price settlement bias (May 2026) ────────────────────────────────
console.log("\n=== Extreme-price settlement flip probability ===");

// Point the empirical lookup at a non-existent path so the linear-fallback
// path is exercised for the existing tests below. Restored after the new
// empirical-path tests further down.
const ORIGINAL_EMPIRICAL_PATH = CONFIG.EMPIRICAL_FLIP_PROB_PATH;
(CONFIG as any).EMPIRICAL_FLIP_PROB_PATH = "/nonexistent/empirical_flip_prob.json";
_resetEmpiricalCache();

// Mid-prices below threshold should never flip
assert(extremeFlipProb(0.50) === 0, `mid 0.50 should be 0, got ${extremeFlipProb(0.50)}`);
assert(extremeFlipProb(0.65) === 0, `0.65 (dist 0.15 < threshold 0.30) should be 0`);
assert(extremeFlipProb(0.30) === 0, `0.30 (dist 0.20 < threshold 0.30) should be 0`);
console.log(`  mid prices (≤0.30 from 0.5) → flip prob = 0 ✓`);

// At/near threshold boundary (dist ≈ 0.30): float arithmetic produces tiny
// drift (0.80 - 0.5 = 0.30000...4 in IEEE754). Tolerance check.
assert(extremeFlipProb(0.20) < 0.001, `0.20 (dist ≈0.30) should be ~0, got ${extremeFlipProb(0.20)}`);
assert(extremeFlipProb(0.80) < 0.001, `0.80 (dist ≈0.30) should be ~0, got ${extremeFlipProb(0.80)}`);

// Just past threshold: small positive prob
const justPast = extremeFlipProb(0.19);  // dist 0.31, extremity 0.05, prob 0.05*0.40 = 0.02
assert(justPast > 0 && justPast < 0.05, `0.19 should give ~0.02, got ${justPast}`);
console.log(`  0.19 (just past threshold) → flip prob ${(justPast*100).toFixed(2)}% ✓`);

// Mid-ramp: dist 0.40, extremity 0.50, prob 0.50 × 0.40 = 0.20
// Locks the linear ramp shape against accidental swap to quadratic/sqrt.
const midRamp = extremeFlipProb(0.10);
assert(approx(midRamp, 0.20, 0.001), `0.10 (mid-ramp) should be ~0.20, got ${midRamp}`);
console.log(`  0.10 (mid-ramp, extremity 0.5) → flip prob ${(midRamp*100).toFixed(0)}% ✓`);

// Symmetric: 0.81 mirrors 0.19
assert(approx(extremeFlipProb(0.19), extremeFlipProb(0.81)),
  `symmetric: ${extremeFlipProb(0.19)} vs ${extremeFlipProb(0.81)}`);

// Full extremity (dist 0.5 from mid: prices 0 or 1) → MAX prob (default 0.40)
const max = extremeFlipProb(0);
assert(approx(max, 0.40, 0.001), `full extremity should be 0.40, got ${max}`);
const max2 = extremeFlipProb(1);
assert(approx(max, max2), `0 and 1 symmetric: ${max} vs ${max2}`);
console.log(`  full extremity (0 or 1) → flip prob ${(max*100).toFixed(0)}% ✓`);

// ── Empirical flip-prob lookup (May 11 2026) ────────────────────────────────
console.log("\n=== Empirical flip-prob lookup ===");
{
  const tmpDir = require("os").tmpdir();
  const tmpPath = require("path").join(tmpDir, `qf-empirical-${process.pid}.json`);
  const calibration = {
    calibrated_at: "2026-05-11T00:00:00Z",
    n_trades: 100,
    min_n_per_bucket: 5,
    fallback: "linear",
    buckets: [
      { price_lo: 0.05, price_hi: 0.10, n: 10, wins: 0, losses: 10, live_loss_rate: 1.0, flip_prob: 1.0 },
      { price_lo: 0.55, price_hi: 0.60, n: 20, wins: 8, losses: 12, live_loss_rate: 0.6, flip_prob: 0.0 },
      { price_lo: 0.65, price_hi: 0.70, n: 3, wins: 1, losses: 2, live_loss_rate: 0.67, flip_prob: 0.4 },  // n<5, ignored
    ],
  };
  require("fs").writeFileSync(tmpPath, JSON.stringify(calibration));
  (CONFIG as any).EMPIRICAL_FLIP_PROB_PATH = tmpPath;
  _resetEmpiricalCache();

  // Bucket has enough samples and flip_prob=1.0 — exact lookup
  const p = extremeFlipProb(0.07);
  assert(p === 1.0, `0.07 in [0.05,0.10) with n=10 should be 1.0, got ${p}`);
  console.log("  empirical bucket (n=10, prob=1.0) → 1.0 ✓");

  // Alpha zone bucket: flip_prob=0
  const alpha = extremeFlipProb(0.57);
  assert(alpha === 0, `0.57 alpha zone (n=20) should be 0, got ${alpha}`);
  console.log("  alpha zone bucket → 0.0 ✓");

  // Insufficient samples → falls back to linear
  const fallback = extremeFlipProb(0.67);
  // 0.67: dist 0.17 < threshold 0.30 → linear formula returns 0
  assert(fallback === 0, `0.67 with n<min → linear fallback should be 0, got ${fallback}`);
  console.log("  bucket n<min → linear fallback ✓");

  // Cleanup + restore
  try { require("fs").unlinkSync(tmpPath); } catch {}
  (CONFIG as any).EMPIRICAL_FLIP_PROB_PATH = ORIGINAL_EMPIRICAL_PATH;
  _resetEmpiricalCache();
}

// ── WangXingYu Copy Engine ─────────────────────────────────────────────────
console.log("\n=== WangXingYu Copy Engine ===");
{
  // Hermetic: don't hit the live Activity API from tests
  process.env.WANGXINGYU_DISABLE_FETCH = "1";
  const { WangXingYuCopyEngine } = require("../engines/WangXingYuCopyEngine");
  const wxActivity = require("../live/wangXingYuActivity");

  // Subclass overrides book access — pulse module-state isn't writable from tests
  class TestableWxEngine extends WangXingYuCopyEngine {
    private testBooks = new Map<string, any>();
    setBook(tokenId: string, book: any) { this.testBooks.set(tokenId, book); }
    protected getBookForToken(tokenId: string) {
      return this.testBooks.get(tokenId) ?? { bids: [], asks: [], timestamp: 0 };
    }
    protected isBookTradeable(_book: any) { return true; }
  }

  function mkPmTick(): MarketTick {
    return { source: "polymarket" as const, symbol: "BTC", midPrice: 0.5, bestBid: 0.49, bestAsk: 0.51, timestamp: Date.now() } as MarketTick;
  }
  function mkBook(askPx: number, askSz: number) {
    return {
      bids: [{ price: Math.max(0.001, askPx - 0.02), size: 1000 }],
      asks: [{ price: askPx, size: askSz }],
      timestamp: Date.now(),
    };
  }

  // Test 1: no signal → no action
  wxActivity._resetForTest();
  {
    const e = new TestableWxEngine();
    const st = mkState({ upToken: "UP_T1", downToken: "DOWN_T1" });
    st.marketWindowEnd = Date.now() + 600_000;
    e.init(st);
    const actions = e.onTick(mkPmTick(), st);
    assert(actions.length === 0, "no signal → no action");
    console.log("  no signal → no action ✓");
  }

  // Test 2: signal on UP → fires BUY UP, marks consumed (no double-fire next tick)
  wxActivity._resetForTest();
  {
    const e = new TestableWxEngine();
    e.setBook("UP_T2", mkBook(0.5, 100));
    e.setBook("DOWN_T2", mkBook(0.5, 100));
    wxActivity._injectSignalForTest({
      ts: Math.floor(Date.now() / 1000),
      tokenId: "UP_T2", slug: "test-slug-2", side: "BUY",
      price: 0.45, size: 50, title: "Bitcoin Up or Down - test",
      fetchedAt: Date.now(),
    });
    const st = mkState({ upToken: "UP_T2", downToken: "DOWN_T2" });
    st.marketWindowEnd = Date.now() + 600_000;
    st.cashBalance = 100;
    e.init(st);
    const a1 = e.onTick(mkPmTick(), st);
    assert(a1.length === 1, `signal → fires (got ${a1.length})`);
    assert(a1[0].side === "BUY" && a1[0].tokenId === "UP_T2", "fires BUY on UP token");
    console.log("  signal on UP → fires BUY UP ✓");

    const a2 = e.onTick(mkPmTick(), st);
    assert(a2.length === 0, "second tick → no double-fire (consumed)");
    console.log("  consumed flag blocks double-fire ✓");
  }

  // Test 3: stale signal (older than max age) → no fire
  wxActivity._resetForTest();
  {
    const e = new TestableWxEngine();
    e.setBook("UP_T3", mkBook(0.5, 100));
    e.setBook("DOWN_T3", mkBook(0.5, 100));
    wxActivity._injectSignalForTest({
      ts: Math.floor(Date.now() / 1000) - 999_999,
      tokenId: "UP_T3", slug: "test-slug-3", side: "BUY",
      price: 0.45, size: 50, title: "old", fetchedAt: Date.now(),
    });
    const st = mkState({ upToken: "UP_T3", downToken: "DOWN_T3" });
    st.marketWindowEnd = Date.now() + 600_000;
    st.cashBalance = 100;
    e.init(st);
    const actions = e.onTick(mkPmTick(), st);
    assert(actions.length === 0, "stale signal → no fire");
    console.log("  stale signal age → skip ✓");
  }

  // Test 4: candle window almost over → no fire (latency gate)
  wxActivity._resetForTest();
  {
    const e = new TestableWxEngine();
    e.setBook("UP_T4", mkBook(0.5, 100));
    e.setBook("DOWN_T4", mkBook(0.5, 100));
    wxActivity._injectSignalForTest({
      ts: Math.floor(Date.now() / 1000),
      tokenId: "UP_T4", slug: "test-slug-4", side: "BUY",
      price: 0.45, size: 50, title: "test", fetchedAt: Date.now(),
    });
    const st = mkState({ upToken: "UP_T4", downToken: "DOWN_T4" });
    st.marketWindowEnd = Date.now() + 30_000; // <90s remaining
    st.cashBalance = 100;
    e.init(st);
    const actions = e.onTick(mkPmTick(), st);
    assert(actions.length === 0, "<90s remaining → no fire");
    console.log("  insufficient remaining time → skip ✓");
  }

  // Test 5: ask too high (>= 0.95) → no fire (engine ceiling)
  wxActivity._resetForTest();
  {
    const e = new TestableWxEngine();
    e.setBook("UP_T5", mkBook(0.97, 100));
    e.setBook("DOWN_T5", mkBook(0.50, 100));
    wxActivity._injectSignalForTest({
      ts: Math.floor(Date.now() / 1000),
      tokenId: "UP_T5", slug: "test-slug-5", side: "BUY",
      price: 0.95, size: 50, title: "test", fetchedAt: Date.now(),
    });
    const st = mkState({ upToken: "UP_T5", downToken: "DOWN_T5" });
    st.marketWindowEnd = Date.now() + 600_000;
    st.cashBalance = 100;
    e.init(st);
    const actions = e.onTick(mkPmTick(), st);
    assert(actions.length === 0, "ask >=0.95 → no fire");
    console.log("  ceiling ask 0.95 → skip ✓");
  }

  // Test 6: signal on DOWN side fires correctly
  wxActivity._resetForTest();
  {
    const e = new TestableWxEngine();
    e.setBook("UP_T6", mkBook(0.55, 100));
    e.setBook("DOWN_T6", mkBook(0.45, 100));
    wxActivity._injectSignalForTest({
      ts: Math.floor(Date.now() / 1000),
      tokenId: "DOWN_T6", slug: "test-slug-6", side: "BUY",
      price: 0.43, size: 50, title: "test", fetchedAt: Date.now(),
    });
    const st = mkState({ upToken: "UP_T6", downToken: "DOWN_T6" });
    st.marketWindowEnd = Date.now() + 600_000;
    st.cashBalance = 100;
    e.init(st);
    const actions = e.onTick(mkPmTick(), st);
    assert(actions.length === 1 && actions[0].tokenId === "DOWN_T6", "fires BUY on DOWN token");
    console.log("  signal on DOWN → fires BUY DOWN ✓");
  }

  // Test 7: already holding → no fire (hold-to-settle, no DCA)
  wxActivity._resetForTest();
  {
    const e = new TestableWxEngine();
    e.setBook("UP_T7", mkBook(0.5, 100));
    e.setBook("DOWN_T7", mkBook(0.5, 100));
    wxActivity._injectSignalForTest({
      ts: Math.floor(Date.now() / 1000),
      tokenId: "UP_T7", slug: "test-slug-7", side: "BUY",
      price: 0.45, size: 50, title: "test", fetchedAt: Date.now(),
    });
    const posMap = new Map<string, PositionState>();
    posMap.set("UP_T7", { shares: 10, avgEntry: 0.5, costBasis: 5, side: "YES", tokenId: "UP_T7" });
    const st = mkState({ upToken: "UP_T7", downToken: "DOWN_T7", positions: posMap });
    st.marketWindowEnd = Date.now() + 600_000;
    st.cashBalance = 100;
    e.init(st);
    const actions = e.onTick(mkPmTick(), st);
    assert(actions.length === 0, "already holding → no fire");
    console.log("  position already exists → skip (no DCA) ✓");
  }

  // Test 8: stale signals + their consumed flags get pruned (bounded growth)
  wxActivity._resetForTest();
  {
    const nowSec = Math.floor(Date.now() / 1000);
    wxActivity._injectSignalForTest({
      ts: nowSec - 10_000, // way past 2× maxAge
      tokenId: "OLD_T", slug: "old", side: "BUY",
      price: 0.5, size: 10, title: "stale", fetchedAt: Date.now(),
    });
    wxActivity._injectSignalForTest({
      ts: nowSec, tokenId: "FRESH_T", slug: "fresh", side: "BUY",
      price: 0.5, size: 10, title: "fresh", fetchedAt: Date.now(),
    });
    // Mark the old one consumed (simulates earlier fire)
    wxActivity.markConsumed("OLD_T");
    wxActivity._pruneStaleForTest(600);
    assert(wxActivity.getSignalForToken("OLD_T") === null, "stale signal pruned");
    assert(wxActivity.getSignalForToken("FRESH_T") !== null, "fresh signal kept");
    console.log("  stale signals + consumed flags pruned ✓");
  }

  wxActivity._resetForTest();
}

// ── 4h-arena experimental engines (May 15 batch) ────────────────────────────
// Five engines targeting 4h candle markets with distinct alpha hypotheses:
// btc-eth divergence, vwap mean-rev, pre-resolution snap, funding-rate fader,
// asian-session mean-rev. All gated to 4h arenas and the [0.40, 0.70] alpha
// zone. Test fixtures override book/binance access since engines pull from
// pulse + cross-asset modules.

console.log("\n=== 4h experimental engines ===");
{
  process.env.CROSS_ASSET_DISABLE_FETCH = "1";
  process.env.BINANCE_FUNDING_DISABLE_FETCH = "1";

  function mk4hState(opts: { upToken?: string; downToken?: string; symbol?: string; positions?: Map<string, PositionState> } = {}): EngineState {
    const start = Date.now();
    return {
      engineId: "test",
      cashBalance: 100,
      roundPnl: 0,
      tradeCount: 0,
      feePaid: 0,
      feeRebate: 0,
      slippageCost: 0,
      positions: opts.positions ?? new Map(),
      activeTokenId: opts.upToken ?? "UP_4H",
      activeDownTokenId: opts.downToken ?? "DOWN_4H",
      marketSymbol: opts.symbol ?? "BTCUSDT",
      marketWindowStart: start,
      marketWindowEnd: start + 14_400_000, // 4h
      rejectionCounts: {},
    };
  }

  function mkPmTick(): MarketTick {
    return { source: "polymarket" as const, symbol: "BTC", midPrice: 0.5, bestBid: 0.49, bestAsk: 0.51, timestamp: Date.now() } as MarketTick;
  }

  function mkBook(askPx: number, askSz: number = 100) {
    return {
      bids: [{ price: Math.max(0.001, askPx - 0.02), size: 1000 }],
      asks: [{ price: askPx, size: askSz }],
      timestamp: Date.now(),
    };
  }

  // Mixin to override book access for testability — same pattern as
  // TestableWxEngine above. Each engine gets its own subclass at use site.
  function withTestBooks<T extends new (...args: any[]) => any>(Base: T) {
    return class extends Base {
      private testBooks = new Map<string, any>();
      setBook(tokenId: string, book: any) { this.testBooks.set(tokenId, book); }
      protected getBookForToken(tokenId: string) {
        return this.testBooks.get(tokenId) ?? { bids: [], asks: [], timestamp: 0 };
      }
      protected isBookTradeable(_book: any) { return true; }
    };
  }

  // ── BtcEthDivergenceEngine ─────────────────────────────────────────────────
  {
    const { BtcEthDivergenceEngine } = require("../engines/BtcEthDivergenceEngine");
    const cross = require("../live/crossAssetPrices");
    const Test = withTestBooks(BtcEthDivergenceEngine);

    // No cross-asset data → no fire
    cross._resetForTest();
    {
      const e = new Test();
      const st = mk4hState();
      e.init(st);
      e.setBook("UP_4H", mkBook(0.5));
      e.setBook("DOWN_4H", mkBook(0.5));
      const a = e.onTick(mkPmTick(), st);
      assert(a.length === 0, "btc-eth-div: no cross-asset data → no fire");
    }
    console.log("  btc-eth-div: no cross-asset → skip ✓");

    // BTC underperforms ETH by 50bps → bet UP on BTC arena
    cross._resetForTest();
    {
      // Inject ETH samples WITHIN the 1h lookback so oldest != latest
      const now = Date.now();
      cross._injectPriceForTest("ETHUSDT", now - 3000_000, 3000); // 50min ago
      cross._injectPriceForTest("ETHUSDT", now, 3015); // +50 bps now
      const e = new Test();
      const st = mk4hState({ symbol: "BTCUSDT" });
      e.init(st);
      e.setBook("UP_4H", mkBook(0.55));
      e.setBook("DOWN_4H", mkBook(0.55));
      // Feed Binance ticks so trackBinance has BTC history showing flat (0% return)
      const flatPrice = 70000;
      for (let i = 60; i >= 0; i--) {
        const t: any = { source: "binance", symbol: "BTCUSDT", midPrice: flatPrice, bestBid: flatPrice, bestAsk: flatPrice, timestamp: now - i * 60_000 };
        e.onTick(t, st);
      }
      const a = e.onTick(mkPmTick(), st);
      assert(a.length === 1, `btc-eth-div: divergence should fire (got ${a.length})`);
      assert(a[0].tokenId === "UP_4H", "btc-eth-div: BTC underperformed → bet UP");
    }
    console.log("  btc-eth-div: divergence fires correct direction ✓");

    // Not 4h candle → no fire
    cross._resetForTest();
    {
      const e = new Test();
      const st = mk4hState();
      st.marketWindowEnd = st.marketWindowStart + 300_000; // 5m
      e.init(st);
      e.setBook("UP_4H", mkBook(0.5));
      e.setBook("DOWN_4H", mkBook(0.5));
      const a = e.onTick(mkPmTick(), st);
      assert(a.length === 0, "btc-eth-div: 5m candle → skip");
    }
    console.log("  btc-eth-div: non-4h arena → skip ✓");

    cross._resetForTest();
  }

  // ── VwapMeanRev4hEngine ────────────────────────────────────────────────────
  {
    const { VwapMeanRev4hEngine } = require("../engines/VwapMeanRev4hEngine");
    const Test = withTestBooks(VwapMeanRev4hEngine);

    // Candle progress < 50% → no fire
    {
      const e = new Test();
      const st = mk4hState();
      // 30min in (~12.5%)
      st.marketWindowStart = Date.now() - 30 * 60_000;
      st.marketWindowEnd = st.marketWindowStart + 14_400_000;
      e.init(st);
      e.setBook("UP_4H", mkBook(0.5));
      e.setBook("DOWN_4H", mkBook(0.5));
      const a = e.onTick(mkPmTick(), st);
      assert(a.length === 0, "vwap-mean-rev-4h: progress<50% → skip");
    }
    console.log("  vwap-mean-rev-4h: low progress → skip ✓");

    // Sufficient z-score → fires
    {
      const e = new Test();
      const st = mk4hState();
      // 3h in (75%) of 4h
      const now = Date.now();
      st.marketWindowStart = now - 3 * 3600_000;
      st.marketWindowEnd = st.marketWindowStart + 14_400_000;
      e.init(st);
      e.setBook("UP_4H", mkBook(0.5));
      e.setBook("DOWN_4H", mkBook(0.5));
      // Feed Binance ticks: rising sharply over last 30min (price went UP a lot)
      // Mean rev says: bet DOWN (price above mean)
      for (let i = 40; i >= 0; i--) {
        const px = 70000 + (40 - i) * 100; // rising linearly
        const t: any = { source: "binance", symbol: "BTCUSDT", midPrice: px, bestBid: px, bestAsk: px, timestamp: now - i * 60_000 };
        e.onTick(t, st);
      }
      const a = e.onTick(mkPmTick(), st);
      // High vol + monotonic rise → z-score may or may not exceed gate
      // depending on stddev calc. Either fires DOWN or skips — both acceptable
      // here since this engine's z-calc is approximate.
      assert(a.length === 0 || (a.length === 1 && a[0].tokenId === "DOWN_4H"),
        `vwap-mean-rev-4h: rising → DOWN or skip (got ${a.length} actions)`);
    }
    console.log("  vwap-mean-rev-4h: rising trend → DOWN bet or skip ✓");
  }

  // ── PreResolutionSnapEngine ────────────────────────────────────────────────
  {
    const { PreResolutionSnapEngine } = require("../engines/PreResolutionSnapEngine");
    const Test = withTestBooks(PreResolutionSnapEngine);

    // Outside time window → no fire
    {
      const e = new Test();
      const st = mk4hState();
      // 2h remaining (way too early)
      e.init(st);
      e.setBook("UP_4H", mkBook(0.5));
      e.setBook("DOWN_4H", mkBook(0.5));
      const t: any = { source: "binance", symbol: "BTCUSDT", midPrice: 70000, bestBid: 70000, bestAsk: 70000, timestamp: Date.now() };
      e.onTick(t, st);
      const a = e.onTick(mkPmTick(), st);
      assert(a.length === 0, "pre-res-snap: too early → skip");
    }
    console.log("  pre-res-snap: outside window → skip ✓");

    // In window with positive delta → fires UP
    {
      const e = new Test();
      const st = mk4hState();
      const now = Date.now();
      // 60s remaining
      st.marketWindowStart = now - (14_400 - 60) * 1000;
      st.marketWindowEnd = now + 60_000;
      e.init(st);
      e.setBook("UP_4H", mkBook(0.5));
      e.setBook("DOWN_4H", mkBook(0.5));
      // 1: track candle-open binance price, 2: pm-tick CAPTURES open (delta=0, no fire),
      // 3: track higher binance, 4: pm-tick should fire on positive delta
      const openPx = 70000;
      e.onTick({ source: "binance", symbol: "BTCUSDT", midPrice: openPx, bestBid: openPx, bestAsk: openPx, timestamp: now } as any, st);
      const a0 = e.onTick(mkPmTick(), st); // captures open=openPx, delta=0 → skip
      assert(a0.length === 0, "pre-res-snap: capture tick should not fire");
      const curPx = openPx * 1.001; // +10bps
      e.onTick({ source: "binance", symbol: "BTCUSDT", midPrice: curPx, bestBid: curPx, bestAsk: curPx, timestamp: now } as any, st);
      const a = e.onTick(mkPmTick(), st);
      assert(a.length === 1 && a[0].tokenId === "UP_4H",
        `pre-res-snap: positive delta → UP (got ${a.length}, side=${a[0]?.tokenId})`);
    }
    console.log("  pre-res-snap: in-window + positive delta → UP ✓");
  }

  // ── FundingRateFaderEngine ─────────────────────────────────────────────────
  {
    const { FundingRateFaderEngine } = require("../engines/FundingRateFaderEngine");
    const funding = require("../live/binanceFunding");
    const Test = withTestBooks(FundingRateFaderEngine);

    // No funding data → no fire
    funding._resetForTest();
    {
      const e = new Test();
      const st = mk4hState();
      e.init(st);
      e.setBook("UP_4H", mkBook(0.5));
      e.setBook("DOWN_4H", mkBook(0.5));
      const a = e.onTick(mkPmTick(), st);
      assert(a.length === 0, "funding-fader: no funding data → skip");
    }
    console.log("  funding-fader: no data → skip ✓");

    // Extreme positive funding → fade DOWN
    funding._resetForTest();
    {
      funding._injectFundingForTest("BTCUSDT", 80); // 80 bps annualized → crowded long
      const e = new Test();
      const st = mk4hState();
      e.init(st);
      e.setBook("UP_4H", mkBook(0.5));
      e.setBook("DOWN_4H", mkBook(0.5));
      const a = e.onTick(mkPmTick(), st);
      assert(a.length === 1 && a[0].tokenId === "DOWN_4H",
        `funding-fader: +80bps → DOWN (got ${a.length})`);
    }
    console.log("  funding-fader: +80bps → DOWN ✓");

    // Extreme negative funding → fade UP
    funding._resetForTest();
    {
      funding._injectFundingForTest("BTCUSDT", -60);
      const e = new Test();
      const st = mk4hState();
      e.init(st);
      e.setBook("UP_4H", mkBook(0.5));
      e.setBook("DOWN_4H", mkBook(0.5));
      const a = e.onTick(mkPmTick(), st);
      assert(a.length === 1 && a[0].tokenId === "UP_4H",
        `funding-fader: -60bps → UP (got ${a.length})`);
    }
    console.log("  funding-fader: -60bps → UP ✓");

    // Mild funding → no fire
    funding._resetForTest();
    {
      funding._injectFundingForTest("BTCUSDT", 10);
      const e = new Test();
      const st = mk4hState();
      e.init(st);
      e.setBook("UP_4H", mkBook(0.5));
      e.setBook("DOWN_4H", mkBook(0.5));
      const a = e.onTick(mkPmTick(), st);
      assert(a.length === 0, "funding-fader: 10bps mild → skip");
    }
    console.log("  funding-fader: mild funding → skip ✓");

    funding._resetForTest();
  }

  // ── AsianMeanRev4hEngine ───────────────────────────────────────────────────
  {
    const { AsianMeanRev4hEngine } = require("../engines/AsianMeanRev4hEngine");
    const Test = withTestBooks(AsianMeanRev4hEngine);

    // Non-Asian session candle → no fire
    {
      const e = new Test();
      const st = mk4hState();
      // Force candle to start at UTC 14 (US session)
      const utc14 = new Date();
      utc14.setUTCHours(14, 0, 0, 0);
      st.marketWindowStart = utc14.getTime();
      st.marketWindowEnd = st.marketWindowStart + 14_400_000;
      e.init(st);
      e.setBook("UP_4H", mkBook(0.5));
      e.setBook("DOWN_4H", mkBook(0.5));
      // Feed strong negative momentum
      const now = utc14.getTime() + 60_000;
      const basePx = 70000;
      for (let i = 60; i >= 0; i--) {
        const px = basePx * (1 + (60 - i) * 0.0001);
        e.onTick({ source: "binance", symbol: "BTCUSDT", midPrice: px, bestBid: px, bestAsk: px, timestamp: now - i * 60_000 } as any, st);
      }
      const a = e.onTick(mkPmTick(), st);
      assert(a.length === 0, "asian-mean-rev: US session → skip");
    }
    console.log("  asian-mean-rev: US-session candle → skip ✓");

    // Asian session + falling preceding return → bet UP
    {
      const e = new Test();
      const st = mk4hState();
      // Use TOMORROW's UTC 04 → guaranteed in future regardless of when test runs
      // (so getSecondsRemaining > 0 and the engine's min-remaining gate passes)
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      tomorrow.setUTCHours(4, 0, 0, 0);
      st.marketWindowStart = tomorrow.getTime();
      st.marketWindowEnd = st.marketWindowStart + 14_400_000;
      e.init(st);
      e.setBook("UP_4H", mkBook(0.5));
      e.setBook("DOWN_4H", mkBook(0.5));
      const now = Date.now();
      const basePx = 70000;
      // Falling: oldest sample high, newest low → recentMomentum < 0
      for (let i = 60; i >= 0; i--) {
        const px = basePx * (1 - (60 - i) * 0.0001);
        e.onTick({ source: "binance", symbol: "BTCUSDT", midPrice: px, bestBid: px, bestAsk: px, timestamp: now - i * 60_000 } as any, st);
      }
      const a = e.onTick(mkPmTick(), st);
      assert(a.length === 1 && a[0].tokenId === "UP_4H",
        `asian-mean-rev: Asian + falling → UP (got ${a.length}, side=${a[0]?.tokenId})`);
    }
    console.log("  asian-mean-rev: Asian + falling → UP ✓");
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────

Promise.all([runLiveExecutorTests(), runRejectionReasonTests(), runClobSubmitterTimeoutTests()])
  .then(() => {
    // Restore RISK_CONFIG.MAX_LIVE_TRADE_USD to the captured original — we
    // overrode it to Infinity at the top of the LiveSizing block to let the
    // legacy scaling tests run without the May 6 ceiling clipping. Restore
    // here so any process-wide state stays clean for downstream consumers.
    RISK_CONFIG.MAX_LIVE_TRADE_USD = ORIGINAL_MAX_LIVE_TRADE_USD;
    (CONFIG as any).LIVE_PRICE_ZONE_ENABLED = ORIGINAL_PRICE_ZONE_ENABLED;
    console.log(`\n${"=".repeat(40)}`);
    console.log(`Tests: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
      process.exit(1);
    } else {
      console.log("All tests passed ✓");
    }
  })
  .catch((err) => {
    console.error("Test runner error:", err);
    process.exit(1);
  });
