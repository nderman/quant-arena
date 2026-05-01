/**
 * Live trade ledger — append-only JSONL of every confirmed live trade event.
 *
 * Why: market-title-pattern attribution from the Polymarket Activity API is
 * brittle (multiple engines per arena, ambiguous title formats, missing roster
 * history). The engine that fired knows exactly who it is at fill time — emit
 * a row from that point and we have ground truth per-engine PnL forever.
 *
 * Schema (one JSON object per line):
 *   FILL:    { ts, type:"FILL",   engineId, coin, arenaInstanceId, tokenId,
 *              positionSide, side:"BUY"|"SELL", size, limitPrice, fillPrice,
 *              cost, clientOrderId }
 *   SETTLE:  { ts, type:"SETTLE", engineId, coin, arenaInstanceId, tokenId,
 *              marketSlug, won, shares, payout, pnl, costBasis }
 *
 * Single file: data/live_trades.jsonl. All engines, all coins, append-only.
 * Synchronous appends — small writes (~200 bytes), no perf concern at our
 * scale (~50 fills/day). If we ever scale to 10k+ fills/min we can buffer.
 */
import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "../historyStore";

const LEDGER_PATH = path.join(DATA_DIR, "live_trades.jsonl");

// Hoist mkdirSync to module init — was running on every appendFileSync.
// At ~50 fills/day the savings are negligible but the syscall churn was real.
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* exists */ }

export interface FillEvent {
  ts: number;                         // unix ms
  type: "FILL";
  engineId: string;
  coin: string;                       // "btc" | "eth" | "sol"
  arenaInstanceId: string;            // e.g. "eth-4h", "btc-1h", "sol"
  tokenId: string;
  positionSide: "YES" | "NO";
  side: "BUY" | "SELL";
  size: number;                       // shares
  limitPrice: number;                 // engine's submitted limit
  fillPrice: number;                  // actual fill avg
  cost: number;                       // size * fillPrice (USD)
  clientOrderId: string;
}

export interface SettleEvent {
  ts: number;                         // unix ms
  type: "SETTLE";
  engineId: string;
  coin: string;
  arenaInstanceId: string;
  tokenId: string;
  marketSlug: string;
  won: boolean;
  shares: number;
  payout: number;                     // USD received (shares if won, 0 if lost)
  pnl: number;                        // payout - costBasis
  costBasis: number;
}

function append(line: object): void {
  try {
    fs.appendFileSync(LEDGER_PATH, JSON.stringify(line) + "\n");
  } catch (err) {
    // Never let ledger I/O bring down a trade — but log loudly: this is the
    // audit trail. Lost rows = lost ground truth. Use console.error so it
    // surfaces in PM2 error logs, not just stdout.
    console.error(`[live-ledger] write FAILED — audit row LOST: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function recordFill(e: Omit<FillEvent, "type" | "ts"> & { ts?: number }): void {
  append({ ts: e.ts ?? Date.now(), type: "FILL", ...e });
}

export function recordSettle(e: Omit<SettleEvent, "type" | "ts"> & { ts?: number }): void {
  append({ ts: e.ts ?? Date.now(), type: "SETTLE", ...e });
}

/** Test-only: reset the ledger file. Don't call from production paths. */
export function _resetLedgerForTests(): void {
  try { fs.unlinkSync(LEDGER_PATH); } catch { /* doesn't exist */ }
}

/**
 * Read all ledger rows. Returns empty array if file doesn't exist or unreadable.
 * Use for startup rehydration.
 */
export function readLedger(): (FillEvent | SettleEvent)[] {
  try {
    const raw = fs.readFileSync(LEDGER_PATH, "utf-8");
    const rows: (FillEvent | SettleEvent)[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try { rows.push(JSON.parse(line)); } catch { /* skip malformed line */ }
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * Rehydrate per-engine open positions from the ledger.
 * Returns map of engineId -> Map<tokenId, {shares, costBasis, avgEntry, side}>.
 *
 * For each engine:
 *  - Sum FILL rows by tokenId (BUYs add shares + cost; SELLs subtract).
 *  - Drop any token that has a SETTLE row — already closed, no live position.
 *
 * Used by liveArena on startup to restore in-memory state after PM2 restart.
 * Without this, restarts wipe positions Map → engines re-fire on the same
 * candle thinking they hold nothing → double-buy bug (observed Apr 30 + May 1).
 */
export function rehydratePositionsFromLedger(
  engineIds: Set<string>,
  arenaInstanceId?: string,  // when set, only rows with matching arenaInstanceId are replayed
): Map<string, Map<string, { shares: number; costBasis: number; avgEntry: number; side: "YES" | "NO" }>> {
  const out = new Map<string, Map<string, { shares: number; costBasis: number; avgEntry: number; side: "YES" | "NO" }>>();
  const settled = new Set<string>(); // engineId:tokenId pairs that have settled
  const rows = readLedger();
  const matchesArena = (r: FillEvent | SettleEvent) =>
    !arenaInstanceId || r.arenaInstanceId === arenaInstanceId;

  // First pass: mark settled (engine, token) pairs (within arena scope)
  for (const r of rows) {
    if (r.type === "SETTLE" && engineIds.has(r.engineId) && matchesArena(r)) {
      settled.add(`${r.engineId}:${r.tokenId}`);
    }
  }

  // Second pass: accumulate FILLs that haven't been settled (within arena scope)
  for (const r of rows) {
    if (r.type !== "FILL") continue;
    if (!engineIds.has(r.engineId)) continue;
    if (!matchesArena(r)) continue;
    const key = `${r.engineId}:${r.tokenId}`;
    if (settled.has(key)) continue;

    let engineMap = out.get(r.engineId);
    if (!engineMap) {
      engineMap = new Map();
      out.set(r.engineId, engineMap);
    }
    const existing = engineMap.get(r.tokenId) ?? {
      shares: 0, costBasis: 0, avgEntry: 0, side: r.positionSide,
    };
    if (r.side === "BUY") {
      existing.shares += r.size;
      existing.costBasis += r.cost;
    } else {
      // SELL: reduce shares + reduce cost basis pro-rata
      const fraction = existing.shares > 0 ? Math.max(0, (existing.shares - r.size) / existing.shares) : 0;
      existing.shares = Math.max(0, existing.shares - r.size);
      existing.costBasis *= fraction;
    }
    existing.avgEntry = existing.shares > 0 ? existing.costBasis / existing.shares : 0;
    if (existing.shares > 0) {
      engineMap.set(r.tokenId, existing);
    } else {
      engineMap.delete(r.tokenId);
    }
  }

  return out;
}
