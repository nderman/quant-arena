/**
 * CLOB OrderSubmitter adapter.
 *
 * Translates an EngineAction into a Polymarket CLOB order via createAndPostOrder,
 * returning a SubmitResult that liveExecutor can consume. Mirrors dryRunAdapter's
 * interface exactly so they're drop-in replacements.
 *
 * Partial fills: real CLOB orders sit on the book and fill asynchronously.
 * This adapter returns `filledSize: 0` for non-market orders — the caller
 * (liveExecutor) will track them as pending. A separate reconciliation loop
 * polls for fills later (see #38).
 *
 * For market orders (taker), PM fills immediately — we return filledSize = size.
 * TODO: verify this assumption against real PM behavior; may need to query
 * the resulting trade to get actual fill price.
 */

import type { ClobClient as ClobClientType } from "@polymarket/clob-client";
import type { EngineAction } from "../types";
import type { SubmitResult, OrderSubmitter } from "./liveExecutor";

export interface ClobSubmitterConfig {
  client: ClobClientType;
  /** Default negRisk; fetched per-token if undefined */
  negRisk?: boolean;
  /** Tick size for the order; PM uses "0.01" for 5M markets */
  tickSize?: "0.001" | "0.01" | "0.1";
  /** Timeout in ms for createAndPostOrder before giving up */
  timeoutMs?: number;
}

/**
 * Direction-aware tick alignment for PM CLOB.
 *
 * BUYs round DOWN, SELLs round UP. Rounding the wrong way pushes a maker
 * limit across the book and it executes as a taker — observed Apr 24, where
 * a 0.655 maker BUY got rounded UP to 0.66 and ate the ask.
 *
 * Also clamps to the PM-valid range (min tick .. 1 - min tick) to avoid
 * submitting 0.00 or 1.00 prices.
 */
const TICK_META = {
  "0.1":   { step: 0.1,   decimals: 1, maxAligned: 9 },
  "0.01":  { step: 0.01,  decimals: 2, maxAligned: 99 },
  "0.001": { step: 0.001, decimals: 3, maxAligned: 999 },
} as const;

export function alignTickForSide(
  price: number,
  side: "BUY" | "SELL",
  tickSize: "0.001" | "0.01" | "0.1",
): number {
  const { step, decimals, maxAligned } = TICK_META[tickSize];
  const raw = price / step;
  const aligned = side === "BUY" ? Math.floor(raw) : Math.ceil(raw);
  const clamped = Math.max(1, Math.min(maxAligned, aligned));
  return Number((clamped * step).toFixed(decimals));
}

/**
 * Build an OrderSubmitter backed by a real CLOB client.
 * Returns a function that takes an EngineAction and returns a SubmitResult.
 */
export function buildClobSubmitter(cfg: ClobSubmitterConfig): OrderSubmitter {
  return async (action: EngineAction): Promise<SubmitResult> => {
    if (action.side !== "BUY" && action.side !== "SELL") {
      return { ok: false, reason: `clobSubmitter: unsupported side ${action.side}` };
    }
    if (action.size < 1 || action.price <= 0 || action.price >= 1) {
      return { ok: false, reason: `clobSubmitter: invalid size/price ${action.size}@${action.price}` };
    }

    try {
      // Dynamic import so tests / non-live code don't have to load the SDK
      const { OrderType, Side } = await import("@polymarket/clob-client");

      // Resolve negRisk: config override > per-token lookup > false
      let negRisk = cfg.negRisk;
      if (negRisk === undefined) {
        try {
          negRisk = await cfg.client.getNegRisk(action.tokenId);
        } catch {
          negRisk = false;
        }
      }

      const tickSize = cfg.tickSize ?? "0.01";
      const roundedPrice = alignTickForSide(action.price, action.side, tickSize);

      // PM CLOB only supports GTC for createAndPostOrder. Taker behavior is
      // achieved by submitting a limit that crosses the current book (the
      // engine already passes the market ask price for takers). GTC = sits
      // on the book only if the price doesn't cross.
      const orderType = OrderType.GTC;

      const postPromise = cfg.client.createAndPostOrder(
        {
          tokenID: action.tokenId,
          side: action.side === "BUY" ? Side.BUY : Side.SELL,
          price: roundedPrice,
          size: action.size,
        },
        { tickSize, negRisk },
        orderType,
      );

      // Timeout wrapper
      const timeoutMs = cfg.timeoutMs ?? 10_000;
      const resp = await Promise.race([
        postPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`clobSubmitter: ${timeoutMs}ms timeout`)), timeoutMs),
        ),
      ]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = resp as any;
      if (!r?.success) {
        return { ok: false, reason: `clob reject: ${JSON.stringify(r).slice(0, 200)}` };
      }

      const clientOrderId = r.orderID || r.order?.orderID || "";
      if (!clientOrderId) {
        return { ok: false, reason: "clob: no orderID in response" };
      }

      // For a taker action (engine submitted at market ask), PM usually fills
      // immediately and the response includes the fill info. For maker
      // orders, filledSize is 0 and the reconciliation loop tracks them.
      // We can't reliably distinguish from the response alone; safer to
      // return filledSize=0 and let the reconcile loop confirm fills, unless
      // the response explicitly includes makingAmount/takingAmount fields.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const takingAmount = Number((r as any).takingAmount ?? 0);
      const filledSize = takingAmount > 0 ? Math.floor(takingAmount) : 0;
      const avgFillPrice = roundedPrice;

      return {
        ok: true,
        clientOrderId,
        filledSize,
        avgFillPrice,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `clobSubmitter threw: ${reason}` };
    }
  };
}

/**
 * Cancel a batch of orders by clientOrderId. Returns count successfully
 * cancelled. Used by liveArena on candle rotation to clear stale makers
 * that would otherwise sit on the book after their token expires.
 */
export function buildClobCanceller(cfg: { client: ClobClientType }): (clientOrderIds: string[]) => Promise<number> {
  return async (clientOrderIds: string[]) => {
    if (clientOrderIds.length === 0) return 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await (cfg.client as any).cancelOrders(clientOrderIds);
      // Response shape varies; return input count as best-effort
      return r ? clientOrderIds.length : 0;
    } catch (err) {
      console.warn(`[clob-cancel] error: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  };
}

/**
 * Build an OrderLookup backed by a real CLOB client.
 * Polls the CLOB API for order status by clientOrderId.
 */
export function buildClobLookup(cfg: { client: ClobClientType }): (clientOrderId: string) => Promise<{ status: "FILLED" | "OPEN" | "CANCELLED"; filledSize: number; avgFillPrice: number } | null> {
  return async (clientOrderId: string) => {
    try {
      const order = await cfg.client.getOrder(clientOrderId);
      if (!order) return null;
      const status = order.status === "MATCHED" ? "FILLED" as const
        : order.status === "LIVE" ? "OPEN" as const
        : "CANCELLED" as const;
      return {
        status,
        filledSize: Number(order.size_matched ?? 0),
        avgFillPrice: Number(order.price ?? 0),
      };
    } catch {
      return null;
    }
  };
}
