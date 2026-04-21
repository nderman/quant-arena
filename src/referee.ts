/**
 * Quant Farm — Referee
 *
 * High-fidelity trade simulation with:
 * 1. Quartic Fee Model (2026 Polymarket): fee = 0.25 * (P*(1-P))², peaks at 1.56%
 * 2. Dual Orderbooks: UP and DOWN tokens have independent books (UP + DOWN ≠ $1)
 * 3. Directional Maker Fills: fill probability scales with Binance momentum
 * 4. Toxic Flow: adverse selection correlated with Binance delta
 * 5. MERGE: buy opposite side at real book price + dynamic gas
 * 6. Fill Decay: reactive MMs pull liquidity as you consume levels
 */

import { CONFIG } from "./config";
import { getBookForToken, getBinanceVolumeSpike, pulseEvents } from "./pulse";
import { random } from "./rng";
import type {
  EngineAction,
  FillResult,
  FeeAdjustedEdge,
  RefereeConfig,
  EngineState,
  OrderBook,
  MarketTick,
  OrderType,
  RejectionReason,
} from "./types";

// ── Binance momentum tracking (for correlated toxic flow) ────────────────────

const binanceState = new Map<string, { lastMid: number; delta: number }>();

// Sliding window of recent Binance moves (per symbol). Used by the
// stale-book / snipe-stale-makers guard: when Binance has moved
// significantly recently AND the local PM book hasn't been refreshed,
// the book is a stale snipe target and taker orders should be rejected
// (modeling real-world market maker cancellation latency, ~30-50ms).
const binanceMoveHistory: Map<string, { ts: number; delta: number }[]> = new Map();
const BINANCE_HISTORY_WINDOW_MS = 30_000; // keep ~30s of history

pulseEvents.on("binance_tick", (tick: MarketTick) => {
  const sym = tick.symbol.toUpperCase();
  const prev = binanceState.get(sym);
  const lastMid = prev?.lastMid ?? 0;
  const delta = lastMid > 0 ? (tick.midPrice - lastMid) / lastMid : 0;
  binanceState.set(sym, { lastMid: tick.midPrice, delta });

  // Append to sliding history; trim anything older than the window
  const now = Date.now();
  let history = binanceMoveHistory.get(sym);
  if (!history) {
    history = [];
    binanceMoveHistory.set(sym, history);
  }
  history.push({ ts: now, delta });
  const cutoff = now - BINANCE_HISTORY_WINDOW_MS;
  while (history.length > 0 && history[0].ts < cutoff) history.shift();
});

function getBinanceDelta(): number {
  // Use the primary symbol's delta, fallback to any available
  const primary = CONFIG.BINANCE_SYMBOL.toUpperCase();
  const state = binanceState.get(primary);
  if (state) return state.delta;
  for (const [, s] of binanceState) return s.delta;
  return 0;
}

/**
 * Cumulative Binance momentum over the last `windowMs` milliseconds.
 * Returns the sum of per-tick deltas (negative for downward, positive for up).
 */
function getRecentBinanceMomentum(windowMs: number, now: number = Date.now()): number {
  const primary = CONFIG.BINANCE_SYMBOL.toUpperCase();
  const history = binanceMoveHistory.get(primary);
  if (!history || history.length === 0) return 0;
  const cutoff = now - windowMs;
  let sum = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].ts < cutoff) break;
    sum += history[i].delta;
  }
  return sum;
}

/**
 * Returns true if the order should be rejected because we're sniping a
 * stale book during a Binance move (modeling real-world MM cancellation
 * latency, ~30-50ms). Exported for testing.
 *
 * Model:
 *   1. Sum Binance momentum over the last SNIPE_MOMENTUM_WINDOW_MS.
 *   2. If |momentum| < SNIPE_MIN_MOMENTUM, no snipe risk — calm market.
 *   3. If the book.timestamp < SNIPE_BOOK_STALE_MS old, MMs already
 *      re-quoted, not a stale target.
 *   4. Otherwise, reject with probability scaling linearly with momentum
 *      in basis points: 5 bps → ~50%, 10 bps → ~95% (capped).
 */
export function shouldRejectStaleSnipe(book: OrderBook, isMaker: boolean): boolean {
  // Makers aren't snipers — they post liquidity, not consume it.
  if (isMaker) return false;
  if (!book.timestamp) return false;

  const now = Date.now();
  const recentMomentum = Math.abs(getRecentBinanceMomentum(CONFIG.SNIPE_MOMENTUM_WINDOW_MS, now));
  if (recentMomentum < CONFIG.SNIPE_MIN_MOMENTUM) return false;

  const bookAgeMs = now - book.timestamp;
  if (bookAgeMs < CONFIG.SNIPE_BOOK_STALE_MS) return false;

  // Linear in basis points: per-bps slope × momentum-in-bps, capped at MAX.
  // At default 0.10/bps × 5bps = 0.50; × 10bps = 1.0 → capped to 0.95.
  const momentumBps = recentMomentum * 10_000;
  const cancelProb = Math.min(CONFIG.SNIPE_CANCEL_PROB_MAX, momentumBps * CONFIG.SNIPE_CANCEL_PROB_PER_BPS);
  return random() < cancelProb;
}

/**
 * Returns true if the taker order should be rejected because competing
 * real-world takers raced us to visibly cheap liquidity. Complements
 * `shouldRejectStaleSnipe` (which models MMs pulling quotes on Binance
 * moves) — this one models other humans/bots seeing the same obvious
 * opportunity we do.
 *
 * Model:
 *   1. Only fires for taker BUYs below COMPETE_MAX_PRICE (default 20¢) —
 *      the extreme-underdog zone where asymmetric payoff is publicly
 *      visible on PM's leaderboard and price history.
 *   2. Cheaper price = more obvious opportunity = more competition.
 *      Linear scale from MAX_PRICE→0 to 0→COMPETE_PROB_MAX.
 *   3. Larger size = higher collision probability with racing takers.
 *      Linear scale from 0→SIZE_CAP, clipped to [0,1].
 *   4. Final prob = priceFactor × sizeFactor × PROB_MAX.
 *
 * Examples at default config (MAX_PRICE=0.20, PROB_MAX=0.50, SIZE_CAP=50):
 *   price=0.05, size=50 → 0.75 × 1.00 × 0.50 = 37.5%
 *   price=0.05, size=10 → 0.75 × 0.20 × 0.50 = 7.5%
 *   price=0.15, size=50 → 0.25 × 1.00 × 0.50 = 12.5%
 *   price=0.25, size=50 → 0 (above max — no competition)
 */
export function shouldRejectCompetingTaker(
  price: number,
  size: number,
  isMaker: boolean,
): boolean {
  if (!CONFIG.COMPETE_ENABLED) return false;
  if (isMaker) return false; // makers post liquidity, aren't racing
  if (price <= 0 || price >= CONFIG.COMPETE_MAX_PRICE) return false;

  const priceFactor = (CONFIG.COMPETE_MAX_PRICE - price) / CONFIG.COMPETE_MAX_PRICE;
  const sizeFactor = Math.min(1, size / CONFIG.COMPETE_SIZE_CAP);
  const prob = priceFactor * sizeFactor * CONFIG.COMPETE_PROB_MAX;
  return random() < prob;
}

/** Build a "not filled" FillResult for the rejection paths. */
function makeRejectedFill(
  action: EngineAction,
  latencyMs: number,
  reason: RejectionReason,
  orderType: "maker" | "taker" = "taker",
): FillResult {
  return {
    action, filled: false, fillPrice: 0, fillSize: 0,
    fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs,
    toxicFlowHit: false, orderType, rejectionReason: reason,
  };
}

/**
 * Increment `state.rejectionCounts[reason]` for every unfilled result in
 * `results`. Call from processActions after producing a batch so arena-side
 * consumers don't each need to re-walk the results for bookkeeping.
 */
function tallyRejections(results: FillResult[], state: EngineState): void {
  for (const r of results) {
    if (!r.filled && r.rejectionReason) {
      state.rejectionCounts[r.rejectionReason] =
        (state.rejectionCounts[r.rejectionReason] ?? 0) + 1;
    }
  }
}

// ── Maker Rebate Pool ───────────────────────────────────────────────────────
// Tracks total taker fees collected per market. Makers get a share of the pool.
const takerFeePool = new Map<string, { fees: number; volume: number }>(); // tokenId → accumulated stats

/** Record a taker fee into the pool for later maker rebates */
function addToTakerFeePool(tokenId: string, fee: number, size: number): void {
  const entry = takerFeePool.get(tokenId) ?? { fees: 0, volume: 0 };
  entry.fees += fee;
  entry.volume += size;
  takerFeePool.set(tokenId, entry);
}

/** Calculate maker rebate: pro-rata share of accumulated taker fees based on actual market volume.
 *  Debits the pool so the same fees can't be claimed multiple times. */
function calculateMakerRebate(tokenId: string, fillSize: number): number {
  const entry = takerFeePool.get(tokenId);
  if (!entry || entry.fees <= 0 || entry.volume <= 0) return 0;
  const shareOfPool = Math.min(fillSize / entry.volume, 1);
  const rebate = entry.fees * CONFIG.MAKER_REBATE_RATE * shareOfPool;
  // Debit the pool so these fees can't be claimed again
  entry.fees = Math.max(0, entry.fees - rebate / CONFIG.MAKER_REBATE_RATE);
  entry.volume = Math.max(0, entry.volume - fillSize);
  return rebate;
}

/** Clear the fee pool (round reset) */
export function clearFeePool(): void {
  takerFeePool.clear();
}

/** Remove a specific market from the fee pool (market rotation cleanup) */
export function clearFeePoolForMarket(tokenId: string): void {
  takerFeePool.delete(tokenId);
}

// ── Referee Configuration ────────────────────────────────────────────────────

const defaultConfig: RefereeConfig = {
  peakFeeRate: CONFIG.PEAK_FEE_RATE,
  latencyMs: CONFIG.LATENCY_MS,
  mergeFeeRate: CONFIG.MERGE_FEE_RATE,
  enableToxicFlow: CONFIG.TOXIC_FLOW_ENABLED,
  toxicFlowProbability: CONFIG.TOXIC_FLOW_PROBABILITY,
  toxicFlowBps: CONFIG.TOXIC_FLOW_BPS,
};

let config: RefereeConfig = { ...defaultConfig };

// Precomputed maker adverse selection multipliers (avoid division per fill)
const MAKER_ADVERSE_BUY = 1 + CONFIG.MAKER_ADVERSE_BPS / 10000;   // worse entry (higher price)
const MAKER_ADVERSE_SELL = 1 - CONFIG.MAKER_ADVERSE_BPS / 10000;  // worse exit (lower price)

export function setRefereeConfig(overrides: Partial<RefereeConfig>): void {
  config = { ...defaultConfig, ...overrides };
}

// ── Fee Calculation ──────────────────────────────────────────────────────────

/**
 * 2026 Polymarket Dynamic Taker Fee (Quartic)
 *
 * fee = amount * 0.25 * (P * (1-P))²
 *
 * At P=0.50: 1.5625% (maximum — kills most edges at mid-price)
 * At P=0.90: 0.20% (very manageable — edge trading sweet spot)
 * At P=0.99: 0.002% (near zero)
 *
 * Drops off much faster than the old parabolic curve, heavily favoring edge trades.
 */
export function calculateFee(price: number, amount: number): number {
  const p = Math.max(0.001, Math.min(0.999, price));
  const pq = p * (1 - p);
  // Quartic coefficient = peakRate / 0.0625 (0.0625 = pq² at P=0.50)
  const coeff = config.peakFeeRate / 0.0625;
  return amount * coeff * pq * pq;
}

/**
 * Merge fee — flat gas offset, bypasses the parabolic curve.
 * Used when buying YES + NO and merging for $1.00.
 */
export function calculateMergeFee(amount: number): number {
  return amount * config.mergeFeeRate;
}

/** Round price to PM tick size ($0.001) */
function tickRound(price: number): number {
  return Math.round(price * 1000) / 1000;
}

/**
 * Fee-Adjusted Edge Calculator
 *
 * Tells an engine whether a trade is profitable AFTER the P(1-P) tax.
 * This is the critical function that makes or breaks a strategy at mid-prices.
 */
export function calculateFeeAdjustedEdge(
  modelProb: number,
  marketPrice: number,
): FeeAdjustedEdge {
  const rawEdge = modelProb - marketPrice;
  const pq = marketPrice * (1 - marketPrice);
  const coeff = config.peakFeeRate / 0.0625;
  const feePerDollar = coeff * pq * pq;
  const netEdge = rawEdge - feePerDollar;
  return {
    rawEdge,
    feeAtPrice: feePerDollar,
    netEdge,
    profitable: netEdge > 0,
    breakeven: feePerDollar,  // minimum raw edge needed
  };
}

// ── Book Walking ─────────────────────────────────────────────────────────────

/**
 * Walk the orderbook to calculate the effective fill price for a given size.
 * Returns null if insufficient liquidity.
 *
 * BUY walks asks (ascending), SELL walks bids (descending).
 * This prevents "impossible fills" where 48 shares fill at the best price
 * when only 5 shares are available at that level.
 */
/**
 * Walk the orderbook with fill decay.
 *
 * Fill decay models reactive market makers who pull liquidity as you consume it.
 * For each level consumed, subsequent levels get worse by FILL_DECAY_MULTIPLIER.
 * e.g. with 1.2x decay: level 1 at $0.94, level 2 at $0.94*1.2 spread, etc.
 *
 * Returns null if insufficient liquidity.
 * Returns { filled, remaining } for partial fill support.
 */
/**
 * Returns true if a book has the structural shape of real PM data:
 *  - Both bids AND asks present (not one-sided)
 *  - NOT crossed (best bid < best ask)
 *  - Best prices in (PM_PRICE_MIN, PM_PRICE_MAX) — outside this range is
 *    almost certainly stale/corrupt, not real PM market state
 *  - Spread < PM_BOOK_MAX_SPREAD (wider means book is half-empty)
 *  - Timestamp < PM_BOOK_STALE_MS old (no stale snapshots)
 *
 * Exported so engines can pre-check book quality before submitting orders
 * (avoids silent walkBook rejections).
 */
export function isBookTradeable(book: OrderBook): boolean {
  if (!book.bids.length || !book.asks.length) return false;
  const bestBid = book.bids[0].price;
  const bestAsk = book.asks[0].price;
  // Crossed book detection — bestBid must be strictly less than bestAsk.
  // The spread check below would NOT catch this (a negative spread is not
  // > PM_BOOK_MAX_SPREAD), so we need an explicit check.
  if (bestBid >= bestAsk) return false;
  if (bestAsk <= CONFIG.PM_PRICE_MIN || bestAsk >= CONFIG.PM_PRICE_MAX) return false;
  if (bestBid <= CONFIG.PM_PRICE_MIN || bestBid >= CONFIG.PM_PRICE_MAX) return false;
  if (bestAsk - bestBid > CONFIG.PM_BOOK_MAX_SPREAD) return false;
  if (book.timestamp && Date.now() - book.timestamp > CONFIG.PM_BOOK_STALE_MS) return false;
  return true;
}

// Exported for unit tests — pure function, no side effects unless mutate=true
export function walkBook(
  size: number,
  side: "BUY" | "SELL",
  book: OrderBook,
  minFillSize: number = CONFIG.MIN_ORDER_SIZE,
  mutate: boolean = false,
  limitPrice?: number,
): { effectivePrice: number; totalCost: number; filledSize: number } | null {
  if (!isBookTradeable(book)) return null;
  const levels = side === "BUY" ? book.asks : book.bids;

  const decayEnabled = CONFIG.FILL_DECAY_ENABLED;
  const decayMult = CONFIG.FILL_DECAY_MULTIPLIER;

  let remaining = size;
  let totalCost = 0;
  let levelsConsumed = 0;
  let filledSize = 0;
  // Track depletion offsets per level if mutating
  const depletions: number[] = mutate ? new Array(levels.length).fill(0) : [];

  for (let i = 0; i < levels.length; i++) {
    const level = levels[i];
    const take = Math.min(remaining, level.size);
    if (take <= 0) continue;

    // Fill decay: each level consumed makes remaining levels worse
    let levelPrice = level.price;
    if (decayEnabled && levelsConsumed > 0) {
      const decayFactor = Math.pow(decayMult, levelsConsumed);
      if (side === "BUY") {
        levelPrice = Math.min(level.price * decayFactor, 0.999);  // cap at PM max
      } else {
        levelPrice = Math.max(level.price / decayFactor, 0.001);  // floor at PM min
      }
    }

    totalCost += take * levelPrice;
    remaining -= take;
    filledSize += take;
    if (mutate) depletions[i] = take;
    if (take >= level.size * 0.5) levelsConsumed++;   // only decay if we ate >50% of a level

    if (remaining <= 0) break;
  }

  if (filledSize < minFillSize) return null;

  // Limit price enforcement: if a limit was specified, the effective fill must
  // be at or better than it. Real CLOB rejects fills outside the limit.
  // Without this check, "limit BUY at $0.01" can fill at $0.99 (whatever the
  // book has), turning every order into a market order.
  const effectivePrice = totalCost / filledSize;
  if (limitPrice !== undefined && limitPrice > 0) {
    if (side === "BUY" && effectivePrice > limitPrice) return null;
    if (side === "SELL" && effectivePrice < limitPrice) return null;
  }

  // Apply depletions to the book (mutate mode only, after we've confirmed fill)
  if (mutate) {
    for (let i = depletions.length - 1; i >= 0; i--) {
      if (depletions[i] > 0) {
        levels[i].size -= depletions[i];
        if (levels[i].size <= 0.001) levels.splice(i, 1);
      }
    }
  }

  return {
    effectivePrice: totalCost / filledSize,
    totalCost,
    filledSize,
  };
}

// ── Toxic Flow Simulation ────────────────────────────────────────────────────

/**
 * Simulates adverse selection during the latency window.
 *
 * Correlated with Binance momentum — toxic flow isn't random, it happens
 * because Binance moved first and HFT snipers see your order in the mempool.
 *
 * When |binanceDelta| > 10bps: toxic flow is near-certain (90%)
 * When |binanceDelta| < 10bps: falls back to base probability (15%)
 */
function simulateToxicFlow(
  action: EngineAction,
  tickBooks?: TickBooks,
): { adjustedPrice: number; toxicHit: boolean; slippage: number } {
  if (!config.enableToxicFlow) {
    return { adjustedPrice: action.price, toxicHit: false, slippage: 0 };
  }

  const absDelta = Math.abs(getBinanceDelta());
  let toxicProb = absDelta > 0.001 ? 0.90     // Binance moved >10bps → 90% toxic
    : absDelta > 0.0005 ? 0.50                 // 5-10bps → 50%
    : config.toxicFlowProbability;              // quiet → base 15%

  // Volume spikes increase toxic flow — large turnover = informed flow
  const volSpike = getBinanceVolumeSpike();
  if (volSpike > 3) toxicProb = Math.min(0.95, toxicProb + 0.40);
  else if (volSpike > 2) toxicProb = Math.min(0.95, toxicProb + 0.20);
  else if (volSpike > 1.5) toxicProb = Math.min(0.95, toxicProb + 0.10);

  if (random() > toxicProb) {
    return { adjustedPrice: action.price, toxicHit: false, slippage: 0 };
  }

  // Magnitude scales with Binance move size, floored at config minimum
  const bpsMagnitude = Math.max(config.toxicFlowBps / 10000, absDelta * 2);

  if (action.side === "BUY") {
    const adversePrice = action.price * (1 + bpsMagnitude);
    const currentBook = bookFromTick(action.tokenId, tickBooks);
    const currentAsk = currentBook.asks[0]?.price ?? action.price;
    const fillPrice = Math.max(currentAsk, adversePrice);
    return {
      adjustedPrice: Math.min(fillPrice, 0.99),
      toxicHit: true,
      slippage: fillPrice - action.price,
    };
  } else if (action.side === "SELL") {
    const adversePrice = action.price * (1 - bpsMagnitude);
    const currentBook = bookFromTick(action.tokenId, tickBooks);
    const currentBid = currentBook.bids[0]?.price ?? action.price;
    const fillPrice = Math.min(currentBid, adversePrice);
    return {
      adjustedPrice: Math.max(fillPrice, 0.01),
      toxicHit: true,
      slippage: action.price - fillPrice,
    };
  }

  return { adjustedPrice: action.price, toxicHit: false, slippage: 0 };
}

// ── Fill Simulation ──────────────────────────────────────────────────────────

/**
 * Process a single engine action through the referee.
 *
 * Steps:
 * 1. Validate action against engine state (sufficient cash/shares)
 * 2. Apply latency delay
 * 3. Check for toxic flow (adverse price movement)
 * 4. Calculate parabolic fee (or flat merge fee)
 * 5. Return fill result
 */
/** Per-tick book snapshot — eagerly cloned at snapshot time, mutated as engines deplete liquidity. */
export interface TickBooks {
  upTokenId: string;
  downTokenId: string;
  /** Cache of cloned books keyed by tokenId. UP and DOWN are cloned eagerly at
   * snapshot creation; any other token (rare, e.g. expired) is lazy-cloned on
   * first access. Eager cloning ensures the engine sees a consistent moment-
   * in-time view, not whatever the live book happened to be at first access. */
  bookCache: Map<string, OrderBook>;
}

function cloneBook(book: OrderBook): OrderBook {
  return {
    bids: book.bids.map(l => ({ price: l.price, size: l.size })),
    asks: book.asks.map(l => ({ price: l.price, size: l.size })),
    timestamp: book.timestamp,
  };
}

/** Create a per-tick snapshot. UP and DOWN books are cloned eagerly so all
 * engines processed in this tick see the same moment-in-time state. */
export function snapshotTickBooks(upTokenId: string, downTokenId: string): TickBooks {
  const bookCache = new Map<string, OrderBook>();
  if (upTokenId) bookCache.set(upTokenId, cloneBook(getBookForToken(upTokenId)));
  if (downTokenId) bookCache.set(downTokenId, cloneBook(getBookForToken(downTokenId)));
  return {
    upTokenId,
    downTokenId,
    bookCache,
  };
}

function bookFromTick(tokenId: string, tick?: TickBooks): OrderBook {
  if (!tick) return getBookForToken(tokenId);
  let cached = tick.bookCache.get(tokenId);
  if (!cached) {
    cached = cloneBook(getBookForToken(tokenId));
    tick.bookCache.set(tokenId, cached);
  }
  return cached;
}

async function processActionNoLatency(
  action: EngineAction,
  state: EngineState,
  tickBooks?: TickBooks,
): Promise<FillResult> {

  // ── TokenId validation: reject trades for unknown tokens ──
  // Only the current active market's tokens are tradeable. Expired markets settle at $1/$0.
  if (action.side !== "HOLD") {
    const isActiveToken = action.tokenId === state.activeTokenId || action.tokenId === state.activeDownTokenId;
    if (!isActiveToken) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: 0,
        toxicFlowHit: false, orderType: action.orderType ?? "taker",
        rejectionReason: "invalid_token",
      };
    }
  }

  // ── Price sanity: PM prices must be 0-1, reject Binance price contamination ──
  if (action.side !== "HOLD" && action.side !== "MERGE") {
    if (action.price < 0.001 || action.price > 1.0) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: 0,
        toxicFlowHit: false, orderType: action.orderType ?? "taker",
        rejectionReason: "fill_price_out_of_range",
      };
    }
  }

  // HOLD — no-op (not a rejection; filled=false is the expected response)
  if (action.side === "HOLD") {
    return {
      action, filled: false, fillPrice: 0, fillSize: 0,
      fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: 0,
      toxicFlowHit: false, orderType: "taker",
    };
  }

  const actualLatency = config.latencyMs;

  // ── MERGE action (Flavor A only) ──
  // Engine must already hold both sides of the same conditional pair.
  // Flavor B (buy opposite + merge atomically) was removed — see git history
  // for the bred-5h5h exploit chain. To emulate B: emit BUY then MERGE on
  // separate ticks. Future-correct version is task #11 (FOK + atomic batches).
  if (action.side === "MERGE") {
    // Merge finality guard: the tx takes ON_CHAIN_LATENCY_MS to land on Polygon.
    // If the candle settles before the merge mines, the conditional-token contract
    // rejects the merge (tokens are already resolved). Engines can't game the
    // 3-second oracle window.
    if (state.marketWindowEnd && Date.now() + CONFIG.ON_CHAIN_LATENCY_MS > state.marketWindowEnd) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: false, orderType: "taker",
        rejectionReason: "merge_window_closed",
      };
    }

    // Must hold a position to merge — reject if no position or insufficient shares
    const pos = state.positions.get(action.tokenId);
    if (!pos || pos.shares < CONFIG.MIN_MERGE_SIZE) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: false, orderType: "taker",
        rejectionReason: "no_position",
      };
    }

    // Clamp merge size to actual position — can't merge more than you hold
    const shares = Math.min(action.size, pos.shares);
    if (shares < CONFIG.MIN_MERGE_SIZE) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: false, orderType: "taker",
        rejectionReason: "size_below_min",
      };
    }

    // Stale position guard: reject merges on positions whose token isn't part
    // of the current active market. Real PM enforces this via conditionId
    // matching; without it, "opposite" resolves to a different pair entirely.
    const isCurrentMarket =
      action.tokenId === state.activeTokenId ||
      action.tokenId === state.activeDownTokenId;
    if (!isCurrentMarket) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: false, orderType: "taker",
        rejectionReason: "invalid_token",
      };
    }

    // Determine the opposite token
    const isHoldingDown = pos.side === "NO";
    const oppositeTokenId = isHoldingDown ? state.activeTokenId : state.activeDownTokenId;

    // ── Flavor A: do we already hold the opposite? ──
    const oppositePos = state.positions.get(oppositeTokenId);
    const haveBothSides = oppositePos && oppositePos.shares > 0;
    if (haveBothSides) {
      const mergeShares = Math.min(shares, oppositePos.shares);
      if (mergeShares >= CONFIG.MIN_MERGE_SIZE) {
        // Gas only — no opposite buy needed
        const absDelta = Math.abs(getBinanceDelta());
        const volMultiplier = 1 + (CONFIG.GAS_VOL_MULTIPLIER - 1) * Math.min(absDelta / 0.005, 1);
        const gasCost = CONFIG.GAS_COST_USD * volMultiplier;
        const mergeValue = mergeShares * 1.0;
        const mergeFlatFee = calculateMergeFee(mergeValue);
        const totalCost = mergeFlatFee + gasCost;
        const totalFee = mergeFlatFee + gasCost;

        if (state.cashBalance < totalCost) {
          return {
            action, filled: false, fillPrice: 0, fillSize: 0,
            fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
            toxicFlowHit: false, orderType: "taker",
            rejectionReason: "insufficient_cash",
          };
        }

        // P&L: $1/share - cost basis of BOTH sides - gas
        const myCostBasis = pos.avgEntry * mergeShares;
        const oppositeCostBasis = oppositePos.avgEntry * mergeShares;
        const pnl = mergeValue - myCostBasis - oppositeCostBasis - totalCost;

        state.cashBalance -= totalCost;
        state.cashBalance += mergeValue;
        state.feePaid += totalFee;
        state.roundPnl += pnl;

        pos.shares -= mergeShares;
        pos.costBasis -= myCostBasis;
        if (pos.shares <= 0.001) state.positions.delete(action.tokenId);

        oppositePos.shares -= mergeShares;
        oppositePos.costBasis -= oppositeCostBasis;
        if (oppositePos.shares <= 0.001) state.positions.delete(oppositeTokenId);

        return {
          action, filled: true, fillPrice: 1.0, fillSize: mergeShares,
          fee: totalFee, rebate: 0, slippage: 0, pnl, latencyMs: actualLatency,
          toxicFlowHit: false, orderType: "taker",
        };
      }
    }

    // No Flavor B: engine doesn't hold the opposite side. Reject the merge.
    // The engine must explicitly BUY the opposite side via a separate action,
    // then re-call MERGE on a subsequent tick when both positions are held.
    return {
      action, filled: false, fillPrice: 0, fillSize: 0,
      fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
      toxicFlowHit: false, orderType: "taker",
      rejectionReason: "no_position",
    };
  }

  // ── Min order size check ──
  if (action.size < CONFIG.MIN_ORDER_SIZE) {
    return {
      action, filled: false, fillPrice: 0, fillSize: 0,
      fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
      toxicFlowHit: false, orderType: action.orderType ?? "taker",
      rejectionReason: "size_below_min",
    };
  }

  // ── Directional maker fill probability ──
  // In a trending market, asks fill instantly (takers snipe them), bids never fill.
  const isMakerOrder = action.orderType === "maker";
  if (isMakerOrder) {
    const delta = getBinanceDelta();
    const sensitivity = 50.0; // 10bps move = 50% adjustment
    const adjustment = delta * sensitivity;
    let fillProb = CONFIG.MAKER_FILL_PROBABILITY;
    if (action.side === "BUY") {
      fillProb = Math.max(0.05, Math.min(0.95, fillProb - adjustment)); // price up → bids less likely
    } else {
      fillProb = Math.max(0.05, Math.min(0.95, fillProb + adjustment)); // price up → asks more likely
    }
    if (random() > fillProb) {
      // GTC: instead of rejecting, store the order for future fill attempts.
      // The order sits on the book and fills when the market crosses the limit.
      if (action.price > 0 && action.size >= CONFIG.MIN_ORDER_SIZE) {
        // Snapshot queue depth: total shares ahead of us at our price level or better.
        // For BUY: sum all bid sizes at prices >= our limit (they posted before us).
        // For SELL: sum all ask sizes at prices <= our limit.
        const gtcBook = bookFromTick(action.tokenId, tickBooks);
        const initialDepth = bookDepthAtPrice(gtcBook, action.side as "BUY" | "SELL", action.price);
        addGtcOrder({
          engineId: state.engineId,
          action,
          state,
          postedAt: Date.now(),
          tokenId: action.tokenId,
          side: action.side as "BUY" | "SELL",
          limitPrice: action.price,
          size: action.size,
          queueAttempts: 0,
          sharesAhead: initialDepth,
          lastBookDepth: initialDepth,
        });
      }
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: false, orderType: "maker",
        rejectionReason: "maker_not_filled",
      };
    }
  }

  // ── Toxic flow check (re-check book after latency) ──
  // Makers don't suffer toxic flow — they set the price, takers cross it
  const { adjustedPrice, toxicHit, slippage } = isMakerOrder
    ? { adjustedPrice: action.price, toxicHit: false, slippage: 0 }
    : simulateToxicFlow(action, tickBooks);

  // Detect DOWN token for position side tracking
  const isDownToken = !!(state.activeDownTokenId && action.tokenId === state.activeDownTokenId);

  // Dual-book consistency: in real PM, UP_ask + DOWN_ask is always near $1.00
  // (Croissant's tightest observed sum was $0.91). If both sides' books are
  // showing impossibly cheap prices (sum < $0.85), the data is stale or
  // corrupted — reject the trade. Catches the bred-5h5h Gemini-audit pattern
  // where extreme-underdog buys at $0.01-$0.04 happened against books that
  // wouldn't exist in real PM.
  if (action.side === "BUY" || action.side === "SELL") {
    const oppositeTokenId =
      action.tokenId === state.activeTokenId ? state.activeDownTokenId :
      action.tokenId === state.activeDownTokenId ? state.activeTokenId :
      "";
    if (oppositeTokenId) {
      const thisBook = bookFromTick(action.tokenId, tickBooks);
      const oppBook = bookFromTick(oppositeTokenId, tickBooks);
      const thisAsk = thisBook.asks[0]?.price;
      const oppAsk = oppBook.asks[0]?.price;
      const now = Date.now();

      // Reject when the dual-book sum is structurally impossible (<0.95).
      if (thisAsk !== undefined && oppAsk !== undefined && (thisAsk + oppAsk) < CONFIG.DUAL_BOOK_MIN_SUM) {
        return {
          action, filled: false, fillPrice: 0, fillSize: 0,
          fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
          toxicFlowHit: false, orderType: action.orderType ?? "taker",
          rejectionReason: "dual_book_inconsistent",
        };
      }

      // Reject when the OPPOSITE book is stale while our target is fresh.
      // In real PM the two sides stay arb'd within ~100ms; if one side has
      // gone silent for >PM_BOOK_STALE_MS while the other is active, the
      // "gap" between them is data artifact, not a real opportunity. This
      // is the stale-side exploit class (one book frozen while the other
      // updates — merge-arb-sniper-v1 harvested $59 from this on Apr 11).
      if (oppBook.timestamp && now - oppBook.timestamp > CONFIG.PM_BOOK_STALE_MS) {
        return {
          action, filled: false, fillPrice: 0, fillSize: 0,
          fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
          toxicFlowHit: false, orderType: action.orderType ?? "taker",
          rejectionReason: "dual_book_inconsistent",
        };
      }
    }
  }

  // ── BUY action (off-chain CLOB — no gas) ──
  // Each token has its own real book — no price inversion needed
  if (action.side === "BUY") {
    const isMaker = action.orderType === "maker";
    const tokenBook = bookFromTick(action.tokenId, tickBooks);

    // Stale-book / snipe-stale-makers guard. In real PM, market makers
    // cancel/re-quote within ~30-50ms of significant Binance moves. Our sim
    // approximates: if Binance has moved meaningfully recently AND the book
    // hasn't been refreshed since, reject the taker fill (modeling MM cancel).
    if (shouldRejectStaleSnipe(tokenBook, isMaker)) {
      return makeRejectedFill(action, actualLatency, "stale_snipe");
    }

    // Competing-taker guard. When the price is visibly cheap, real-world
    // takers (humans + bots) race us for the same liquidity. The cheaper
    // the price, the more obvious the asymmetric-payoff opportunity, the
    // more competition. Fires in calm markets — complements stale-snipe.
    const takerRefPrice = action.price > 0 ? action.price : (tokenBook.asks[0]?.price ?? 0);
    if (shouldRejectCompetingTaker(takerRefPrice, action.size, isMaker)) {
      return makeRejectedFill(action, actualLatency, "competing_taker");
    }

    // Post-Only enforcement: maker BUY must NOT cross the spread. If the
    // engine's limit price is at or above bestAsk, the order would execute
    // immediately as a taker. Reject (matches real PM Post-Only behavior).
    if (isMaker && action.price > 0) {
      const bestAsk = tokenBook.asks[0]?.price;
      if (bestAsk !== undefined && action.price >= bestAsk) {
        return {
          action, filled: false, fillPrice: 0, fillSize: 0,
          fee: 0, rebate: 0, slippage, pnl: 0, latencyMs: actualLatency,
          toxicFlowHit: toxicHit, orderType: "maker",
          rejectionReason: "post_only_cross",
        };
      }
    }

    // Pre-check book tradability so walkBook==null below unambiguously means
    // "enough depth was there but limit or size constraint failed".
    if (!isBookTradeable(tokenBook)) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: toxicHit, orderType: isMaker ? "maker" : "taker",
        rejectionReason: "book_not_tradeable",
      };
    }

    // Limit price enforcement: action.price (when > 0) is the engine's max
    // acceptable fill. walkBook will reject if it would walk to a worse price.
    const limit = action.price > 0 ? action.price : undefined;
    const walked = walkBook(action.size, "BUY", tokenBook, CONFIG.MIN_ORDER_SIZE, !!tickBooks, limit);

    // After the isBookTradeable pre-check, walked==null means either the
    // limit was breached OR the walked fill fell below MIN_ORDER_SIZE (thin
    // depth). Prefer limit_violated when a limit was given; otherwise the
    // walk ran out of liquidity before MIN_ORDER_SIZE.
    if (!walked) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: toxicHit, orderType: isMaker ? "maker" : "taker",
        rejectionReason: limit !== undefined ? "limit_violated" : "size_below_min",
      };
    }

    const fillSize = walked.filledSize;
    // Makers fill at their limit but suffer adverse selection (price was moving through them)
    let fillPrice = isMaker ? walked.effectivePrice : Math.max(walked.effectivePrice, adjustedPrice);
    if (isMaker) {
      fillPrice *= MAKER_ADVERSE_BUY;
    }
    fillPrice = tickRound(fillPrice);

    // Reject if fill price is outside PM range (Binance price contamination via book)
    if (fillPrice < 0.001 || fillPrice > 1.0) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: toxicHit, orderType: isMaker ? "maker" : "taker",
        rejectionReason: "fill_price_out_of_range",
      };
    }

    const totalCost = fillPrice * fillSize;

    // Makers pay 0% fee; takers pay parabolic fee
    const fee = isMaker ? 0 : calculateFee(fillPrice, totalCost);

    // No gas for CLOB trades (off-chain EIP-712 signatures)

    // MEV slippage on large orders
    let mevCost = 0;
    if (totalCost > CONFIG.MEV_THRESHOLD_USD) {
      mevCost = totalCost * (CONFIG.MEV_SLIPPAGE_BPS / 10000);
    }

    const totalWithFriction = totalCost + fee + mevCost;

    if (state.cashBalance < totalWithFriction) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: toxicHit, orderType: isMaker ? "maker" : "taker",
        rejectionReason: "insufficient_cash",
      };
    }

    // Track taker fees in the pool for maker rebates
    if (!isMaker && fee > 0) {
      addToTakerFeePool(action.tokenId, fee, fillSize);
    }

    // Maker rebate: pro-rata share of accumulated taker fees
    let rebate = 0;
    if (isMaker) {
      rebate = calculateMakerRebate(action.tokenId, fillSize);
    }

    // Update state
    state.cashBalance -= totalWithFriction;
    state.cashBalance += rebate;
    state.feePaid += fee + mevCost;
    state.feeRebate += rebate;
    state.slippageCost += slippage * fillSize;
    state.tradeCount++;

    // Update position
    const positionSide = isDownToken ? "NO" : "YES";
    const existing = state.positions.get(action.tokenId);
    if (existing) {
      const newShares = existing.shares + fillSize;
      const newCost = existing.costBasis + totalCost;
      existing.shares = newShares;
      existing.costBasis = newCost;
      existing.avgEntry = newCost / newShares;
    } else {
      state.positions.set(action.tokenId, {
        tokenId: action.tokenId,
        side: positionSide,
        shares: fillSize,
        avgEntry: fillPrice,
        costBasis: totalCost,
      });
    }

    return {
      action, filled: true, fillPrice, fillSize,
      fee: fee + mevCost, rebate, slippage, pnl: 0,
      latencyMs: actualLatency, toxicFlowHit: toxicHit,
      orderType: isMaker ? "maker" : "taker",
    };
  }

  // ── SELL action (off-chain CLOB — no gas) ──
  if (action.side === "SELL") {
    const isMaker = action.orderType === "maker";
    const pos = state.positions.get(action.tokenId);
    if (!pos || pos.shares < CONFIG.MIN_ORDER_SIZE) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: toxicHit, orderType: isMaker ? "maker" : "taker",
        rejectionReason: pos ? "insufficient_shares" : "no_position",
      };
    }

    // Clamp sell size to available shares, enforce min 5
    const sellSize = Math.min(action.size, pos.shares);
    if (sellSize < CONFIG.MIN_ORDER_SIZE) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: toxicHit, orderType: isMaker ? "maker" : "taker",
        rejectionReason: "size_below_min",
      };
    }

    // Each token has its own real book — no price inversion needed
    const tokenBook = bookFromTick(action.tokenId, tickBooks);

    // Stale-book guard: same as BUY path. Sniping stale bid liquidity during
    // Binance moves models real MM cancellation latency.
    if (shouldRejectStaleSnipe(tokenBook, isMaker)) {
      return makeRejectedFill(action, actualLatency, "stale_snipe");
    }

    // Post-Only enforcement for maker SELL: limit price must be ABOVE bestBid
    // (otherwise the order would execute immediately as a taker).
    if (isMaker && action.price > 0) {
      const bestBid = tokenBook.bids[0]?.price;
      if (bestBid !== undefined && action.price <= bestBid) {
        return {
          action, filled: false, fillPrice: 0, fillSize: 0,
          fee: 0, rebate: 0, slippage, pnl: 0, latencyMs: actualLatency,
          toxicFlowHit: toxicHit, orderType: "maker",
          rejectionReason: "post_only_cross",
        };
      }
    }

    // Pre-check book tradability — same reasoning as BUY path.
    if (!isBookTradeable(tokenBook)) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: toxicHit, orderType: isMaker ? "maker" : "taker",
        rejectionReason: "book_not_tradeable",
      };
    }

    // Limit price enforcement: action.price is the engine's MIN acceptable
    // fill price. walkBook rejects if walked effectivePrice falls below.
    const limit = action.price > 0 ? action.price : undefined;
    const walked = walkBook(sellSize, "SELL", tokenBook, CONFIG.MIN_ORDER_SIZE, !!tickBooks, limit);
    if (!walked) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: toxicHit, orderType: isMaker ? "maker" : "taker",
        rejectionReason: limit !== undefined ? "limit_violated" : "size_below_min",
      };
    }

    const fillSize = walked.filledSize;
    // Makers suffer adverse selection on sells too (price crashing through your ask)
    let fillPrice = isMaker ? walked.effectivePrice : Math.min(walked.effectivePrice, adjustedPrice);
    if (isMaker) {
      fillPrice *= MAKER_ADVERSE_SELL;
    }
    fillPrice = tickRound(fillPrice);

    // Reject if fill price is outside PM range
    if (fillPrice < 0.001 || fillPrice > 1.0) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: toxicHit, orderType: isMaker ? "maker" : "taker",
        rejectionReason: "fill_price_out_of_range",
      };
    }

    const proceeds = fillPrice * fillSize;

    // Makers pay 0% fee; takers pay parabolic fee
    const fee = isMaker ? 0 : calculateFee(fillPrice, proceeds);

    // No gas for CLOB trades (off-chain EIP-712 signatures)

    // MEV slippage on large orders
    let mevCost = 0;
    if (proceeds > CONFIG.MEV_THRESHOLD_USD) {
      mevCost = proceeds * (CONFIG.MEV_SLIPPAGE_BPS / 10000);
    }

    // Track taker fees in the pool
    if (!isMaker && fee > 0) {
      addToTakerFeePool(action.tokenId, fee, fillSize);
    }

    // Maker rebate
    let rebate = 0;
    if (isMaker) {
      rebate = calculateMakerRebate(action.tokenId, fillSize);
    }

    const netProceeds = proceeds - fee - mevCost + rebate;

    // Compute P&L BEFORE mutating position state
    const costBasisPortion = pos.avgEntry * fillSize;
    const pnl = netProceeds - costBasisPortion;

    // Update state
    state.cashBalance += netProceeds;
    state.feePaid += fee + mevCost;
    state.feeRebate += rebate;
    state.slippageCost += slippage * fillSize;
    state.tradeCount++;
    state.roundPnl += pnl;

    // Update position
    pos.shares -= fillSize;
    pos.costBasis -= costBasisPortion;
    if (pos.shares <= 0.001) {
      state.positions.delete(action.tokenId);
    }

    return {
      action, filled: true, fillPrice, fillSize,
      fee: fee + mevCost, rebate, slippage, pnl,
      latencyMs: actualLatency, toxicFlowHit: toxicHit,
      orderType: isMaker ? "maker" : "taker",
    };
  }

  // Shouldn't reach here
  return {
    action, filled: false, fillPrice: 0, fillSize: 0,
    fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
    toxicFlowHit: false, orderType: "taker",
    rejectionReason: "other",
  };
}

// ── GTC Limit Order Subsystem ────────────────────────────────────────────────
/** Sum shares at or better than limitPrice on the given side of the book. */
function bookDepthAtPrice(book: OrderBook, side: "BUY" | "SELL", limitPrice: number): number {
  let depth = 0;
  if (side === "BUY") {
    for (const lvl of book.bids) {
      if (lvl.price >= limitPrice) depth += lvl.size;
      else break;
    }
  } else {
    for (const lvl of book.asks) {
      if (lvl.price <= limitPrice) depth += lvl.size;
      else break;
    }
  }
  return depth;
}

// Persistent maker orders that sit on the book until filled or expired.
// When an engine posts a maker order that doesn't fill immediately (the
// 12% fill lottery), it's stored here and re-checked on every subsequent
// tick. Fills when the book crosses the limit price. Expires on market
// rotation (candle change).

export interface GtcOrder {
  engineId: string;
  action: EngineAction;
  state: EngineState;
  postedAt: number;
  tokenId: string;
  side: "BUY" | "SELL";
  limitPrice: number;
  size: number;
  queueAttempts: number;
  sharesAhead: number;
  lastBookDepth: number;
}

const pendingGtc: GtcOrder[] = [];

/** Store a maker order for future fill attempts. */
function addGtcOrder(order: GtcOrder): void {
  pendingGtc.push(order);
}

/** Remove all GTC orders for tokens no longer in the active market. */
export function expireGtcOrders(activeTokenIds: Set<string>): number {
  const before = pendingGtc.length;
  for (let i = pendingGtc.length - 1; i >= 0; i--) {
    if (!activeTokenIds.has(pendingGtc[i].tokenId)) {
      pendingGtc.splice(i, 1);
    }
  }
  return before - pendingGtc.length;
}

/** Clear all GTC orders (round end). */
export function clearGtcOrders(): void {
  pendingGtc.length = 0;
}

/** Get count of pending GTC orders. */
export function gtcOrderCount(): number {
  return pendingGtc.length;
}

/** Get GTC orders for a specific engine. */
export function getGtcOrdersForEngine(engineId: string): GtcOrder[] {
  return pendingGtc.filter(o => o.engineId === engineId);
}

/**
 * Check all pending GTC orders against current book state. Fill any
 * that now cross. Returns FillResults for filled orders (both
 * successful fills and expired/failed).
 *
 * Called by arena.ts on every tick AFTER engine actions are processed.
 */
export function processGtcOrders(tickBooks?: TickBooks): FillResult[] {
  const results: FillResult[] = [];
  for (let i = pendingGtc.length - 1; i >= 0; i--) {
    const order = pendingGtc[i];
    const book = bookFromTick(order.tokenId, tickBooks);
    if (!isBookTradeable(book)) continue;

    let shouldFill = false;
    if (order.side === "BUY") {
      // BUY limit: fills when bestAsk drops to or below our limit
      const bestAsk = book.asks[0]?.price ?? 999;
      shouldFill = bestAsk <= order.limitPrice;
    } else {
      // SELL limit: fills when bestBid rises to or above our limit
      const bestBid = book.bids[0]?.price ?? 0;
      shouldFill = bestBid >= order.limitPrice;
    }

    // Track queue consumption: when book depth at our level shrinks,
    // shares ahead of us were taken or cancelled, improving our position.
    const currentDepth = bookDepthAtPrice(book, order.side, order.limitPrice);
    if (currentDepth < order.lastBookDepth) {
      order.sharesAhead = Math.max(0, order.sharesAhead - (order.lastBookDepth - currentDepth));
    }
    order.lastBookDepth = currentDepth;

    if (!shouldFill) continue;

    // FIFO: only fill when all shares ahead of us have been consumed
    if (order.sharesAhead > 0) continue;

    // Fill the GTC order against the current book
    const walked = walkBook(
      order.size, order.side, book,
      CONFIG.MIN_ORDER_SIZE, !!tickBooks, order.limitPrice,
    );

    if (!walked) continue; // book doesn't have enough depth at limit

    const fillSize = walked.filledSize;
    const fillPrice = walked.effectivePrice * (order.side === "BUY" ? MAKER_ADVERSE_BUY : MAKER_ADVERSE_SELL);
    const roundedPrice = tickRound(fillPrice);

    // Maker: 0% fee + rebate
    const rebate = calculateMakerRebate(order.tokenId, fillSize);
    const totalCost = roundedPrice * fillSize;

    if (order.side === "BUY") {
      if (order.state.cashBalance < totalCost) continue; // can't afford

      order.state.cashBalance -= totalCost;
      order.state.cashBalance += rebate;
      order.state.feePaid += 0;
      order.state.feeRebate += rebate;
      order.state.tradeCount++;

      const isDownToken = !!(order.state.activeDownTokenId && order.tokenId === order.state.activeDownTokenId);
      const positionSide = isDownToken ? "NO" : "YES";
      const existing = order.state.positions.get(order.tokenId);
      if (existing) {
        const newShares = existing.shares + fillSize;
        const newCost = existing.costBasis + totalCost;
        existing.shares = newShares;
        existing.costBasis = newCost;
        existing.avgEntry = newCost / newShares;
      } else {
        order.state.positions.set(order.tokenId, {
          tokenId: order.tokenId,
          side: positionSide as "YES" | "NO",
          shares: fillSize,
          avgEntry: roundedPrice,
          costBasis: totalCost,
        });
      }
    }

    // Remove from pending
    pendingGtc.splice(i, 1);

    results.push({
      action: order.action,
      filled: true,
      fillPrice: roundedPrice,
      fillSize,
      fee: 0,
      rebate,
      slippage: 0,
      pnl: 0,
      latencyMs: 0,
      toxicFlowHit: false,
      orderType: "maker",
    });

    console.log(
      `[gtc] FILLED: ${order.engineId} ${order.side} ${fillSize}@${roundedPrice.toFixed(3)} (limit ${order.limitPrice.toFixed(3)}, waited ${((Date.now() - order.postedAt) / 1000).toFixed(0)}s)`,
    );
  }
  return results;
}

// ── Batch Processing ─────────────────────────────────────────────────────────

/**
 * Process multiple actions from an engine.
 * CLOB actions (BUY/SELL) get standard API latency (50ms).
 * MERGE actions are queued and returned for deferred processing (on-chain latency handled by arena).
 */
export async function processActions(
  actions: EngineAction[],
  state: EngineState,
  tickBooks?: TickBooks,
): Promise<{ results: FillResult[]; pendingMerges: EngineAction[] }> {
  const nonMerge = actions.filter(a => a.side !== "MERGE");
  const merges = actions.filter(a => a.side === "MERGE");
  const results: FillResult[] = [];

  // Standard API latency for CLOB actions
  if (nonMerge.length > 0 && nonMerge.some(a => a.side !== "HOLD")) {
    await new Promise(resolve => setTimeout(resolve, config.latencyMs));
  }
  for (const action of nonMerge) {
    results.push(await processActionNoLatency(action, state, tickBooks));
  }

  tallyRejections(results, state);
  return { results, pendingMerges: merges };
}

/** Process deferred MERGE actions (call after global on-chain delay). */
export async function processMergeActions(
  actions: EngineAction[],
  state: EngineState,
  tickBooks?: TickBooks,
): Promise<FillResult[]> {
  const results: FillResult[] = [];
  for (const action of actions) {
    results.push(await processActionNoLatency(action, state, tickBooks));
  }
  tallyRejections(results, state);
  return results;
}

// ── Utility: Should I Merge? ─────────────────────────────────────────────────

/**
 * Decide whether merging is cheaper than selling for a given exit.
 *
 * Only recommends MERGE when `holdsOpposite` is true (engine already holds
 * enough of the opposite side for Flavor A — gas only). Without the
 * opposite, MERGE is forbidden (Flavor B was removed) and we return SELL
 * with mergeFee=Infinity.
 */
export function cheaperExit(
  price: number,
  shares: number,
  holdsOpposite: boolean = false,
): { method: "SELL" | "MERGE"; sellFee: number; mergeFee: number; savings: number } {
  const sellProceeds = price * shares;
  const sellFee = calculateFee(price, sellProceeds);

  const mergeValue = shares * 1.0;
  const mergeFlatFee = calculateMergeFee(mergeValue);
  const gasCost = CONFIG.GAS_COST_USD;

  let mergeFee: number;
  if (holdsOpposite) {
    // Flavor A: gas + flat fee. The opposite shares were already paid for
    // separately, so they don't enter this comparison.
    mergeFee = mergeFlatFee + gasCost;
  } else {
    // Flavor B no longer supported — refuse to recommend MERGE.
    mergeFee = Number.POSITIVE_INFINITY;
  }

  if (mergeFee < sellFee) {
    return { method: "MERGE", sellFee, mergeFee, savings: sellFee - mergeFee };
  }
  return { method: "SELL", sellFee, mergeFee, savings: mergeFee - sellFee };
}

// ── Mark-to-Market ───────────────────────────────────────────────────────────

/**
 * Calculate current value of all open positions in an engine state.
 * Uses each token's own book for valuation (UP and DOWN have independent prices).
 */
export function markToMarket(state: EngineState, _currentPrice?: number): number {
  let value = 0;
  for (const [tokenId, pos] of state.positions) {
    const book = getBookForToken(tokenId);
    // Value at best bid (what you could sell for right now)
    const bestBid = book.bids[0]?.price;
    if (bestBid && bestBid > 0) {
      value += pos.shares * bestBid;
    } else {
      // Fallback: use avgEntry if no book data
      value += pos.shares * pos.avgEntry;
    }
  }
  return value;
}
