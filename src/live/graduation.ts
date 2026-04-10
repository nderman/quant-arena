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
import { DATA_DIR, loadRoundHistory, type RoundHistoryEntry } from "../historyStore";

export const GRADUATION_CRITERIA = {
  MIN_ROUNDS: 10,
  MIN_CUMULATIVE_PNL: 500,
  MIN_WIN_RATE: 0.50,
  MAX_LOSS_PER_ROUND: -30,
  MIN_SHARPE: 1.0,
  DEFAULT_BANKROLL_USD: 50,
  LIVE_ENGINES_PATH: path.join(DATA_DIR, "live_engines.json"),
  CANDIDATES_PATH: path.join(DATA_DIR, "live_candidates.json"),
  DEMOTE_SHARPE_THRESHOLD: 0.5,
  DEMOTE_WIN_RATE: 0.40,
  DEMOTE_LOOKBACK: 5,
};

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

function buildPnlMap(history: RoundHistoryEntry[]): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const round of history) {
    for (const r of round.allResults || []) {
      const arr = map.get(r.engineId) || [];
      arr.push(r.totalPnl);
      map.set(r.engineId, arr);
    }
  }
  return map;
}

export function computeStats(engineId: string, history: RoundHistoryEntry[]): EngineStats {
  const map = buildPnlMap(history);
  return computeStatsFromPnls(engineId, map.get(engineId) || []);
}

function computeStatsFromPnls(engineId: string, pnls: number[]): EngineStats {
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
export function evaluateCoinHistory(coin: string): EngineStats[] {
  const history = loadRoundHistory(coin);
  if (history.length === 0) return [];

  const pnlMap = buildPnlMap(history);
  const passing: EngineStats[] = [];
  for (const [id, pnls] of pnlMap) {
    const stats = computeStatsFromPnls(id, pnls);
    if (passesCriteria(stats).ok) passing.push(stats);
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

function readJsonSafe<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, data: unknown): void {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

/**
 * Evaluate graduation candidates for a coin. FLAGS engines that pass criteria
 * but does NOT auto-promote. Writes to data/live_candidates.json for manual review.
 */
export function flagGraduationCandidates(coin: string, currentRoundId: string): void {
  const passing = evaluateCoinHistory(coin);
  if (passing.length === 0) return;

  const existing = readJsonSafe<LiveEnginesFile>(GRADUATION_CRITERIA.LIVE_ENGINES_PATH, {});
  const liveIds = new Set((existing[coin] || []).map(r => r.engineId));

  const newCandidates = passing.filter(s => !liveIds.has(s.engineId));
  if (newCandidates.length === 0) return;

  const candidates = readJsonSafe<Record<string, EngineStats[]>>(GRADUATION_CRITERIA.CANDIDATES_PATH, {});
  candidates[coin] = newCandidates;
  writeJsonAtomic(GRADUATION_CRITERIA.CANDIDATES_PATH, candidates);

  console.log(`[graduation] ${coin}: ${newCandidates.length} new candidates flagged for review`);
  for (const c of newCandidates) {
    console.log(`  ${c.engineId}: cum=$${c.cumulativePnl.toFixed(2)} winRate=${(c.winRate*100).toFixed(0)}% sharpe=${c.sharpe.toFixed(2)} worst=$${c.worstRound.toFixed(2)} (${c.rounds}r)`);
  }
}

/**
 * Manually promote an engine from candidates to live (called from CLI/Telegram).
 */
export function promoteEngine(coin: string, engineId: string, currentRoundId: string, bankrollUsd?: number): boolean {
  const candidates = readJsonSafe<Record<string, EngineStats[]>>(GRADUATION_CRITERIA.CANDIDATES_PATH, {});
  const stats = (candidates[coin] || []).find(c => c.engineId === engineId);
  if (!stats) {
    console.warn(`[graduation] ${engineId} not found in ${coin} candidates`);
    return false;
  }

  const existing = readJsonSafe<LiveEnginesFile>(GRADUATION_CRITERIA.LIVE_ENGINES_PATH, {});
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
  writeJsonAtomic(GRADUATION_CRITERIA.LIVE_ENGINES_PATH, existing);

  console.log(`[graduation] PROMOTED ${engineId} to live on ${coin} with $${bankrollUsd ?? GRADUATION_CRITERIA.DEFAULT_BANKROLL_USD} bankroll`);
  return true;
}
