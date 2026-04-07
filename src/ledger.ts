/**
 * Quant Farm — Ledger (SQLite)
 *
 * Persistent trade ledger using better-sqlite3.
 * Logs every fill with: FeePaid, LatencySlippage, SignalSource.
 *
 * Borrowed pattern: ledgerV2.ts (double-entry, mutex appends).
 * Upgraded: SQLite for queries instead of JSONL for flat-file.
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { CONFIG } from "./config";
import type { LedgerRow, FillResult, EngineState } from "./types";

// ── Database Setup ───────────────────────────────────────────────────────────

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  const dbPath = CONFIG.LEDGER_DB_PATH;
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id TEXT NOT NULL,
      engine_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      action TEXT NOT NULL,
      token_id TEXT NOT NULL,
      price REAL NOT NULL,
      size REAL NOT NULL,
      fee REAL NOT NULL,
      rebate REAL NOT NULL DEFAULT 0,
      slippage REAL NOT NULL,
      pnl REAL NOT NULL DEFAULT 0,
      cash_after REAL NOT NULL,
      signal_source TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      toxic_flow INTEGER NOT NULL DEFAULT 0,
      latency_ms REAL NOT NULL DEFAULT 0,
      order_type TEXT NOT NULL DEFAULT 'taker'
    );

    CREATE INDEX IF NOT EXISTS idx_trades_round ON trades(round_id);
    CREATE INDEX IF NOT EXISTS idx_trades_engine ON trades(engine_id);
    CREATE INDEX IF NOT EXISTS idx_trades_action ON trades(action);

    CREATE TABLE IF NOT EXISTS rounds (
      round_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_ms INTEGER,
      results_json TEXT
    );
  `);

  return db;
}

// ── Cached Prepared Statements ───────────────────────────────────────────────

let _insertStmt: Database.Statement | null = null;
let _roundStartStmt: Database.Statement | null = null;
let _roundEndStmt: Database.Statement | null = null;

function insertStmt() {
  if (!_insertStmt) _insertStmt = getDb().prepare(`
    INSERT INTO trades (round_id, engine_id, timestamp, action, token_id, price, size, fee, rebate, slippage, pnl, cash_after, signal_source, note, toxic_flow, latency_ms, order_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return _insertStmt;
}

// ── Write ────────────────────────────────────────────────────────────────────

export function recordFill(
  roundId: string,
  engineId: string,
  fill: FillResult,
  state: EngineState,
  pnl: number = 0,
): void {
  if (!fill.filled) return;

  insertStmt().run(
    roundId,
    engineId,
    new Date().toISOString(),
    fill.action.side,
    fill.action.tokenId,
    fill.fillPrice,
    fill.fillSize,
    fill.fee,
    fill.rebate,
    fill.slippage,
    pnl,
    state.cashBalance,
    fill.action.signalSource ?? "",
    fill.action.note ?? "",
    fill.toxicFlowHit ? 1 : 0,
    fill.latencyMs,
    fill.orderType,
  );
}

export function recordRoundStart(roundId: string): void {
  if (!_roundStartStmt) _roundStartStmt = getDb().prepare(`
    INSERT OR REPLACE INTO rounds (round_id, started_at) VALUES (?, ?)
  `);
  _roundStartStmt.run(roundId, new Date().toISOString());
}

export function recordRoundEnd(roundId: string, durationMs: number, resultsJson: string): void {
  if (!_roundEndStmt) _roundEndStmt = getDb().prepare(`
    UPDATE rounds SET ended_at = ?, duration_ms = ?, results_json = ? WHERE round_id = ?
  `);
  _roundEndStmt.run(new Date().toISOString(), durationMs, resultsJson, roundId);
}

// ── Read / Query ─────────────────────────────────────────────────────────────

export function getTradesForRound(roundId: string): LedgerRow[] {
  return getDb().prepare(`
    SELECT id, round_id as roundId, engine_id as engineId, timestamp, action,
           token_id as tokenId, price, size, fee, slippage, pnl,
           cash_after as cashAfter, signal_source as signalSource, note
    FROM trades WHERE round_id = ?
    ORDER BY id ASC
  `).all(roundId) as LedgerRow[];
}

export function getTradesForEngine(engineId: string, roundId?: string): LedgerRow[] {
  if (roundId) {
    return getDb().prepare(`
      SELECT * FROM trades WHERE engine_id = ? AND round_id = ? ORDER BY id ASC
    `).all(engineId, roundId) as LedgerRow[];
  }
  return getDb().prepare(`
    SELECT * FROM trades WHERE engine_id = ? ORDER BY id ASC
  `).all(engineId) as LedgerRow[];
}

export function getRoundSummary(roundId: string): {
  engineId: string;
  tradeCount: number;
  totalFee: number;
  totalSlippage: number;
  totalPnl: number;
  toxicFlowHits: number;
}[] {
  return getDb().prepare(`
    SELECT
      engine_id as engineId,
      COUNT(*) as tradeCount,
      SUM(fee) as totalFee,
      SUM(slippage) as totalSlippage,
      SUM(pnl) as totalPnl,
      SUM(toxic_flow) as toxicFlowHits
    FROM trades
    WHERE round_id = ?
    GROUP BY engine_id
    ORDER BY totalPnl DESC
  `).all(roundId) as any[];
}

export function getEngineStats(engineId: string): {
  rounds: number;
  totalTrades: number;
  totalFees: number;
  totalPnl: number;
  avgPnlPerRound: number;
  winRate: number;
} {
  const row = getDb().prepare(`
    SELECT
      COUNT(DISTINCT round_id) as rounds,
      COUNT(*) as totalTrades,
      SUM(fee) as totalFees,
      SUM(pnl) as totalPnl,
      SUM(CASE WHEN action = 'SELL' AND pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN action = 'SELL' THEN 1 ELSE 0 END) as sells
    FROM trades
    WHERE engine_id = ?
  `).get(engineId) as any;

  return {
    rounds: row?.rounds ?? 0,
    totalTrades: row?.totalTrades ?? 0,
    totalFees: row?.totalFees ?? 0,
    totalPnl: row?.totalPnl ?? 0,
    avgPnlPerRound: row?.rounds ? (row.totalPnl / row.rounds) : 0,
    winRate: row?.sells ? (row.wins / row.sells) : 0,
  };
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

export function closeDb(): void {
  db?.close();
  db = null;
  _insertStmt = null;
  _roundStartStmt = null;
  _roundEndStmt = null;
}
