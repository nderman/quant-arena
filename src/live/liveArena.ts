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
  simBankrollUsd: number;        // what engines were designed for ($50 default)
  submit: OrderSubmitter;
  getOrder: OrderLookup;
  /** Override default intervals for testing */
  reconcileIntervalMs?: number;
  settlementIntervalMs?: number;
}

export interface LiveArenaHandle {
  states: Map<string, LiveEngineState>;
  onSimAction: (engineId: string, action: EngineAction, positionSide: "YES" | "NO") => Promise<ExecuteResult | null>;
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
 * Load graduated engine records for the given coin from live_engines.json.
 * Returns empty array if file missing or no engines graduated.
 */
export function loadGraduatedEngines(coin: string): { engineId: string; bankrollUsd: number; graduationRoundId: string }[] {
  const p = path.join(DATA_DIR, "live_engines.json");
  if (!fs.existsSync(p)) return [];
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const file = JSON.parse(raw) as LiveEnginesFile;
    const records = file[coin] ?? [];
    return records.map(r => ({
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
  const graduated = loadGraduatedEngines(cfg.coin);

  for (const g of graduated) {
    const walletAddr = process.env.FUNDER ?? "0x0";
    const state = createLiveState(g.engineId, walletAddr, g.bankrollUsd, g.graduationRoundId);
    states.set(g.engineId, state);
    console.log(`[live-arena:${cfg.coin}] loaded ${g.engineId} — bankroll $${g.bankrollUsd}`);
  }

  const reconcileMs = cfg.reconcileIntervalMs ?? 5_000;
  const settlementMs = cfg.settlementIntervalMs ?? 30_000;

  // Reconcile loop: poll CLOB for fills on pending orders
  const reconcileTimer = setInterval(async () => {
    if (states.size === 0) return;
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
  }, reconcileMs);

  // Settlement loop: poll Gamma for resolutions
  const settlementTimer = setInterval(async () => {
    if (states.size === 0) return;
    try {
      const results = await pollLiveSettlements(states, {
        tokenSlugPrefix: `${cfg.coin}-updown-5m`,
      });
      if (results.length > 0) {
        const netPnl = results.reduce((s, r) => s + r.pnl, 0);
        console.log(`[live-settle:${cfg.coin}] ${results.length} settlements, net $${netPnl.toFixed(2)}`);
      }
    } catch (err) {
      console.warn(`[live-settle:${cfg.coin}] error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, settlementMs);

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

  const stop = (): void => {
    clearInterval(reconcileTimer);
    clearInterval(settlementTimer);
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

  return { states, onSimAction, stop, snapshot };
}

/**
 * Compute a live engine's current total value (cash + MTM positions).
 * The markPriceFn should return the current best bid for a token.
 */
export function snapshotValue(state: LiveEngineState, markPriceFn: (tokenId: string) => number): number {
  return totalLiveValue(state, markPriceFn);
}
