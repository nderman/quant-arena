/**
 * Live Arena — parallel track that runs graduated engines against the CLOB.
 *
 * Runs in the same process as the sim arena, shares the same tick stream,
 * but maintains its own LiveEngineState per graduated engine. On each sim
 * engine action, the live arena calls executeLive() with the real CLOB
 * submitter, which places a real order and tracks it as pending.
 *
 * Responsibilities:
 *  - Load graduated engines from data/live_engines.json
 *  - Maintain LiveEngineState for each (one state per engine instance)
 *  - On every arena tick, mirror the engine's actions to live via executeLive
 *  - Run reconciliation loop on a timer (poll CLOB for fills)
 *  - Run settlement polling on a timer (Gamma API for resolutions)
 *  - Write live round stats when rounds end
 *  - Respect kill switch (data/live_halt.flag) — stop submitting instantly
 *
 * Dependency injection: takes a submitter + lookup so the same code runs
 * against dryRunAdapter in tests and real CLOB in production.
 */

import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "../historyStore";
import type { EngineAction, MarketTick } from "../types";
import type { LiveEngineState } from "./liveState";
import { createLiveState, totalLiveValue } from "./liveState";
import { executeLive, type OrderSubmitter, type ExecuteResult } from "./liveExecutor";
import { reconcilePending, type OrderLookup } from "./liveReconcile";
import { pollLiveSettlements } from "./liveSettlement";
import type { LiveEnginesFile } from "./graduation";

export interface LiveArenaConfig {
  coin: "btc" | "eth" | "sol" | "xrp";
  /** Arena instance identifier (e.g. "eth", "eth-15m"). When set, live_engines.json
   *  scopes by this key instead of coin — so different arenas for the same
   *  coin can run different live engines. */
  arenaInstanceId?: string;
  simBankrollUsd: number;        // what engines were designed for ($50 default)
  submit: OrderSubmitter;
  getOrder: OrderLookup;
  /** Cancel a batch of pending orders by clientOrderId. Optional — if
   *  omitted, candle rotation leaves stale makers on the book. */
  cancelOrders?: (clientOrderIds: string[]) => Promise<number>;
  /** Override default intervals for testing */
  reconcileIntervalMs?: number;
  settlementIntervalMs?: number;
}

export interface LiveArenaHandle {
  states: Map<string, LiveEngineState>;
  onSimAction: (engineId: string, action: EngineAction, positionSide: "YES" | "NO") => Promise<ExecuteResult | null>;
  /** Called by arena when candle rotates. Cancels all pending orders on
   *  expired tokens and arms fast-reconcile for approach-to-settlement. */
  onCandleRotate: (expiredTokenIds: Set<string>, newWindowEndMs: number) => Promise<void>;
  stop: () => void;
  snapshot: () => LiveSnapshot;
}

export interface LiveSnapshot {
  coin: string;
  engines: {
    engineId: string;
    cashBalance: number;
    positionCount: number;
    pendingCount: number;
    dailyLossUsd: number;
    paused: boolean;
    pauseReason?: string;
  }[];
}

/**
 * Load graduated engine records for the given arena from live_engines.json.
 *
 * Keys are arena instance IDs (e.g. "btc", "btc-15m", "eth-1h"). Falls back
 * to coin-level key for backward compat — if "eth" key exists and no
 * "eth-15m" key, all ETH arenas load from "eth". Any engine record can
 * optionally include `arenaInstanceId` to restrict to one arena only.
 */
export function loadGraduatedEngines(coin: string, arenaInstanceId?: string): { engineId: string; bankrollUsd: number; graduationRoundId: string }[] {
  const p = path.join(DATA_DIR, "live_engines.json");
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const file = JSON.parse(raw) as LiveEnginesFile;
    const iid = arenaInstanceId ?? coin;
    // Prefer arena-specific key, fall back to coin-level key for backward compat
    const records = file[iid] ?? (iid !== coin ? [] : (file[coin] ?? []));
    return records
      .filter(r => !r.arenaInstanceId || r.arenaInstanceId === iid)
      .map(r => ({
        engineId: r.engineId,
        bankrollUsd: r.bankrollUsd,
        graduationRoundId: r.graduationRoundId,
      }));
  } catch {
    return [];
  }
}

/**
 * Start a live arena track alongside the sim arena.
 *
 * Usage from arena.ts:
 *   const liveArena = startLiveArena({ coin: "btc", simBankrollUsd: 50,
 *     submit, getOrder });
 *   // In the tick handler, after running each engine:
 *   for (const action of actions) {
 *     await liveArena.onSimAction(engine.id, action, "YES");
 *   }
 */
export function startLiveArena(cfg: LiveArenaConfig): LiveArenaHandle {
  const states = new Map<string, LiveEngineState>();
  // Pass the arena instance ID so live_engines.json can scope engines to
  // specific arenas (e.g. "eth-15m") instead of loading on every arena for
  // the coin. Falls back to coin-level key for backward compat.
  const instanceId = (cfg as LiveArenaConfig & { arenaInstanceId?: string }).arenaInstanceId;
  const graduated = loadGraduatedEngines(cfg.coin, instanceId);

  for (const g of graduated) {
    const walletAddr = process.env.FUNDER ?? "0x0";
    const state = createLiveState(g.engineId, walletAddr, g.bankrollUsd, g.graduationRoundId);
    states.set(g.engineId, state);
    console.log(`[live-arena:${instanceId ?? cfg.coin}] loaded ${g.engineId} — bankroll $${g.bankrollUsd}`);
  }

  const reconcileMs = cfg.reconcileIntervalMs ?? 5_000;
  const reconcileFastMs = 1_000;  // last 30s before settlement
  const settlementMs = cfg.settlementIntervalMs ?? 30_000;

  // Track candle window end so reconcile can switch to fast mode in the
  // last 30s — captures fills that happen right before settlement.
  let currentWindowEndMs = 0;

  // Use recursive setTimeout instead of setInterval so a slow poll can't
  // stack up behind itself. Each loop waits for its previous run to finish
  // before scheduling the next.
  let running = true;
  let reconcileTimer: NodeJS.Timeout | null = null;
  let settlementTimer: NodeJS.Timeout | null = null;

  const runReconcile = async (): Promise<void> => {
    if (!running) return;
    try {
      for (const [engineId, state] of states) {
        if (state.pendingOrders.size === 0) continue;
        try {
          const r = await reconcilePending(state, cfg.getOrder);
          if (r.filled + r.cancelled + r.partialFills > 0) {
            console.log(`[live-reconcile:${engineId}] filled=${r.filled} partial=${r.partialFills} cancelled=${r.cancelled}`);
          }
        } catch (err) {
          console.warn(`[live-reconcile:${engineId}] error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      if (running) {
        // Fast-poll in the last 30s before candle settlement — critical window
        // for catching last-second maker fills before the $1/$0 resolution.
        const secsToSettle = currentWindowEndMs > 0 ? (currentWindowEndMs - Date.now()) / 1000 : Infinity;
        const nextMs = (secsToSettle > 0 && secsToSettle < 30) ? reconcileFastMs : reconcileMs;
        reconcileTimer = setTimeout(runReconcile, nextMs);
      }
    }
  };

  const runSettlement = async (): Promise<void> => {
    if (!running) return;
    try {
      if (states.size > 0) {
        const results = await pollLiveSettlements(states, {
          tokenSlugPrefix: `${cfg.coin}-updown-5m`,
        });
        if (results.length > 0) {
          const netPnl = results.reduce((s, r) => s + r.pnl, 0);
          console.log(`[live-settle:${cfg.coin}] ${results.length} settlements, net $${netPnl.toFixed(2)}`);
        }
      }
    } catch (err) {
      console.warn(`[live-settle:${cfg.coin}] error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (running) settlementTimer = setTimeout(runSettlement, settlementMs);
    }
  };

  reconcileTimer = setTimeout(runReconcile, reconcileMs);
  settlementTimer = setTimeout(runSettlement, settlementMs);

  // ── live_engines.json file-watcher (mid-round hot-reload) ──
  //
  // Polls the roster file's mtime every 30s. When it changes, diff the
  // roster: add new engines (fresh LiveEngineState), pause removed engines
  // but keep their state alive until open positions settle (prevents losing
  // track of in-flight trades). Avoids PM2 restart so sim arena stays alive.
  const liveEnginesPath = path.join(DATA_DIR, "live_engines.json");
  let lastMtimeMs = 0;
  try {
    lastMtimeMs = fs.statSync(liveEnginesPath).mtimeMs;
  } catch { /* file may not exist yet */ }

  let watcherTimer: NodeJS.Timeout | null = null;
  const checkRosterChange = (): void => {
    if (!running) return;
    try {
      const stat = fs.statSync(liveEnginesPath);
      if (stat.mtimeMs > lastMtimeMs) {
        lastMtimeMs = stat.mtimeMs;
        const newRoster = loadGraduatedEngines(cfg.coin, instanceId);
        const newIds = new Set(newRoster.map(g => g.engineId));
        const oldIds = new Set(states.keys());

        // Added engines (or re-added after a pause)
        const walletAddr = process.env.FUNDER ?? "0x0";
        for (const g of newRoster) {
          const existing = states.get(g.engineId);
          if (!existing) {
            const state = createLiveState(g.engineId, walletAddr, g.bankrollUsd, g.graduationRoundId);
            states.set(g.engineId, state);
            console.log(`[live-arena:${instanceId ?? cfg.coin}] HOT-ADD ${g.engineId} bankroll=$${g.bankrollUsd}`);
          } else if (existing.paused && existing.pauseReason === "removed-from-roster-awaiting-settle") {
            // Engine was previously removed but kept alive for settlement.
            // Now it's been re-added — clear the pause so it can fire again.
            existing.paused = false;
            existing.pauseReason = undefined;
            console.log(`[live-arena:${instanceId ?? cfg.coin}] HOT-RESUME ${g.engineId} (re-added before settlement)`);
          }
        }

        // Removed engines: pause but keep state if open positions; only delete
        // when all positions settle and no pending orders remain.
        for (const eid of oldIds) {
          if (!newIds.has(eid)) {
            const state = states.get(eid);
            if (!state) continue;
            const hasOpenWork = state.positions.size > 0 || state.pendingOrders.size > 0;
            if (hasOpenWork) {
              if (!state.paused) {
                state.paused = true;
                state.pauseReason = "removed-from-roster-awaiting-settle";
                console.log(`[live-arena:${instanceId ?? cfg.coin}] HOT-REMOVE ${eid} — pausing (positions=${state.positions.size}, pending=${state.pendingOrders.size}); state retained until settle`);
              }
            } else {
              states.delete(eid);
              console.log(`[live-arena:${instanceId ?? cfg.coin}] HOT-REMOVE ${eid} — clean removal`);
            }
          }
        }
      }
    } catch (err) {
      // File may not exist; ignore quietly
      if (err instanceof Error && !err.message.includes("ENOENT")) {
        console.warn(`[live-arena:${instanceId ?? cfg.coin}] roster watcher error: ${err.message}`);
      }
    } finally {
      if (running) watcherTimer = setTimeout(checkRosterChange, 30_000);
    }
  };
  watcherTimer = setTimeout(checkRosterChange, 30_000);

  const onSimAction = async (
    engineId: string,
    action: EngineAction,
    positionSide: "YES" | "NO",
  ): Promise<ExecuteResult | null> => {
    const state = states.get(engineId);
    if (!state) return null; // engine not graduated — ignore
    if (state.paused) return null;

    return executeLive(engineId, action, state, cfg.submit, {
      simBankrollUsd: cfg.simBankrollUsd,
      positionSide,
    });
  };

  const onCandleRotate = async (expiredTokenIds: Set<string>, newWindowEndMs: number): Promise<void> => {
    currentWindowEndMs = newWindowEndMs;
    if (!cfg.cancelOrders) return;

    // Collect clientOrderIds for pending orders on expired tokens
    const toCancel: string[] = [];
    for (const [, state] of states) {
      for (const [clientOrderId, order] of state.pendingOrders) {
        if (expiredTokenIds.has(order.tokenId)) {
          toCancel.push(clientOrderId);
        }
      }
    }
    if (toCancel.length === 0) return;

    try {
      const cancelled = await cfg.cancelOrders(toCancel);
      console.log(`[live-cancel:${cfg.coin}] cancelled ${cancelled}/${toCancel.length} orders on rotation`);
      // Reconcile loop will pick up CANCELLED status and release the cash.
    } catch (err) {
      console.warn(`[live-cancel:${cfg.coin}] error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const stop = (): void => {
    running = false;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    if (settlementTimer) clearTimeout(settlementTimer);
    if (watcherTimer) clearTimeout(watcherTimer);
  };

  const snapshot = (): LiveSnapshot => ({
    coin: cfg.coin,
    engines: [...states.values()].map(s => ({
      engineId: s.engineId,
      cashBalance: s.cashBalance,
      positionCount: s.positions.size,
      pendingCount: s.pendingOrders.size,
      dailyLossUsd: s.dailyLossUsd,
      paused: s.paused,
      pauseReason: s.pauseReason,
    })),
  });

  return { states, onSimAction, onCandleRotate, stop, snapshot };
}

/**
 * Compute a live engine's current total value (cash + MTM positions).
 * The markPriceFn should return the current best bid for a token.
 */
export function snapshotValue(state: LiveEngineState, markPriceFn: (tokenId: string) => number): number {
  return totalLiveValue(state, markPriceFn);
}
