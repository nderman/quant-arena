/**
 * Live Fill Reconciliation — polls CLOB for pending order status and
 * applies fills / cancels to LiveEngineState.
 *
 * Real CLOB orders fill asynchronously. liveExecutor records them as
 * pending with filledSize=0; this loop:
 *  1. For each pending order in state, call getOrder(clientOrderId)
 *  2. If filled → applyFill() + delete pending
 *  3. If partially filled → applyFill(delta) + update pendingOrder.filledSize
 *  4. If cancelled / expired → release reserved cash + delete pending
 *  5. If still open → leave unchanged
 *
 * Design notes:
 *  - Uses injected getOrder / cancelOrder so it works with dryRunAdapter
 *  - Stateless between calls (reads from LiveEngineState every time)
 *  - Safe to call on a timer or as part of the main tick loop
 *  - No WebSocket — polling is simpler and adequate for 5-min candles
 *    (a future v2 can switch to user-fills WS for sub-second latency)
 */

import type { PositionState } from "../types";
import type { LiveEngineState, PendingOrder } from "./liveState";
import { applyFill } from "./liveExecutor";
import { recordFill } from "./liveLedger";

export interface OrderStatus {
  clientOrderId: string;
  status: "OPEN" | "FILLED" | "CANCELLED" | "EXPIRED" | "UNKNOWN";
  filledSize: number;
  avgFillPrice: number;
}

export type OrderLookup = (clientOrderId: string) => Promise<OrderStatus | null>;

/** Emit a fill row to the live ledger. No-op if engine context isn't passed
 *  (back-compat for tests + early callers that don't tag the engine). */
function emitLedger(
  opts: ReconcileOptions,
  order: PendingOrder,
  deltaSize: number,
  fillPrice: number,
  positionSide: "YES" | "NO",
  clientOrderId: string,
): void {
  if (!opts.engineId || !opts.coin || !opts.arenaInstanceId) return;
  recordFill({
    engineId: opts.engineId,
    coin: opts.coin,
    arenaInstanceId: opts.arenaInstanceId,
    tokenId: order.tokenId,
    positionSide,
    side: order.side,
    size: deltaSize,
    limitPrice: order.price,
    fillPrice,
    cost: deltaSize * fillPrice,
    clientOrderId,
  });
}

export interface ReconcileResult {
  checked: number;
  filled: number;
  partialFills: number;
  cancelled: number;
  released: number; // total cash released from cancels/expirations
  errors: string[];
}

export interface ReconcileOptions {
  /**
   * Positional side map: token ID → YES/NO. Needed because pendingOrders don't
   * store the side directly (they're keyed by clientOrderId, not by market).
   * The caller (liveArena) maintains this map from the active market's token IDs.
   */
  tokenSideLookup?: (tokenId: string) => "YES" | "NO";
  /** Skip orders younger than this (let them breathe before polling) */
  minAgeMs?: number;
  /** Engine id, coin, arena — passed through to ledger emission on each fill */
  engineId?: string;
  coin?: string;
  arenaInstanceId?: string;
}

/**
 * Reconcile all pending orders in a single live state.
 * Mutates state in place for any orders that changed.
 */
export async function reconcilePending(
  state: LiveEngineState,
  getOrder: OrderLookup,
  opts: ReconcileOptions = {},
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    checked: 0,
    filled: 0,
    partialFills: 0,
    cancelled: 0,
    released: 0,
    errors: [],
  };

  const now = Date.now();
  const minAge = opts.minAgeMs ?? 2_000;

  // Snapshot the Map since we'll mutate during iteration
  const pending: [string, PendingOrder][] = [...state.pendingOrders];

  for (const [clientOrderId, order] of pending) {
    if (now - order.postedAt < minAge) continue;

    result.checked++;

    let status: OrderStatus | null;
    try {
      status = await getOrder(clientOrderId);
    } catch (err) {
      result.errors.push(`${clientOrderId}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    if (!status || status.status === "UNKNOWN") continue;

    if (status.status === "FILLED" || status.filledSize >= order.size) {
      // Full fill — apply the remaining delta if any
      const deltaSize = status.filledSize - order.filledSize;
      if (deltaSize > 0) {
        const side = opts.tokenSideLookup ? opts.tokenSideLookup(order.tokenId) : "YES";
        applyFill(
          state,
          { side: order.side, tokenId: order.tokenId, price: order.price, size: deltaSize },
          { filledSize: deltaSize, avgFillPrice: status.avgFillPrice },
          side,
        );
        emitLedger(opts, order, deltaSize, status.avgFillPrice, side, clientOrderId);
      }
      state.pendingOrders.delete(clientOrderId);
      result.filled++;
      continue;
    }

    if (status.status === "CANCELLED" || status.status === "EXPIRED") {
      // Release the reserved cash for the unfilled portion
      const unfilledSize = order.size - status.filledSize;
      if (order.side === "BUY" && unfilledSize > 0) {
        const released = unfilledSize * order.price;
        state.cashBalance += released;
        result.released += released;
      }
      // Apply any partial fill that did happen before cancel
      const deltaSize = status.filledSize - order.filledSize;
      if (deltaSize > 0) {
        const side = opts.tokenSideLookup ? opts.tokenSideLookup(order.tokenId) : "YES";
        applyFill(
          state,
          { side: order.side, tokenId: order.tokenId, price: order.price, size: deltaSize },
          { filledSize: deltaSize, avgFillPrice: status.avgFillPrice },
          side,
        );
        emitLedger(opts, order, deltaSize, status.avgFillPrice, side, clientOrderId);
      }
      state.pendingOrders.delete(clientOrderId);
      result.cancelled++;
      continue;
    }

    // Partial fill: update the pending order but keep it
    if (status.filledSize > order.filledSize) {
      const deltaSize = status.filledSize - order.filledSize;
      const side = opts.tokenSideLookup ? opts.tokenSideLookup(order.tokenId) : "YES";
      applyFill(
        state,
        { side: order.side, tokenId: order.tokenId, price: order.price, size: deltaSize },
        { filledSize: deltaSize, avgFillPrice: status.avgFillPrice },
        side,
      );
      emitLedger(opts, order, deltaSize, status.avgFillPrice, side, clientOrderId);
      order.filledSize = status.filledSize;
      result.partialFills++;
    }
  }

  state.lastReconcileAt = now;
  return result;
}

/**
 * Build an OrderLookup backed by a real CLOB client.
 * Maps the client's getOrder response to our OrderStatus type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildClobLookup(client: any): OrderLookup {
  return async (clientOrderId: string): Promise<OrderStatus | null> => {
    try {
      const resp = await client.getOrder(clientOrderId);
      if (!resp) return null;
      const status = resp.status === "LIVE" ? "OPEN" :
        resp.status === "MATCHED" ? "FILLED" :
        resp.status === "CANCELED" ? "CANCELLED" :
        resp.status === "EXPIRED" ? "EXPIRED" : "UNKNOWN";
      return {
        clientOrderId,
        status,
        filledSize: Number(resp.size_matched ?? 0),
        avgFillPrice: Number(resp.price ?? 0),
      };
    } catch (err) {
      // Order not found — probably cancelled and cleaned up
      return { clientOrderId, status: "UNKNOWN", filledSize: 0, avgFillPrice: 0 };
    }
  };
}
