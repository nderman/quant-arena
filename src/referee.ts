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
function walkBook(
  size: number,
  side: "BUY" | "SELL",
  book: OrderBook,
  minFillSize: number = CONFIG.MIN_ORDER_SIZE,
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
        levelPrice = Math.min(level.price * decayFactor, 0.999);  // cap at PM max
      } else {
        levelPrice = Math.max(level.price / decayFactor, 0.001);  // floor at PM min
      }
    }

    totalCost += take * levelPrice;
    remaining -= take;
    filledSize += take;
    if (take >= level.size * 0.5) levelsConsumed++;   // only decay if we ate >50% of a level

    if (remaining <= 0) break;
  }

  if (filledSize < minFillSize) return null;

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
  let toxicProb = absDelta > 0.001 ? 0.90     // Binance moved >10bps → 90% toxic
    : absDelta > 0.0005 ? 0.50                 // 5-10bps → 50%
    : config.toxicFlowProbability;              // quiet → base 15%

  // Volume spikes increase toxic flow — large turnover = informed flow
  const volSpike = getBinanceVolumeSpike();
  if (volSpike > 3) toxicProb = Math.min(0.95, toxicProb + 0.40);
  else if (volSpike > 2) toxicProb = Math.min(0.95, toxicProb + 0.20);
  else if (volSpike > 1.5) toxicProb = Math.min(0.95, toxicProb + 0.10);

  if (Math.random() > toxicProb) {
    return { adjustedPrice: action.price, toxicHit: false, slippage: 0 };
  }

  // Magnitude scales with Binance move size, floored at config minimum
  const bpsMagnitude = Math.max(config.toxicFlowBps / 10000, absDelta * 2);

  if (action.side === "BUY") {
    const adversePrice = action.price * (1 + bpsMagnitude);
    // Use the correct token's book (not always UP)
    const currentBook = getBookForToken(action.tokenId);
    const currentAsk = currentBook.asks[0]?.price ?? action.price;
    const fillPrice = Math.max(currentAsk, adversePrice);
    return {
      adjustedPrice: Math.min(fillPrice, 0.99),
      toxicHit: true,
      slippage: fillPrice - action.price,
    };
  } else if (action.side === "SELL") {
    const adversePrice = action.price * (1 - bpsMagnitude);
    const currentBook = getBookForToken(action.tokenId);
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

  // ── TokenId validation: reject trades for unknown tokens ──
  // Only the current active market's tokens are tradeable. Expired markets settle at $1/$0.
  if (action.side !== "HOLD") {
    const isActiveToken = action.tokenId === state.activeTokenId || action.tokenId === state.activeDownTokenId;
    if (!isActiveToken) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: 0,
        toxicFlowHit: false, orderType: action.orderType ?? "taker",
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
      };
    }
  }

  // HOLD — no-op
  if (action.side === "HOLD") {
    return {
      action, filled: false, fillPrice: 0, fillSize: 0,
      fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: 0,
      toxicFlowHit: false, orderType: "taker",
    };
  }

  const actualLatency = config.latencyMs;

  // ── MERGE action (on-chain — gas applies here) ──
  // Two flavors:
  //   A) "Just merge what we hold" — already hold both sides → only gas cost
  //   B) "Buy + merge" — hold one side, buy opposite, then merge
  // Merge arb exists because UP_ask + DOWN_ask > $1 (the market gap).
  if (action.side === "MERGE") {
    // Must hold a position to merge — reject if no position or insufficient shares
    const pos = state.positions.get(action.tokenId);
    if (!pos || pos.shares < CONFIG.MIN_MERGE_SIZE) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: false, orderType: "taker",
      };
    }

    // Clamp merge size to actual position — can't merge more than you hold
    const shares = Math.min(action.size, pos.shares);
    if (shares < CONFIG.MIN_MERGE_SIZE) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: false, orderType: "taker",
      };
    }

    // Determine the opposite token
    const storedOpposite = state.expiringTokenIds?.get(action.tokenId);
    const isHoldingDown = pos.side === "NO";
    const oppositeTokenId = storedOpposite || (isHoldingDown ? state.activeTokenId : state.activeDownTokenId);

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

    // ── Flavor B: buy the opposite, then merge ──
    // Walk the OPPOSITE token's real book to buy the other side
    const oppositeBook = getBookForToken(oppositeTokenId);
    const oppositeWalk = walkBook(shares, "BUY", oppositeBook, CONFIG.MIN_MERGE_SIZE);

    if (!oppositeWalk) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: false, orderType: "taker",
      };
    }

    const oppositePrice = oppositeWalk.effectivePrice;
    const oppositeCost = oppositeWalk.totalCost;
    const oppositeFee = calculateFee(oppositePrice, oppositeCost);

    // Flat merge fee on the merged value ($1 per pair)
    const mergeValue = shares * 1.0;
    const mergeFlatFee = calculateMergeFee(mergeValue);

    // Gas cost for the merge transaction (on-chain contract action)
    // Scales with Binance volatility — gas spikes during high-vol events
    const absDelta = Math.abs(getBinanceDelta());
    const volMultiplier = 1 + (CONFIG.GAS_VOL_MULTIPLIER - 1) * Math.min(absDelta / 0.005, 1);
    const gasCost = CONFIG.GAS_COST_USD * volMultiplier;

    const totalCost = oppositeCost + oppositeFee + mergeFlatFee + gasCost;
    const totalFee = oppositeFee + mergeFlatFee + gasCost;

    if (state.cashBalance < totalCost) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: false, orderType: "taker",
      };
    }

    // P&L: merge payout ($1/share) minus our cost basis minus opposite buy cost
    const costBasis = pos.avgEntry * shares;
    const pnl = mergeValue - costBasis - totalCost;

    state.cashBalance -= totalCost;
    state.cashBalance += mergeValue;
    state.feePaid += totalFee;
    state.roundPnl += pnl;

    // Remove merged shares from position
    pos.shares -= shares;
    pos.costBasis -= costBasis;
    if (pos.shares <= 0.001) state.positions.delete(action.tokenId);

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
    if (Math.random() > fillProb) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage: 0, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: false, orderType: "maker",
      };
    }
  }

  // ── Toxic flow check (re-check book after latency) ──
  // Makers don't suffer toxic flow — they set the price, takers cross it
  const { adjustedPrice, toxicHit, slippage } = isMakerOrder
    ? { adjustedPrice: action.price, toxicHit: false, slippage: 0 }
    : simulateToxicFlow(action);

  // Detect DOWN token for position side tracking
  const isDownToken = !!(state.activeDownTokenId && action.tokenId === state.activeDownTokenId);

  // ── BUY action (off-chain CLOB — no gas) ──
  // Each token has its own real book — no price inversion needed
  if (action.side === "BUY") {
    const isMaker = action.orderType === "maker";
    const tokenBook = getBookForToken(action.tokenId);
    const walked = walkBook(action.size, "BUY", tokenBook);

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
    fillPrice = tickRound(fillPrice);

    // Reject if fill price is outside PM range (Binance price contamination via book)
    if (fillPrice < 0.001 || fillPrice > 1.0) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: toxicHit, orderType: isMaker ? "maker" : "taker",
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

    // Each token has its own real book — no price inversion needed
    const tokenBook = getBookForToken(action.tokenId);
    const walked = walkBook(sellSize, "SELL", tokenBook);
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
    fillPrice = tickRound(fillPrice);

    // Reject if fill price is outside PM range
    if (fillPrice < 0.001 || fillPrice > 1.0) {
      return {
        action, filled: false, fillPrice: 0, fillSize: 0,
        fee: 0, rebate: 0, slippage, pnl: 0, latencyMs: actualLatency,
        toxicFlowHit: toxicHit, orderType: isMaker ? "maker" : "taker",
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
  };
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
): Promise<{ results: FillResult[]; pendingMerges: EngineAction[] }> {
  const nonMerge = actions.filter(a => a.side !== "MERGE");
  const merges = actions.filter(a => a.side === "MERGE");
  const results: FillResult[] = [];

  // Standard API latency for CLOB actions
  if (nonMerge.length > 0 && nonMerge.some(a => a.side !== "HOLD")) {
    await new Promise(resolve => setTimeout(resolve, config.latencyMs));
  }
  for (const action of nonMerge) {
    results.push(await processActionNoLatency(action, state));
  }

  return { results, pendingMerges: merges };
}

/** Process deferred MERGE actions (call after global on-chain delay). */
export async function processMergeActions(
  actions: EngineAction[],
  state: EngineState,
): Promise<FillResult[]> {
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
 * Uses REAL opposite-side book price (UP + DOWN ≠ $1.00 in real markets).
 * The gap between them is where merge arb profit lives.
 *
 * @param price - current token's mid price (what you'd sell at)
 * @param shares - number of shares to exit
 * @param oppositeAsk - best ask on the OPPOSITE token's book (real cost to buy other side)
 *                      If not provided, falls back to 1-price (theoretical)
 */
export function cheaperExit(
  price: number,
  shares: number,
  oppositeAsk?: number,
): { method: "SELL" | "MERGE"; sellFee: number; mergeFee: number; savings: number } {
  const sellProceeds = price * shares;
  const sellFee = calculateFee(price, sellProceeds);

  // Merge requires buying the opposite side from its real book
  const oppPrice = oppositeAsk ?? (1 - price);
  const oppositeCost = oppPrice * shares;
  const oppositeBuyFee = calculateFee(oppPrice, oppositeCost);
  const mergeValue = shares * 1.0; // $1 per pair
  const mergeFlatFee = calculateMergeFee(mergeValue);
  const gasCost = CONFIG.GAS_COST_USD; // base gas (excludes vol spike — conservative estimate)
  const totalMergeCost = oppositeBuyFee + mergeFlatFee + gasCost;

  if (totalMergeCost < sellFee) {
    return { method: "MERGE", sellFee, mergeFee: totalMergeCost, savings: sellFee - totalMergeCost };
  }
  return { method: "SELL", sellFee, mergeFee: totalMergeCost, savings: totalMergeCost - sellFee };
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
