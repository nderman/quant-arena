/**
 * Quant Farm — Settlement
 *
 * Tracks 5M market windows and resolves positions at expiry.
 * When currentTime > windowEnd:
 *   1. Check Binance price vs strike (candle open price)
 *   2. If BTC > open → UP wins (YES = $1, NO = $0)
 *   3. If BTC < open → DOWN wins (YES = $0, NO = $1)
 *   4. Wipe position, credit/debit cashBalance
 *
 * This is the #1 missing piece — without it, P&L is meaningless.
 */

import { pulseEvents } from "./pulse";
import { CONFIG } from "./config";
import type { EngineState, MarketTick } from "./types";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TrackedMarket {
  tokenId: string;         // the token the engine is holding
  side: "UP" | "DOWN";     // which outcome this token represents
  windowStart: number;     // unix ms — candle open time
  windowEnd: number;       // unix ms — candle close / resolution time
  openPrice: number;       // Binance price at candle open (strike)
  symbol: string;          // e.g. "BTCUSDT"
}

export interface SettlementResult {
  tokenId: string;
  won: boolean;
  payout: number;          // $1.00 per share if won, $0 if lost
  shares: number;
  pnl: number;             // payout - costBasis
  costBasis: number;
}

// ── State ────────────────────────────────────────────────────────────────────

const trackedMarkets = new Map<string, TrackedMarket>(); // tokenId → market
const latestBinancePrices = new Map<string, number>();      // symbol → price

let uninitializedMarkets = 0; // skip scan when all markets have open prices

pulseEvents.on("binance_tick", (tick: MarketTick) => {
  const symbol = tick.symbol.toUpperCase();
  latestBinancePrices.set(symbol, tick.midPrice);

  // Only scan if there are uninitialized markets
  if (uninitializedMarkets <= 0) return;
  const now = Date.now();
  for (const [, market] of trackedMarkets) {
    if (market.symbol === symbol && market.openPrice <= 0 && now >= market.windowStart) {
      market.openPrice = tick.midPrice;
      uninitializedMarkets--;
      console.log(`[settlement] Open price set: ${symbol} = $${tick.midPrice.toFixed(2)} for ${market.tokenId.slice(0, 16)}...`);
    }
  }
});

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Register a market for settlement tracking.
 * Call this when the arena discovers a new 5M market.
 */
export function trackMarketForSettlement(market: TrackedMarket): void {
  if (!trackedMarkets.has(market.tokenId)) {
    if (market.openPrice <= 0) uninitializedMarkets++;
  }
  trackedMarkets.set(market.tokenId, market);
}

/**
 * Record the candle open price (Binance spot at window start).
 * This is the "strike" — the price BTC needs to beat.
 */
export function recordOpenPrice(tokenId: string, openPrice: number): void {
  const market = trackedMarkets.get(tokenId);
  if (market) market.openPrice = openPrice;
}

/**
 * Check all tracked markets for resolution.
 * Returns settlement results for any expired markets.
 * Mutates engine state: wipes positions, credits/debits cash.
 */
export function settleExpiredMarkets(
  states: Map<string, { engineId: string; state: EngineState }>,
): SettlementResult[] {
  const now = Date.now();
  const results: SettlementResult[] = [];

  for (const [tokenId, market] of trackedMarkets) {
    if (now < market.windowEnd) continue; // not expired yet

    // Get current Binance price for this symbol
    const binancePrice = latestBinancePrices.get(market.symbol);
    if (!binancePrice || market.openPrice <= 0) {
      // Stale market with no price data — clean up if expired > 5 min ago
      if (now - market.windowEnd > 300_000) trackedMarkets.delete(tokenId);
      continue;
    }

    // Apply oracle noise: UMA/Chainlink settlement price differs from Binance spot
    // Models the basis between exchange spot and on-chain oracle (TWAP, multi-source aggregate)
    let settlementPrice = binancePrice;
    if (CONFIG.ORACLE_NOISE_ENABLED) {
      const noiseBps = CONFIG.ORACLE_NOISE_BPS / 10000;
      // Box-Muller transform for normal distribution
      const u1 = Math.random();
      const u2 = Math.random();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      settlementPrice = binancePrice * (1 + z * noiseBps);
    }

    // Determine outcome: did price go UP or DOWN vs open?
    const priceWentUp = settlementPrice >= market.openPrice;

    // Settle each engine's position in this token
    for (const [, { engineId, state }] of states) {
      const pos = state.positions.get(tokenId);
      if (!pos || pos.shares <= 0) continue;

      const won = (market.side === "UP" && priceWentUp) ||
                  (market.side === "DOWN" && !priceWentUp);
      const payout = won ? pos.shares * 1.0 : 0;
      const pnl = payout - pos.costBasis;

      // Update state
      state.cashBalance += payout;
      state.roundPnl += pnl;
      state.positions.delete(tokenId);

      const result: SettlementResult = {
        tokenId,
        won,
        payout,
        shares: pos.shares,
        pnl,
        costBasis: pos.costBasis,
      };
      results.push(result);

      const icon = won ? "✓ WIN" : "✗ LOSS";
      const oracleNote = CONFIG.ORACLE_NOISE_ENABLED
        ? ` (oracle: $${settlementPrice.toFixed(2)}, binance: $${binancePrice.toFixed(2)})`
        : "";
      console.log(
        `[settlement] ${icon} ${engineId}: ${pos.shares} shares @ avg ${pos.avgEntry.toFixed(4)} → ` +
        `${won ? "$1.00" : "$0.00"} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ` +
        `settle $${settlementPrice.toFixed(2)} vs open $${market.openPrice.toFixed(2)}${oracleNote}`
      );
    }

    // Remove from tracking — it's done
    trackedMarkets.delete(tokenId);
  }

  return results;
}

/**
 * Get all currently tracked markets (for debugging/display).
 */
export function getTrackedMarkets(): TrackedMarket[] {
  return [...trackedMarkets.values()];
}

/**
 * Clear all tracked markets (round reset).
 */
export function clearTrackedMarkets(): void {
  trackedMarkets.clear();
  uninitializedMarkets = 0;
}
