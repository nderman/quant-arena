/**
 * Live Settlement Detection.
 *
 * Polls Gamma API for recently-closed 5M markets and settles any held
 * positions in LiveEngineState by crediting payout ($1 or $0) to cashBalance.
 *
 * Differences from sim settlement.ts:
 *  - Operates on LiveEngineState (which uses PositionState with costBasis)
 *  - Credits real USDC cashBalance (what actually lives in the wallet after
 *    the 1155 position tokens redeem on-chain)
 *  - Records to a per-engine live ledger rather than the shared trades table
 *  - Deduplicates tokens globally so multiple engines sharing a position
 *    each get their own settlement entry without double-crediting
 *
 * IMPORTANT caveat: this mirrors the sim behavior of "position auto-redeems
 * at resolution." On real PM, position tokens only convert to USDC when the
 * user calls redeem() on-chain. This module assumes the caller will call
 * redeem separately (or a sweeper will). Until that happens, the cash here
 * is "virtual" — accurate for book-keeping, not wallet-accurate.
 */

import { fetchJson } from "../http";
import type { LiveEngineState } from "./liveState";
import { recordSettle, readLedger } from "./liveLedger";

export interface LiveSettlementResult {
  engineId: string;
  tokenId: string;
  won: boolean;
  payout: number;
  shares: number;
  pnl: number;
  costBasis: number;
  marketSlug: string;
}

interface GammaMarket {
  conditionId: string;
  slug: string;
  closed: boolean;
  endDate: string;
  clobTokenIds: string;
  outcomes: string;
  outcomePrices: string;
}

// Track which tokenIds have been settled PER engine so each engine's
// positions are credited exactly once
const settledByEngine = new Map<string, Set<string>>();

function getSettledSet(engineId: string): Set<string> {
  let s = settledByEngine.get(engineId);
  if (!s) {
    s = new Set();
    settledByEngine.set(engineId, s);
  }
  return s;
}

/**
 * Poll Gamma for closed markets and settle any positions in the given states.
 * Call on a timer (e.g. every 30s) from liveArena.
 */
export async function pollLiveSettlements(
  states: Map<string, LiveEngineState>,
  options: {
    lookbackMinutes?: number;
    tokenSlugPrefix?: string;
    /** Coin + arena context for ledger emission. liveArena passes these in. */
    coin?: string;
    arenaInstanceId?: string;
  } = {},
): Promise<LiveSettlementResult[]> {
  const lookback = options.lookbackMinutes ?? 60;
  const slugPrefix = options.tokenSlugPrefix ?? "btc-updown-5m";

  const now = Date.now();
  const endMin = new Date(now - lookback * 60_000).toISOString();
  const endMax = new Date(now).toISOString();

  const url = `https://gamma-api.polymarket.com/markets?closed=true&limit=50&order=endDate&ascending=false&end_date_min=${endMin}&end_date_max=${endMax}`;
  const markets = await fetchJson<GammaMarket[]>(url, 8000);

  const results: LiveSettlementResult[] = [];

  // Belt-and-braces ledger fallback: if Gamma is down or returns nothing,
  // scan the local ledger for SETTLE rows matching unsettled positions in
  // the live arena state. This stops the chronic phantom-position freeze
  // (May 4 + May 6 incidents) where Gamma rate-limits → settlements never
  // process → positions accumulate → engine self-gates → silence.
  // We do this BEFORE the Gamma loop so it runs unconditionally; Gamma
  // results below are still authoritative for fresh settles.
  applyLedgerSettlements(states, results, options);

  if (!markets || markets.length === 0) return results;

  for (const m of markets) {
    if (!m.closed || !m.slug?.includes(slugPrefix)) continue;

    let tokenIds: string[];
    let outcomes: string[];
    let prices: string[];
    try {
      tokenIds = JSON.parse(m.clobTokenIds);
      outcomes = JSON.parse(m.outcomes);
      prices = JSON.parse(m.outcomePrices);
    } catch {
      continue;
    }
    if (tokenIds.length !== 2 || prices.length !== 2) continue;

    for (let i = 0; i < 2; i++) {
      const tokenId = tokenIds[i];
      const won = prices[i] === "1";
      const outcomeName = outcomes[i];

      for (const [engineId, state] of states) {
        const settled = getSettledSet(engineId);
        if (settled.has(tokenId)) continue;

        const pos = state.positions.get(tokenId);
        if (!pos || pos.shares <= 0) continue;

        settled.add(tokenId);

        const payout = won ? pos.shares : 0;
        const pnl = payout - pos.costBasis;

        state.cashBalance += payout;
        state.positions.delete(tokenId);

        // Settlement P&L flows into dailyLoss tracker on losses only —
        // gains don't count against the daily loss budget
        if (pnl < 0) state.dailyLossUsd += -pnl;

        results.push({
          engineId,
          tokenId,
          won,
          payout,
          shares: pos.shares,
          pnl,
          costBasis: pos.costBasis,
          marketSlug: m.slug,
        });

        // Persist to live_trades.jsonl ledger for per-engine PnL analysis
        if (options.coin && options.arenaInstanceId) {
          recordSettle({
            engineId,
            coin: options.coin,
            arenaInstanceId: options.arenaInstanceId,
            tokenId,
            marketSlug: m.slug,
            won,
            shares: pos.shares,
            payout,
            pnl,
            costBasis: pos.costBasis,
          });
        }

        console.log(
          `[live-settle] ${won ? "✓ WIN" : "✗ LOSS"} ${engineId}: ${pos.shares} ${outcomeName} @ avg $${pos.avgEntry.toFixed(4)} → ` +
          `$${payout.toFixed(2)} | pnl: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ${m.slug}`
        );
      }
    }
  }

  // Cap per-engine settled sets. Convert to array first — deleting from
  // a Set while iterating has undefined order and can skip entries.
  for (const [, set] of settledByEngine) {
    if (set.size > 5000) {
      const toDelete = set.size - 4000;
      const toRemove = [...set].slice(0, toDelete);
      for (const t of toRemove) set.delete(t);
    }
  }

  return results;
}

/**
 * Reset the settled-token cache (test/debug only).
 */
export function _resetSettledCache(): void {
  settledByEngine.clear();
}

/**
 * Ledger-based settlement fallback. For each engine's open positions, check
 * if a SETTLE row exists in the local ledger (written by sync cron after the
 * on-chain redemption). If yes AND we haven't already settled this token,
 * apply it. Catches the case where Gamma polling is failing.
 *
 * SETTLE rows are matched arena-keyed (engineId on sync rows is unreliable
 * — sync cron misattributes — but tokenId is unique per market). The
 * engine-keyed `settledByEngine` cache below shares state with the Gamma
 * path so neither double-credits the other.
 */
function applyLedgerSettlements(
  states: Map<string, LiveEngineState>,
  results: LiveSettlementResult[],
  options: { coin?: string; arenaInstanceId?: string },
): void {
  if (!options.arenaInstanceId) return;

  // Build (tokenId -> SettleEvent) map for this arena. Latest wins on conflicts.
  const ledgerSettles = new Map<string, { won: boolean; payout: number; pnl: number; costBasis: number; marketSlug: string }>();
  for (const r of readLedger()) {
    if (r.type !== "SETTLE") continue;
    if (r.arenaInstanceId !== options.arenaInstanceId) continue;
    ledgerSettles.set(r.tokenId, {
      won: r.won,
      payout: r.payout,
      pnl: r.pnl,
      costBasis: r.costBasis,
      marketSlug: r.marketSlug,
    });
  }
  if (ledgerSettles.size === 0) return;

  for (const [engineId, state] of states) {
    const settled = getSettledSet(engineId);
    for (const [tokenId, pos] of Array.from(state.positions.entries())) {
      if (settled.has(tokenId)) continue;
      const settle = ledgerSettles.get(tokenId);
      if (!settle) continue;
      if (pos.shares <= 0) continue;

      settled.add(tokenId);
      const payout = settle.won ? pos.shares : 0;
      const pnl = payout - pos.costBasis;
      state.cashBalance += payout;
      state.positions.delete(tokenId);
      if (pnl < 0) state.dailyLossUsd += -pnl;

      results.push({
        engineId,
        tokenId,
        won: settle.won,
        payout,
        shares: pos.shares,
        pnl,
        costBasis: pos.costBasis,
        marketSlug: settle.marketSlug,
      });

      console.log(
        `[live-settle:ledger] ${settle.won ? "✓ WIN" : "✗ LOSS"} ${engineId}: ${pos.shares} shares @ avg $${pos.avgEntry.toFixed(4)} → ` +
        `$${payout.toFixed(2)} | pnl: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} | ${settle.marketSlug} (ledger fallback)`
      );
    }
  }
}
