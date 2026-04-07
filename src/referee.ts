/**
 * Quant Farm — Referee
 *
 * High-fidelity trade simulation with:
 * 1. Dynamic Parabolic Fee Model (2026 Polymarket crypto)
 * 2. Latency Injection (300ms delay before fill)
 * 3. Toxic Flow Check (adverse selection during latency window)
 * 4. MERGE action bypass (flat 0.1% gas offset)
 *
 * Fee Formula: fee = amount * peakRate * 4 * P * (1 - P)
 *   - peakRate = 0.018 (1.8% for crypto)
 *   - Maximum at P = 0.50, decays to 0 at P = 0.01 and P = 0.99
 *
 * Borrowed patterns: executor.ts fill logic, sizer.ts edge calculations.
 */

import { CONFIG } from "./config";
import { getLatestPmBook, pulseEvents } from "./pulse";
import type {
  EngineAction,
  FillResult,
  FeeAdjustedEdge,
  RefereeConfig,
  EngineState,
  OrderBook,
  MarketTick,
  OrderType,
} from "./types";

// ── Binance momentum tracking (for correlated toxic flow) ────────────────────

const binanceState = new Map<string, { lastMid: number; delta: number }>();

pulseEvents.on("binance_tick", (tick: MarketTick) => {
  const sym = tick.symbol.toUpperCase();
  const prev = binanceState.get(sym);
  const lastMid = prev?.lastMid ?? 0;
  const delta = lastMid > 0 ? (tick.midPrice - lastMid) / lastMid : 0;
  binanceState.set(sym, { lastMid: tick.midPrice, delta });
});

function getBinanceDelta(): number {
  // Use the primary symbol's delta, fallback to any available
  const primary = CONFIG.BINANCE_SYMBOL.toUpperCase();
  const state = binanceState.get(primary);
  if (state) return state.delta;
  for (const [, s] of binanceState) return s.delta;
  return 0;
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

/** Calculate maker rebate: pro-rata share of accumulated taker fees based on actual market volume */
function calculateMakerRebate(tokenId: string, fillSize: number): number {
  const entry = takerFeePool.get(tokenId);
  if (!entry || entry.fees <= 0 || entry.volume <= 0) return 0;
  const shareOfPool = Math.min(fillSize / entry.volume, 1);
  return entry.fees * CONFIG.MAKER_REBATE_RATE * shareOfPool;
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
 * 2026 Polymarket Dynamic Probabilistic Fee
 *
 * fee = amount * peakRate * 4 * P * (1 - P)
 *
 * At P=0.50: fee = amount * 0.018 * 4 * 0.25 = amount * 0.018 (full peak rate)
 * At P=0.90: fee = amount * 0.018 * 4 * 0.09 = amount * 0.00648 (64% discount)
 * At P=0.99: fee = amount * 0.018 * 4 * 0.0099 = amount * 0.000713 (96% discount)
 */
export function calculateFee(price: number, amount: number): number {
  const peakRate = config.peakFeeRate;
  // Parabolic decay: highest at 0.5, zero at 0 and 1
  return amount * peakRate * 4 * price * (1 - price);
}

/**
 * Merge fee — flat gas offset, bypasses the parabolic curve.
 * Used when buying YES + NO and merging for $1.00.
 */
export function calculateMergeFee(amount: number): number {
  return amount * config.mergeFeeRate;
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
  const feePerDollar = config.peakFeeRate * 4 * marketPrice * (1 - marketPrice);
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
function walkBook(
  size: number,
  side: "BUY" | "SELL",
  book: OrderBook,
): { effectivePrice: number; totalCost: number; filledSize: number } | null {
  const levels = side === "BUY" ? book.asks : book.bids;
  if (!levels.length) return null;

  const decayEnabled = CONFIG.FILL_DECAY_ENABLED;
  const decayMult = CONFIG.FILL_DECAY_MULTIPLIER;

  let remaining = size;
  let totalCost = 0;
  let levelsConsumed = 0;
  let filledSize = 0;

  for (const level of levels) {
    const take = Math.min(remaining, level.size);

    // Fill decay: each level consumed makes remaining levels worse
    let levelPrice = level.price;
    if (decayEnabled && levelsConsumed > 0) {
      const decayFactor = Math.pow(decayMult, levelsConsumed);
      if (side === "BUY") {
        levelPrice = level.price * decayFactor;       // asks get more expensive
      } else {
        levelPrice = level.price / decayFactor;       // bids get cheaper (worse for seller)
      }
    }

    totalCost += take * levelPrice;
    remaining -= take;
    filledSize += take;
    if (take >= level.size * 0.5) levelsConsumed++;   // only decay if we ate >50% of a level

    if (remaining <= 0) break;
  }

  if (filledSize < CONFIG.MIN_ORDER_SIZE) return null;

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
): { adjustedPrice: number; toxicHit: boolean; slippage: number } {
  if (!config.enableToxicFlow) {
    return { adjustedPrice: action.price, toxicHit: false, slippage: 0 };
  }

  const absDelta = Math.abs(getBinanceDelta());
  const toxicProb = absDelta > 0.001 ? 0.90   // Binance moved >10bps → 90% toxic
    : absDelta > 0.0005 ? 0.50                 // 5-10bps → 50%
    : config.toxicFlowProbability;              // quiet → base 15%

  if (Math.random() > toxicProb) {
    return { adjustedPrice: action.price, toxicHit: false, slippage: 0 };
  }

  // Magnitude scales with Binance move size, floored at config minimum
  const bpsMagnitude = Math.max(config.toxicFlowBps / 10000, absDelta * 2);

  if (action.side === "BUY") {
    const adversePrice = action.price * (1 + bpsMagnitude);
    // Use current book ask if available and worse
    const currentBook = getLatestPmBook();
    const currentAsk = currentBook.asks[0]?.price ?? action.price;
    const fillPrice = Math.max(currentAsk, adversePrice);
    return {
      adjustedPrice: Math.min(fillPrice, 0.99),
      toxicHit: true,
      slippage: fillPrice - action.price,
    };
  } else if (action.side === "SELL") {
    const adversePrice = action.price * (1 - bpsMagnitude);
    const currentBook = getLatestPmBook();
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
async function processActionNoLatency(
  action: EngineAction,
  state: EngineState,
): Promise<FillResult> {

  // HOLD — no-op
  if (action.side === "HOLD") {
    return {
      action, filled: false, fillPrice: 0, fillSize: 0,
      fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: 0,
      toxicFlowHit: false, orderType: "taker",
    };
  }

  // Snapshot the book after batch latency has already been applied
  const bookSnapshot = getLatestPmBook();
  const actualLatency = config.latencyMs;

  // ── MERGE action (on-chain — gas applies here) ──
  // To merge, you must hold equal YES and NO shares.
  // size = number of shares to merge (must buy opposite side first).
  // Cost: opposite-side buy (at 1-price, with parabolic fee) + flat merge fee + gas.
  if (action.side === "MERGE") {
    // Must hold a position to merge — reject if no position or insufficient shares
    const pos = state.positions.get(action.tokenId);
    if (!pos || pos.shares < CONFIG.MIN_ORDER_SIZE) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: false, orderType: "taker",
      };
    }

    // Clamp merge size to actual position — can't merge more than you hold
    const shares = Math.min(action.size, pos.shares);
    if (shares < CONFIG.MIN_ORDER_SIZE) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: false, orderType: "taker",
      };
    }
    const currentPrice = action.price; // current price of the side we hold

    // Cost of buying opposite side
    const oppositePrice = 1 - currentPrice;
    const oppositeCost = oppositePrice * shares;
    const oppositeFee = calculateFee(oppositePrice, oppositeCost);

    // Flat merge fee on the merged value ($1 per pair)
    const mergeValue = shares * 1.0;
    const mergeFlatFee = calculateMergeFee(mergeValue);

    // Gas cost for the merge transaction (on-chain contract action)
    const gasCost = CONFIG.GAS_COST_USD;

    const totalCost = oppositeCost + oppositeFee + mergeFlatFee + gasCost;
    const totalFee = oppositeFee + mergeFlatFee + gasCost;

    if (state.cashBalance < totalCost) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: false, orderType: "taker",
      };
    }

    // Deduct costs, add merged USDC back
    // P&L: merge payout ($1/share) minus cost basis of our side minus opposite buy cost
    const costBasis = pos.avgEntry * shares;
    const pnl = mergeValue - costBasis - totalCost;

    state.cashBalance -= totalCost;
    state.cashBalance += mergeValue;
    state.feePaid += totalFee;
    state.roundPnl += pnl;

    // Remove merged shares from position
    if (pos) {
      pos.shares -= shares;
      pos.costBasis -= costBasis;
      if (pos.shares <= 0.001) state.positions.delete(action.tokenId);
    }

    return {
      action, filled: true, fillPrice: 1.0, fillSize: shares,
      fee: totalFee, rebate: 0, slippage: 0, pnl, latencyMs: actualLatency,
      toxicFlowHit: false, orderType: "taker",
    };
  }

  // ── Min order size check ──
  if (action.size < CONFIG.MIN_ORDER_SIZE) {
    return {
      action, filled: false, fillPrice: 0, fillSize: 0,
      fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
      toxicFlowHit: false, orderType: action.orderType ?? "taker",
    };
  }

  // ── Maker fill probability (queue position simulation) ──
  const isMakerOrder = action.orderType === "maker";
  if (isMakerOrder && Math.random() > CONFIG.MAKER_FILL_PROBABILITY) {
    return {
      action, filled: false, fillPrice: 0, fillSize: 0,
      fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
      toxicFlowHit: false, orderType: "maker",
    };
  }

  // ── Toxic flow check (re-check book after latency) ──
  // Makers don't suffer toxic flow — they set the price, takers cross it
  const { adjustedPrice, toxicHit, slippage } = isMakerOrder
    ? { adjustedPrice: action.price, toxicHit: false, slippage: 0 }
    : simulateToxicFlow(action);

  // ── BUY action (off-chain CLOB — no gas) ──
  if (action.side === "BUY") {
    const isMaker = action.orderType === "maker";
    const walked = walkBook(action.size, "BUY", bookSnapshot);

    // Reject if no book or insufficient liquidity
    if (!walked) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: toxicHit, orderType: isMaker ? "maker" : "taker",
      };
    }

    const fillSize = walked.filledSize;
    // Makers fill at their limit but suffer adverse selection (price was moving through them)
    let fillPrice = isMaker ? walked.effectivePrice : Math.max(walked.effectivePrice, adjustedPrice);
    if (isMaker) {
      fillPrice *= MAKER_ADVERSE_BUY;
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
        side: "YES",
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
      };
    }

    // Clamp sell size to available shares, enforce min 5
    const sellSize = Math.min(action.size, pos.shares);
    if (sellSize < CONFIG.MIN_ORDER_SIZE) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: toxicHit, orderType: isMaker ? "maker" : "taker",
      };
    }

    const walked = walkBook(sellSize, "SELL", bookSnapshot);
    if (!walked) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: toxicHit, orderType: isMaker ? "maker" : "taker",
      };
    }

    const fillSize = walked.filledSize;
    // Makers suffer adverse selection on sells too (price crashing through your ask)
    let fillPrice = isMaker ? walked.effectivePrice : Math.min(walked.effectivePrice, adjustedPrice);
    if (isMaker) {
      fillPrice *= MAKER_ADVERSE_SELL;
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
  };
}

// ── Batch Processing ─────────────────────────────────────────────────────────

/**
 * Process multiple actions from an engine.
 * Latency is applied once for the whole batch (not per-action)
 * to avoid blocking N * 300ms on the event loop.
 */
export async function processActions(
  actions: EngineAction[],
  state: EngineState,
): Promise<FillResult[]> {
  // Apply latency once for the batch
  if (actions.length > 0 && actions.some(a => a.side !== "HOLD")) {
    await new Promise(resolve => setTimeout(resolve, config.latencyMs));
  }
  const results: FillResult[] = [];
  for (const action of actions) {
    results.push(await processActionNoLatency(action, state));
  }
  return results;
}

// ── Utility: Should I Merge? ─────────────────────────────────────────────────

/**
 * Calculates whether merging is cheaper than selling at the current price.
 *
 * At P=0.50: sell fee = 1.8%, merge fee = 0.1% → MERGE wins
 * At P=0.95: sell fee = 0.34%, merge fee = 0.1% → MERGE still wins but margin shrinks
 * At P=0.99: sell fee = 0.07%, merge fee = 0.1% → SELL wins
 *
 * Returns the cheaper exit method and cost savings.
 */
export function cheaperExit(
  price: number,
  shares: number,
): { method: "SELL" | "MERGE"; sellFee: number; mergeFee: number; savings: number } {
  const sellProceeds = price * shares;
  const sellFee = calculateFee(price, sellProceeds);

  // Merge requires buying the opposite side too
  const oppositePrice = 1 - price;
  const oppositeCost = oppositePrice * shares;
  const oppositeBuyFee = calculateFee(oppositePrice, oppositeCost);
  const mergeValue = shares * 1.0; // $1 per pair
  const mergeFlatFee = calculateMergeFee(mergeValue);
  const totalMergeCost = oppositeBuyFee + mergeFlatFee;

  if (totalMergeCost < sellFee) {
    return { method: "MERGE", sellFee, mergeFee: totalMergeCost, savings: sellFee - totalMergeCost };
  }
  return { method: "SELL", sellFee, mergeFee: totalMergeCost, savings: totalMergeCost - sellFee };
}

// ── Mark-to-Market ───────────────────────────────────────────────────────────

/**
 * Calculate current value of all open positions in an engine state.
 */
export function markToMarket(state: EngineState, currentPrice: number): number {
  let value = 0;
  for (const [, pos] of state.positions) {
    value += pos.shares * currentPrice;
  }
  return value;
}
