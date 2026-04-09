/**
 * Live engine state — separate from sim EngineState.
 *
 * A graduated engine runs in BOTH sim and live modes simultaneously.
 * Sim state is the brain (continuous health check). Live state is the
 * shadow that mirrors actions to real CLOB orders.
 */

import type { EngineState, PositionState } from "../types";

export interface PendingOrder {
  clientOrderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  postedAt: number;
  filledSize: number;
}

export interface LiveEngineState {
  engineId: string;
  walletAddress: string;
  bankrollUsd: number;          // initial allocation
  cashBalance: number;          // current free USDC
  positions: Map<string, PositionState>; // tokenId → live position
  pendingOrders: Map<string, PendingOrder>;

  // Risk tracking
  dailyLossUsd: number;
  dayStartCashUsd: number;
  dayStartTimestamp: number;

  // Health tracking
  lastReconcileAt: number;
  lastHeartbeatAt: number;
  driftFromSimUsd: number;       // |liveTotalValue - simTotalValue|

  // Lifecycle
  graduatedAt: number;
  graduationRoundId: string;
  paused: boolean;
  pauseReason?: string;
}

export function createLiveState(
  engineId: string,
  walletAddress: string,
  bankrollUsd: number,
  graduationRoundId: string,
): LiveEngineState {
  const now = Date.now();
  return {
    engineId,
    walletAddress,
    bankrollUsd,
    cashBalance: bankrollUsd,
    positions: new Map(),
    pendingOrders: new Map(),
    dailyLossUsd: 0,
    dayStartCashUsd: bankrollUsd,
    dayStartTimestamp: now,
    lastReconcileAt: 0,
    lastHeartbeatAt: now,
    driftFromSimUsd: 0,
    graduatedAt: now,
    graduationRoundId,
    paused: false,
  };
}

/** Total value: cash + sum of position MTM (using current price) */
export function totalLiveValue(state: LiveEngineState, getMarkPrice: (tokenId: string) => number): number {
  let total = state.cashBalance;
  for (const [tokenId, pos] of state.positions) {
    total += pos.shares * getMarkPrice(tokenId);
  }
  return total;
}

/** Compute drift between sim and live total values */
export function computeDrift(
  liveState: LiveEngineState,
  simState: EngineState,
  getMarkPrice: (tokenId: string) => number,
): number {
  const liveTotal = totalLiveValue(liveState, getMarkPrice);
  let simTotal = simState.cashBalance;
  for (const [tokenId, pos] of simState.positions) {
    simTotal += pos.shares * getMarkPrice(tokenId);
  }
  return Math.abs(liveTotal - simTotal);
}
