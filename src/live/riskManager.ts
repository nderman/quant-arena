/**
 * Risk Manager — pure validation, no side effects.
 *
 * Hard caps before any live order is placed:
 * - Per-order size ≤ MAX_POSITION_PCT of bankroll
 * - Daily loss ≤ MAX_DAILY_LOSS_USD (auto-pause)
 * - Max open positions ≤ MAX_OPEN_POSITIONS
 * - Engine not paused
 * - Kill switch not active
 */

import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "../historyStore";
import type { EngineAction } from "../types";
import type { LiveEngineState } from "./liveState";

export const RISK_CONFIG = {
  MAX_POSITION_PCT: 0.30,        // 30% of bankroll per order (was 5% — too restrictive at $25 bankroll)
  MAX_DAILY_LOSS_USD: 50,        // pause for the day if hit
  MAX_OPEN_POSITIONS: 5,         // limit concurrent exposure
  MAX_PENDING_ORDERS: 10,        // unfilled orders cap
  MIN_ORDER_USD: 1,              // PM minimum
  HALT_FLAG_PATH: path.join(DATA_DIR, "live_halt.flag"),
  HALT_RECHECK_MS: 5_000,        // re-stat the halt flag at most this often
};

export interface RiskCheckResult {
  ok: boolean;
  reason?: string;
}

let haltCache = { value: false, checkedAt: 0 };

export function isHalted(): boolean {
  const now = Date.now();
  if (now - haltCache.checkedAt < RISK_CONFIG.HALT_RECHECK_MS) return haltCache.value;
  haltCache = { value: fs.existsSync(RISK_CONFIG.HALT_FLAG_PATH), checkedAt: now };
  return haltCache.value;
}

/** Force re-check (test/debug only) */
export function _resetHaltCache(): void {
  haltCache = { value: false, checkedAt: 0 };
}

export function canTrade(action: EngineAction, state: LiveEngineState): RiskCheckResult {
  if (isHalted()) return { ok: false, reason: "kill switch active (data/live_halt.flag)" };
  if (state.paused) return { ok: false, reason: `engine paused: ${state.pauseReason ?? "unknown"}` };
  if (action.side === "HOLD") return { ok: true };

  // MERGE: just verify position exists. Sizing checked in liveExecutor via planMerge.
  if (action.side === "MERGE") {
    const pos = state.positions.get(action.tokenId);
    if (!pos || pos.shares <= 0) return { ok: false, reason: "MERGE without position" };
    return { ok: true };
  }

  // Daily loss check
  if (state.dailyLossUsd >= RISK_CONFIG.MAX_DAILY_LOSS_USD) {
    return { ok: false, reason: `daily loss ${state.dailyLossUsd.toFixed(2)} >= ${RISK_CONFIG.MAX_DAILY_LOSS_USD}` };
  }

  // Position count cap (only on BUY/SELL, not exits of existing positions)
  if (action.side === "BUY") {
    const hasExisting = state.positions.has(action.tokenId);
    if (!hasExisting && state.positions.size >= RISK_CONFIG.MAX_OPEN_POSITIONS) {
      return { ok: false, reason: `${state.positions.size} open positions >= ${RISK_CONFIG.MAX_OPEN_POSITIONS}` };
    }
  }

  // Pending order cap
  if (state.pendingOrders.size >= RISK_CONFIG.MAX_PENDING_ORDERS) {
    return { ok: false, reason: `${state.pendingOrders.size} pending orders >= ${RISK_CONFIG.MAX_PENDING_ORDERS}` };
  }

  // Order size: must be ≥ MIN_ORDER_USD and ≤ MAX_POSITION_PCT of bankroll
  const orderUsd = action.size * action.price;
  if (orderUsd < RISK_CONFIG.MIN_ORDER_USD) {
    return { ok: false, reason: `order $${orderUsd.toFixed(2)} below min $${RISK_CONFIG.MIN_ORDER_USD}` };
  }
  const maxOrderUsd = state.bankrollUsd * RISK_CONFIG.MAX_POSITION_PCT;
  if (orderUsd > maxOrderUsd) {
    return { ok: false, reason: `order $${orderUsd.toFixed(2)} exceeds max $${maxOrderUsd.toFixed(2)} (${RISK_CONFIG.MAX_POSITION_PCT * 100}% of $${state.bankrollUsd})` };
  }

  // BUY: must have cash
  if (action.side === "BUY" && orderUsd > state.cashBalance) {
    return { ok: false, reason: `insufficient cash: need $${orderUsd.toFixed(2)}, have $${state.cashBalance.toFixed(2)}` };
  }

  // SELL: must have shares
  if (action.side === "SELL") {
    const pos = state.positions.get(action.tokenId);
    if (!pos || pos.shares < action.size) {
      return { ok: false, reason: `cannot sell ${action.size}: have ${pos?.shares ?? 0}` };
    }
  }

  return { ok: true };
}

/** Clamp an order to the max allowed size based on bankroll */
export function clampOrderSize(action: EngineAction, state: LiveEngineState): number {
  const maxOrderUsd = state.bankrollUsd * RISK_CONFIG.MAX_POSITION_PCT;
  const maxShares = Math.floor(maxOrderUsd / action.price);
  return Math.min(action.size, maxShares);
}

/** Reset daily loss counter at midnight UTC */
export function rolloverDailyLossIfNeeded(state: LiveEngineState): void {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  if (now - state.dayStartTimestamp >= dayMs) {
    state.dailyLossUsd = 0;
    state.dayStartCashUsd = state.cashBalance;
    state.dayStartTimestamp = now;
  }
}
