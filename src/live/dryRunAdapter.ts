/**
 * Dry-run adapter — mock CLOB client that simulates fills without signing.
 *
 * Used by:
 * - Phase 0 smoke tests
 * - LIVE_DRY_RUN=1 mode in liveArena
 * - Local testing without wallet/credentials
 *
 * Behavior: every order is "filled" instantly at the requested price.
 * Tracks orders in memory only. No network calls.
 */

import type { EngineAction } from "../types";

export interface MockOrder {
  clientOrderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  filledSize: number;
  status: "OPEN" | "FILLED" | "CANCELLED";
  postedAt: number;
  filledAt?: number;
}

export interface MockFill {
  clientOrderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  fee: number;
  timestamp: number;
}

let orderCounter = 0;
const orders = new Map<string, MockOrder>();

export function dryRunPlaceOrder(action: EngineAction): MockOrder {
  if (action.side !== "BUY" && action.side !== "SELL") {
    throw new Error(`dryRunPlaceOrder: only BUY/SELL supported, got ${action.side}`);
  }
  const clientOrderId = `dry-${++orderCounter}-${Date.now()}`;
  const order: MockOrder = {
    clientOrderId,
    tokenId: action.tokenId,
    side: action.side,
    price: action.price,
    size: action.size,
    filledSize: action.size, // instant fill
    status: "FILLED",
    postedAt: Date.now(),
    filledAt: Date.now(),
  };
  orders.set(clientOrderId, order);
  console.log(
    `[dryrun] ${order.side} ${order.size}@${order.price.toFixed(4)} → FILLED (id=${clientOrderId.slice(0, 16)})`,
  );
  return order;
}

export function dryRunGetOrder(clientOrderId: string): MockOrder | undefined {
  return orders.get(clientOrderId);
}

export function dryRunCancelOrder(clientOrderId: string): boolean {
  const o = orders.get(clientOrderId);
  if (!o || o.status === "FILLED") return false;
  o.status = "CANCELLED";
  return true;
}

export function dryRunReset(): void {
  orders.clear();
  orderCounter = 0;
}

export function dryRunStats(): { total: number; filled: number; cancelled: number } {
  let filled = 0, cancelled = 0;
  for (const o of orders.values()) {
    if (o.status === "FILLED") filled++;
    if (o.status === "CANCELLED") cancelled++;
  }
  return { total: orders.size, filled, cancelled };
}
