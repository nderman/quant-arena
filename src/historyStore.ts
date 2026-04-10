/**
 * Shared round history reader.
 *
 * Both breeder.ts and live/graduation.ts need to read round_history_${coin}.json.
 * Centralizing here so the path/parsing logic stays in one place.
 */

import * as fs from "fs";
import * as path from "path";
import type { EngineRoundResult } from "./types";

const PROJECT_ROOT = path.resolve(__dirname, "..");
export const DATA_DIR = path.resolve(PROJECT_ROOT, "data");

export interface RoundHistoryEntry {
  roundId: string;
  allResults: EngineRoundResult[];
  timestamp?: string;
}

export function roundHistoryPath(coin: string): string {
  return path.join(DATA_DIR, `round_history_${coin}.json`);
}

export function loadRoundHistory(coin: string): RoundHistoryEntry[] {
  try {
    return JSON.parse(fs.readFileSync(roundHistoryPath(coin), "utf-8"));
  } catch {
    return [];
  }
}

/** Build cumulative P&L map across all rounds. */
export function buildCumulativePnl(history: RoundHistoryEntry[]): Map<string, number> {
  const pnl = new Map<string, number>();
  for (const round of history) {
    for (const r of round.allResults || []) {
      pnl.set(r.engineId, (pnl.get(r.engineId) || 0) + r.totalPnl);
    }
  }
  return pnl;
}
