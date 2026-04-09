/**
 * Graduation — evaluates which sim engines qualify for live trading.
 *
 * Runs at end of every sim round. Reads round_history_${coin}.json,
 * applies the criteria, writes data/live_engines.json atomically.
 *
 * Criteria (must pass all):
 * - Min 10 rounds played
 * - Cumulative > +$500
 * - Win rate ≥ 50%
 * - Worst round ≥ -$30 (no engines that nuke from orbit)
 * - Sharpe-like (mean/stddev) > 1.0
 * - Profitable on at least 1 coin
 */

import * as fs from "fs";
import * as path from "path";

export const GRADUATION_CRITERIA = {
  MIN_ROUNDS: 10,
  MIN_CUMULATIVE_PNL: 500,
  MIN_WIN_RATE: 0.50,
  MAX_LOSS_PER_ROUND: -30,
  MIN_SHARPE: 1.0,
  DEFAULT_BANKROLL_USD: 50,
  LIVE_ENGINES_PATH: "data/live_engines.json",
  DEMOTE_SHARPE_THRESHOLD: 0.5,
  DEMOTE_WIN_RATE: 0.40,
  DEMOTE_LOOKBACK: 5,
};

interface RoundResult {
  engineId: string;
  totalPnl: number;
  tradeCount: number;
}

interface RoundHistoryEntry {
  roundId: string;
  allResults: RoundResult[];
  timestamp?: string;
}

export interface EngineStats {
  engineId: string;
  rounds: number;
  cumulativePnl: number;
  winRate: number;
  worstRound: number;
  bestRound: number;
  meanPnl: number;
  stddevPnl: number;
  sharpe: number;
  recentSharpe: number; // last DEMOTE_LOOKBACK rounds
  recentWinRate: number;
}

export interface LiveEngineRecord {
  engineId: string;
  coin: string;
  bankrollUsd: number;
  graduatedAt: string;
  graduationRoundId: string;
  stats: EngineStats;
}

export type LiveEnginesFile = Record<string, LiveEngineRecord[]>;

export function computeStats(engineId: string, history: RoundHistoryEntry[]): EngineStats {
  const pnls: number[] = [];
  for (const round of history) {
    const r = round.allResults?.find(x => x.engineId === engineId);
    if (r) pnls.push(r.totalPnl);
  }

  const rounds = pnls.length;
  if (rounds === 0) {
    return {
      engineId, rounds: 0, cumulativePnl: 0, winRate: 0,
      worstRound: 0, bestRound: 0, meanPnl: 0, stddevPnl: 0,
      sharpe: 0, recentSharpe: 0, recentWinRate: 0,
    };
  }

  const cumulativePnl = pnls.reduce((a, b) => a + b, 0);
  const wins = pnls.filter(p => p > 0).length;
  const winRate = wins / rounds;
  const worstRound = Math.min(...pnls);
  const bestRound = Math.max(...pnls);
  const meanPnl = cumulativePnl / rounds;
  const variance = pnls.reduce((a, p) => a + (p - meanPnl) ** 2, 0) / rounds;
  const stddevPnl = Math.sqrt(variance);
  const sharpe = stddevPnl > 0 ? meanPnl / stddevPnl : 0;

  const recent = pnls.slice(-GRADUATION_CRITERIA.DEMOTE_LOOKBACK);
  const recentMean = recent.reduce((a, b) => a + b, 0) / Math.max(1, recent.length);
  const recentVar = recent.reduce((a, p) => a + (p - recentMean) ** 2, 0) / Math.max(1, recent.length);
  const recentStddev = Math.sqrt(recentVar);
  const recentSharpe = recentStddev > 0 ? recentMean / recentStddev : 0;
  const recentWinRate = recent.filter(p => p > 0).length / Math.max(1, recent.length);

  return {
    engineId, rounds, cumulativePnl, winRate, worstRound, bestRound,
    meanPnl, stddevPnl, sharpe, recentSharpe, recentWinRate,
  };
}

export function passesCriteria(stats: EngineStats): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (stats.rounds < GRADUATION_CRITERIA.MIN_ROUNDS) {
    reasons.push(`rounds ${stats.rounds} < ${GRADUATION_CRITERIA.MIN_ROUNDS}`);
  }
  if (stats.cumulativePnl < GRADUATION_CRITERIA.MIN_CUMULATIVE_PNL) {
    reasons.push(`cumulative $${stats.cumulativePnl.toFixed(2)} < $${GRADUATION_CRITERIA.MIN_CUMULATIVE_PNL}`);
  }
  if (stats.winRate < GRADUATION_CRITERIA.MIN_WIN_RATE) {
    reasons.push(`winrate ${(stats.winRate * 100).toFixed(0)}% < ${GRADUATION_CRITERIA.MIN_WIN_RATE * 100}%`);
  }
  if (stats.worstRound < GRADUATION_CRITERIA.MAX_LOSS_PER_ROUND) {
    reasons.push(`worst round $${stats.worstRound.toFixed(2)} < $${GRADUATION_CRITERIA.MAX_LOSS_PER_ROUND}`);
  }
  if (stats.sharpe < GRADUATION_CRITERIA.MIN_SHARPE) {
    reasons.push(`sharpe ${stats.sharpe.toFixed(2)} < ${GRADUATION_CRITERIA.MIN_SHARPE}`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Evaluate one coin's history, return the engines that pass.
 * Does not write — just returns the candidates.
 */
export function evaluateCoinHistory(coin: string, historyPath: string): EngineStats[] {
  if (!fs.existsSync(historyPath)) return [];
  let history: RoundHistoryEntry[];
  try {
    history = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
  } catch { return []; }

  // Get all unique engine IDs
  const engineIds = new Set<string>();
  for (const round of history) {
    for (const r of round.allResults || []) engineIds.add(r.engineId);
  }

  const passing: EngineStats[] = [];
  for (const id of engineIds) {
    const stats = computeStats(id, history);
    const check = passesCriteria(stats);
    if (check.ok) passing.push(stats);
  }
  return passing.sort((a, b) => b.cumulativePnl - a.cumulativePnl);
}

/**
 * Should this engine be DEMOTED from live? Recent performance check.
 */
export function shouldDemote(stats: EngineStats): boolean {
  return stats.recentSharpe < GRADUATION_CRITERIA.DEMOTE_SHARPE_THRESHOLD ||
         stats.recentWinRate < GRADUATION_CRITERIA.DEMOTE_WIN_RATE;
}

/**
 * Evaluate graduation candidates for a coin. FLAGS engines that pass criteria
 * but does NOT auto-promote. Writes to data/live_candidates.json for manual review.
 *
 * To actually promote: edit data/live_engines.json by hand (or via Telegram cmd later).
 */
export function flagGraduationCandidates(coin: string, historyPath: string, currentRoundId: string): void {
  const passing = evaluateCoinHistory(coin, historyPath);
  if (passing.length === 0) return;

  // Load existing live_engines.json to skip already-promoted ones
  let existing: LiveEnginesFile = {};
  if (fs.existsSync(GRADUATION_CRITERIA.LIVE_ENGINES_PATH)) {
    try {
      existing = JSON.parse(fs.readFileSync(GRADUATION_CRITERIA.LIVE_ENGINES_PATH, "utf-8"));
    } catch {}
  }
  const liveIds = new Set((existing[coin] || []).map(r => r.engineId));

  const newCandidates = passing.filter(s => !liveIds.has(s.engineId));
  if (newCandidates.length === 0) return;

  const candidatesPath = "data/live_candidates.json";
  let candidates: Record<string, EngineStats[]> = {};
  if (fs.existsSync(candidatesPath)) {
    try { candidates = JSON.parse(fs.readFileSync(candidatesPath, "utf-8")); } catch {}
  }
  candidates[coin] = newCandidates;
  fs.writeFileSync(candidatesPath, JSON.stringify(candidates, null, 2));

  console.log(`[graduation] ${coin}: ${newCandidates.length} new candidates flagged for review`);
  for (const c of newCandidates) {
    console.log(`  ${c.engineId}: cum=$${c.cumulativePnl.toFixed(2)} winRate=${(c.winRate*100).toFixed(0)}% sharpe=${c.sharpe.toFixed(2)} worst=$${c.worstRound.toFixed(2)} (${c.rounds}r)`);
  }
}

/**
 * Manually promote an engine from candidates to live (called from CLI/Telegram).
 */
export function promoteEngine(coin: string, engineId: string, currentRoundId: string, bankrollUsd?: number): boolean {
  const candidatesPath = "data/live_candidates.json";
  if (!fs.existsSync(candidatesPath)) {
    console.warn(`[graduation] no candidates file at ${candidatesPath}`);
    return false;
  }
  const candidates: Record<string, EngineStats[]> = JSON.parse(fs.readFileSync(candidatesPath, "utf-8"));
  const stats = (candidates[coin] || []).find(c => c.engineId === engineId);
  if (!stats) {
    console.warn(`[graduation] ${engineId} not found in ${coin} candidates`);
    return false;
  }

  let existing: LiveEnginesFile = {};
  if (fs.existsSync(GRADUATION_CRITERIA.LIVE_ENGINES_PATH)) {
    try { existing = JSON.parse(fs.readFileSync(GRADUATION_CRITERIA.LIVE_ENGINES_PATH, "utf-8")); } catch {}
  }
  const list = existing[coin] || [];
  if (list.some(r => r.engineId === engineId)) {
    console.warn(`[graduation] ${engineId} already live on ${coin}`);
    return false;
  }
  list.push({
    engineId,
    coin,
    bankrollUsd: bankrollUsd ?? GRADUATION_CRITERIA.DEFAULT_BANKROLL_USD,
    graduatedAt: new Date().toISOString(),
    graduationRoundId: currentRoundId,
    stats,
  });
  existing[coin] = list;

  const tmp = GRADUATION_CRITERIA.LIVE_ENGINES_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
  fs.renameSync(tmp, GRADUATION_CRITERIA.LIVE_ENGINES_PATH);

  console.log(`[graduation] PROMOTED ${engineId} to live on ${coin} with $${bankrollUsd ?? GRADUATION_CRITERIA.DEFAULT_BANKROLL_USD} bankroll`);
  return true;
}
