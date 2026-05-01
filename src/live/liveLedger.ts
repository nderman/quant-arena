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
