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
import { fetchJson } from "./http";
import type { EngineState, MarketTick } from "./types";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TrackedMarket {
  tokenId: string;         // the token the engine is holding
  side: "UP" | "DOWN";     // which outcome this token represents
  windowStart: number;     // unix ms — candle open time
  windowEnd: number;       // unix ms — candle close / resolution time
  openPrice: number;       // Binance price at candle open (strike)
  symbol: string;          // e.g. "BTCUSDT"
  settlementDelay?: number; // random oracle purgatory delay (ms), set on first check
  closePrice?: number;     // Binance price snapshot at window end (locked at expiry)
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
      uninitializedMarkets = Math.max(0, uninitializedMarkets - 1);
      console.log(`[settlement] Open price set via WS: ${symbol} = $${tick.midPrice.toFixed(2)} for ${market.side} ${market.tokenId.slice(0, 16)}... (${uninitializedMarkets} remaining)`);
    }
  }
});

// ── Strike Price Fetch ──────────────────────────────────────────────────

/**
 * Fetch the strike price (previous 5m candle close) from Binance kline API.
 * Returns 0 on failure — the WS-reactive fallback will fill it in later.
 */
export async function fetchStrikePrice(symbol: string, windowStartMs: number): Promise<number> {
  try {
    const startTime = windowStartMs - 300_000; // previous candle's open
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&startTime=${startTime}&limit=1`;
    const klines = await fetchJson<any[]>(url, 3000);
    if (klines && klines.length > 0) {
      const close = parseFloat(klines[0][4]); // index 4 = close price
      if (close > 0) return close;
    }
  } catch { /* fallback to WS reactive path */ }
  return 0;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Register a market for settlement tracking.
 * Call this when the arena discovers a new 5M market.
 */
export function trackMarketForSettlement(market: TrackedMarket): void {
  const existing = trackedMarkets.get(market.tokenId);
  if (existing) {
    // Don't overwrite a good openPrice with 0
    if (market.openPrice > 0 && existing.openPrice <= 0) {
      existing.openPrice = market.openPrice;
      uninitializedMarkets = Math.max(0, uninitializedMarkets - 1);
      console.log(`[settlement] Updated open price: ${market.side} ${market.tokenId.slice(0, 16)}... openPrice=$${market.openPrice.toFixed(2)}`);
    }
    return; // don't overwrite existing tracking
  }
  if (market.openPrice <= 0) uninitializedMarkets++;
  trackedMarkets.set(market.tokenId, market);
  console.log(`[settlement] Tracking ${market.side} token ${market.tokenId.slice(0, 16)}... symbol=${market.symbol} openPrice=$${market.openPrice.toFixed(2)} windowEnd=${new Date(market.windowEnd).toISOString()}`);
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

    // Snapshot Binance price at window end — locked so engines can't trade on known outcomes
    if (market.closePrice == null) {
      const livePrice = latestBinancePrices.get(market.symbol);
      if (livePrice) market.closePrice = livePrice;
    }

    // Oracle purgatory: settlement doesn't happen instantly after window end.
    // Random delay (30s-2min) simulates UMA/Chainlink oracle lag.
    // Cash is effectively locked during this period.
    if (market.settlementDelay == null) {
      const min = CONFIG.SETTLEMENT_DELAY_MS_MIN;
      const max = CONFIG.SETTLEMENT_DELAY_MS_MAX;
      market.settlementDelay = min + Math.random() * (max - min);
    }
    if (now < market.windowEnd + market.settlementDelay) continue;

    // Use the snapshot price taken at window end (not current live price)
    const binancePrice = market.closePrice;
    if (!binancePrice || market.openPrice <= 0) {
      const age = ((now - market.windowEnd) / 1000).toFixed(0);
      if (now - market.windowEnd > 60_000 && now - market.windowEnd < 65_000) {
        console.warn(`[settlement] Skipping ${market.side} ${tokenId.slice(0, 16)}...: closePrice=${binancePrice || "none"}, openPrice=$${market.openPrice.toFixed(2)}, expired ${age}s ago`);
      }
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
