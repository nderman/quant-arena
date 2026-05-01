/**
 * Live Executor — the bridge between a sim engine's decision and a real CLOB order.
 *
 * Responsibilities (in order):
 *  1. Run risk gates (canTrade) — pause, daily loss, position caps, pending caps
 *  2. Scale sim action to live bankroll (sizeForLive)
 *  3. Re-run risk gates on the sized action (size may have changed)
 *  4. Submit via an injected submitter (dryRun or real CLOB)
 *  5. Reserve cash + record pending order in live state
 *  6. Return a structured result so callers can log/audit
 *
 * This module is pure coordinator. It owns no I/O itself — the submitter
 * function is passed in so the same executor runs against dryRunAdapter in
 * tests and against the real CLOB in production.
 */

import type { EngineAction, PositionState } from "../types";
import type { LiveEngineState, PendingOrder } from "./liveState";
import { canTrade, rolloverDailyLossIfNeeded } from "./riskManager";
import { sizeForLive, computeCandleExposure, type SizingConfig } from "./liveSizing";
import { recordFill } from "./liveLedger";

export type SubmitResult =
  | { ok: true; clientOrderId: string; filledSize: number; avgFillPrice: number }
  | { ok: false; reason: string };

/**
 * Injected submitter — a function that takes a sized action and returns
 * a SubmitResult. In tests this is dryRunPlaceOrder wrapped. In production
 * it's a thin layer over ClobClient.createAndPostOrder.
 */
export type OrderSubmitter = (action: EngineAction) => Promise<SubmitResult>;

export interface ExecuteOptions {
  /** Live bankroll used for sizing (usually fixed at graduation time) */
  simBankrollUsd: number;
  /** Override candle exposure cap (default 60% from sizeForLive) */
  maxCandleExposurePct?: number;
  /**
   * Position side hint for new positions created from BUY fills. Engines
   * know whether they're buying UP/YES or DOWN/NO; the executor doesn't.
   * Defaults to "YES" but callers should pass the correct side.
   */
  positionSide?: "YES" | "NO";
  /** Coin (btc/eth/sol) — used by the ledger to tag fills */
  coin?: string;
  /** Arena instance id (e.g. "eth-4h") — used by the ledger */
  arenaInstanceId?: string;
}

export interface ExecuteResult {
  engineId: string;
  accepted: boolean;
  reason?: string;
  originalAction: EngineAction;
  sizedAction?: EngineAction;
  submitResult?: SubmitResult;
  /** Amount of cash reserved (BUY only) when the order was accepted */
  cashReserved?: number;
}

/**
 * Execute one action from a graduated engine. Idempotent on rejection —
 * state is only mutated when the order is accepted AND successfully submitted.
 */
export async function executeLive(
  engineId: string,
  action: EngineAction,
  state: LiveEngineState,
  submit: OrderSubmitter,
  opts: ExecuteOptions,
): Promise<ExecuteResult> {
  rolloverDailyLossIfNeeded(state);

  const base: ExecuteResult = { engineId, accepted: false, originalAction: action };

  // HOLD is trivially accepted, nothing to do
  if (action.side === "HOLD") {
    return { ...base, accepted: true, sizedAction: action };
  }

  // MERGE has its own path — risk manager validates and executor hands off
  // to merger.ts (not implemented here; MERGE returns a structured result
  // that the caller can dispatch)
  if (action.side === "MERGE") {
    const pre = canTrade(action, state);
    if (!pre.ok) return { ...base, reason: pre.reason };
    return { ...base, accepted: true, sizedAction: action };
  }

  // 1. Pre-sizing risk check — catches halt / paused / daily loss
  //    (position/order count checks still pass since size hasn't changed)
  const preCheck = canTrade(action, state);
  if (!preCheck.ok) return { ...base, reason: `pre-size: ${preCheck.reason}` };

  // 2. Size for live bankroll
  const cfg: SizingConfig = {
    liveBankrollUsd: state.bankrollUsd,
    simBankrollUsd: opts.simBankrollUsd,
    maxCandleExposurePct: opts.maxCandleExposurePct,
    currentCandleExposureUsd: computeCandleExposure(state),
  };
  const sized = sizeForLive(action, state, cfg);
  if (!sized.action) {
    return { ...base, reason: `sizing: ${sized.reason}` };
  }

  // 3. Post-sizing risk check — uses the sized action's actual USD.
  // sizeForLive already clamps to MAX_POSITION_PCT, so a canTrade rejection
  // here means a different constraint (cash, position count, pending count).
  const postCheck = canTrade(sized.action, state);
  if (!postCheck.ok) {
    return { ...base, sizedAction: sized.action, reason: `post-size: ${postCheck.reason}` };
  }

  return submitAndRecord(engineId, action, sized.action, state, submit, base, opts.positionSide ?? "YES", opts.coin, opts.arenaInstanceId);
}

async function submitAndRecord(
  engineId: string,
  originalAction: EngineAction,
  sizedAction: EngineAction,
  state: LiveEngineState,
  submit: OrderSubmitter,
  base: ExecuteResult,
  positionSide: "YES" | "NO",
  coin?: string,
  arenaInstanceId?: string,
): Promise<ExecuteResult> {
  let submitResult: SubmitResult;
  try {
    submitResult = await submit(sizedAction);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ...base, sizedAction, reason: `submit threw: ${reason}` };
  }

  if (!submitResult.ok) {
    return { ...base, sizedAction, submitResult, reason: `submit rejected: ${submitResult.reason}` };
  }

  // Order accepted. Reserve cash + record pending order.
  const orderUsd = sizedAction.size * sizedAction.price;
  let cashReserved = 0;
  if (sizedAction.side === "BUY") {
    state.cashBalance -= orderUsd;
    cashReserved = orderUsd;
  }

  const pending: PendingOrder = {
    clientOrderId: submitResult.clientOrderId,
    tokenId: sizedAction.tokenId,
    side: sizedAction.side === "BUY" ? "BUY" : "SELL",
    price: sizedAction.price,
    size: sizedAction.size,
    postedAt: Date.now(),
    filledSize: submitResult.filledSize,
  };
  state.pendingOrders.set(submitResult.clientOrderId, pending);

  // Instant fill? Update the position immediately.
  if (submitResult.filledSize >= sizedAction.size) {
    applyFill(state, sizedAction, submitResult, positionSide);
    state.pendingOrders.delete(submitResult.clientOrderId);
    // Ledger emission — only on confirmed fills, not pending submissions
    if (coin && arenaInstanceId) {
      recordFill({
        engineId,
        coin,
        arenaInstanceId,
        tokenId: sizedAction.tokenId,
        positionSide,
        side: sizedAction.side === "BUY" ? "BUY" : "SELL",
        size: submitResult.filledSize,
        limitPrice: sizedAction.price,
        fillPrice: submitResult.avgFillPrice,
        cost: submitResult.filledSize * submitResult.avgFillPrice,
        clientOrderId: submitResult.clientOrderId,
      });
    }
  }

  return {
    ...base,
    accepted: true,
    sizedAction,
    submitResult,
    cashReserved,
  };
}

/**
 * Apply a completed fill to live state. Used by:
 *  - submitAndRecord() for instant-fill submitters (dryRun)
 *  - liveReconcile loop for async CLOB fills (not yet implemented)
 *
 * positionSide: "YES" or "NO", required for new BUY positions since the
 * executor can't infer which outcome token from the action alone.
 */
export function applyFill(
  state: LiveEngineState,
  action: EngineAction,
  fill: { filledSize: number; avgFillPrice: number },
  positionSide: "YES" | "NO" = "YES",
): void {
  const { tokenId, side } = action;
  const fillCost = fill.filledSize * fill.avgFillPrice;

  if (side === "BUY") {
    const existing = state.positions.get(tokenId);
    if (existing) {
      const totalShares = existing.shares + fill.filledSize;
      const totalCost = existing.costBasis + fillCost;
      existing.shares = totalShares;
      existing.costBasis = totalCost;
      existing.avgEntry = totalShares > 0 ? totalCost / totalShares : 0;
    } else {
      const pos: PositionState = {
        tokenId,
        side: positionSide,
        shares: fill.filledSize,
        avgEntry: fill.avgFillPrice,
        costBasis: fillCost,
      };
      state.positions.set(tokenId, pos);
    }
    // Cash was reserved at submit; if partial fill, release the unreserved
    // portion (actual - reserved delta). For instant full fills this is a no-op.
    const reservedDelta = (action.size - fill.filledSize) * action.price;
    if (reservedDelta > 0) state.cashBalance += reservedDelta;
  } else if (side === "SELL") {
    const existing = state.positions.get(tokenId);
    if (existing) {
      // Compute fraction of cost basis to keep BEFORE mutating shares —
      // otherwise the ratio is wrong (denominator uses post-mutation value).
      const remainingShares = Math.max(0, existing.shares - fill.filledSize);
      const keepFraction = existing.shares > 0 ? remainingShares / existing.shares : 0;
      existing.shares = remainingShares;
      existing.costBasis *= keepFraction;
      state.cashBalance += fill.filledSize * fill.avgFillPrice;
      if (remainingShares === 0) state.positions.delete(tokenId);
    }
  }
}
