/**
 * Quant Farm — Settlement (self-contained Gamma poller)
 *
 * Polls Polymarket Gamma API for recently-closed 5M markets every 30s.
 * For each closed market, finds engines holding positions in those tokens
 * and settles them using PM's actual Chainlink-based resolution.
 *
 * No dependence on rotation/discovery — settlement queries PM directly.
 * Survives arena restarts since state lives in engine positions, not here.
 */

import { fetchJson } from "./http";
import { recordSettlement } from "./ledger";
import type { EngineState } from "./types";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SettlementResult {
  tokenId: string;
  won: boolean;
  payout: number;
  shares: number;
  pnl: number;
  costBasis: number;
}

interface GammaMarket {
  conditionId: string;
  slug: string;
  closed: boolean;
  endDate: string;
  clobTokenIds: string; // JSON-encoded array of two token IDs
  outcomes: string;     // JSON-encoded array of two outcome names
  outcomePrices: string; // JSON-encoded array of two prices ("0" or "1")
}

// Track which tokenIds we've already settled so we don't double-pay
const settledTokens = new Set<string>();

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Poll Gamma for recently-closed BTC 5M markets and settle any engine positions.
 * Call this on a timer (e.g. every 30s).
 */
export async function pollAndSettle(
  states: Map<string, { engineId: string; state: EngineState }>,
  options: { lookbackMinutes?: number; tokenSlugPrefix?: string; roundId?: string; intervalTag?: string } = {},
): Promise<SettlementResult[]> {
  const lookback = options.lookbackMinutes ?? 60;
  const slugPrefix = options.tokenSlugPrefix ?? "btc-updown-5m";

  const now = Date.now();
  const endMin = new Date(now - lookback * 60_000).toISOString();
  const endMax = new Date(now).toISOString();

  // For non-5M intervals, use the events endpoint with tag_slug to avoid
  // the general markets list drowning in sports markets (which close every
  // few minutes and push crypto markets off the limit=50 window).
  let markets: GammaMarket[] | null;
  if (options.intervalTag && options.intervalTag !== "5m") {
    const tag = options.intervalTag.toUpperCase();
    const eventsUrl = `https://gamma-api.polymarket.com/events?tag_slug=${tag}&closed=true&limit=50&order=endDate&ascending=false`;
    const events = await fetchJson<Array<{ markets?: GammaMarket[] }>>(eventsUrl, 8000);
    if (!events || events.length === 0) return [];
    markets = events.flatMap(e => e.markets ?? []).filter(m => {
      if (!m.endDate) return false;
      return m.endDate >= endMin && m.endDate <= endMax;
    });
  } else {
    const url = `https://gamma-api.polymarket.com/markets?closed=true&limit=50&order=endDate&ascending=false&end_date_min=${endMin}&end_date_max=${endMax}`;
    markets = await fetchJson<GammaMarket[]>(url, 8000);
  }
  if (!markets || markets.length === 0) return [];

  const results: SettlementResult[] = [];

  for (const m of markets) {
    if (!m.closed || !m.slug?.includes(slugPrefix)) continue;

    let tokenIds: string[];
    let outcomes: string[];
    let prices: string[];
    try {
      tokenIds = JSON.parse(m.clobTokenIds);
      outcomes = JSON.parse(m.outcomes);
      prices = JSON.parse(m.outcomePrices);
    } catch { continue; }
    if (tokenIds.length !== 2 || prices.length !== 2) continue;

    if (settledTokens.has(tokenIds[0]) && settledTokens.has(tokenIds[1])) continue;

    for (let i = 0; i < 2; i++) {
      const tokenId = tokenIds[i];
      if (settledTokens.has(tokenId)) continue;
      settledTokens.add(tokenId);

      const won = prices[i] === "1";
      const side = outcomes[i];

      for (const [, { engineId, state }] of states) {
        const pos = state.positions.get(tokenId);
        if (!pos || pos.shares <= 0) continue;

        const payout = won ? pos.shares : 0;
        const pnl = payout - pos.costBasis;

        state.cashBalance += payout;
        state.roundPnl += pnl;
        state.positions.delete(tokenId);

        if (options.roundId) {
          recordSettlement(options.roundId, engineId, tokenId, pos.shares, won, pos.costBasis, state.cashBalance, m.slug);
        }

        results.push({ tokenId, won, payout, shares: pos.shares, pnl, costBasis: pos.costBasis });

        console.log(
          `[settlement] ${won ? "✓ WIN" : "✗ LOSS"} ${engineId}: ${pos.shares} ${side} shares @ avg ${pos.avgEntry.toFixed(4)} → ` +
          `${won ? "$1.00" : "$0.00"} | P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ${m.slug}`
        );
      }
    }
  }

  // Cap settledTokens size to prevent unbounded growth
  if (settledTokens.size > 5000) {
    const toDelete = settledTokens.size - 4000;
    let i = 0;
    for (const t of settledTokens) {
      if (i++ >= toDelete) break;
      settledTokens.delete(t);
    }
  }

  return results;
}

