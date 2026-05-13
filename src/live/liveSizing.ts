/**
 * LiveSizingWrapper — scales sim EngineActions to live bankroll.
 *
 * The sim gives each engine $50 starting cash per round. Live has a single
 * bankroll that's typically much larger (e.g. $500-$5000) and shared across
 * candles. This module translates a sim action into a properly-sized live
 * action without the engine needing to know which mode it's running in.
 *
 * Rules:
 *  1. Scale shares proportionally to bankroll ratio (live/sim)
 *  2. Cap each order at MAX_POSITION_PCT of live bankroll
 *  3. Cap total in-flight exposure at MAX_CANDLE_EXPOSURE_PCT
 *  4. Clip to available cash
 *  5. Floor to MIN_ORDER_USD (reject if below)
 *  6. Preserve limit price exactly (edge depends on it)
 *
 * Pure function — no I/O, no side effects, easy to test.
 */

import { CONFIG } from "../config";
import type { EngineAction } from "../types";
import type { LiveEngineState } from "./liveState";
import { RISK_CONFIG } from "./riskManager";

export interface SizingResult {
  action: EngineAction | null;
  reason?: string;
  originalUsd: number;
  scaledUsd: number;
  clippedBy?: "bankroll_cap" | "cash" | "exposure_cap" | "min_order" | "rounding" | "maker_min_bump" | "marketable_min_bump";
}

export interface SizingConfig {
  /** Live bankroll in USD (shared across the engine's positions) */
  liveBankrollUsd: number;
  /** Sim bankroll — the number the engine was designed around (usually $50) */
  simBankrollUsd: number;
  /** Max total exposure as % of bankroll across a single candle (default 60%) */
  maxCandleExposurePct?: number;
  /** Current exposure in the candle (sum of in-flight + filled cost basis) */
  currentCandleExposureUsd?: number;
}

/**
 * Translate a sim engine action into a live-sized action.
 *
 * Returns a SizingResult with either a sized action or null + reason.
 * Caller should route to CLOB (or dryRunAdapter) only if action is non-null.
 */
export function sizeForLive(
  simAction: EngineAction,
  liveState: LiveEngineState,
  cfg: SizingConfig,
): SizingResult {
  const originalUsd = simAction.size * simAction.price;

  // Only BUY/SELL get sized — HOLD/MERGE pass through unchanged
  if (simAction.side !== "BUY" && simAction.side !== "SELL") {
    return { action: simAction, originalUsd, scaledUsd: originalUsd };
  }

  if (simAction.price <= 0) {
    return { action: null, reason: "invalid price <= 0", originalUsd, scaledUsd: 0 };
  }

  // 1. Scale proportionally to bankroll ratio
  const scaleRatio = cfg.liveBankrollUsd / cfg.simBankrollUsd;
  let targetUsd = originalUsd * scaleRatio;

  // 2. Per-order cap (risk manager also enforces this, but we clip here
  //    to avoid round-trip-rejections). Take the MIN of (PCT × bankroll) and
  //    (flat $$ ceiling) — flat ceiling protects against adverse-fill
  //    selection at larger sizes regardless of bankroll growth.
  const pctCapUsd = cfg.liveBankrollUsd * RISK_CONFIG.MAX_POSITION_PCT;
  const maxOrderUsd = Math.min(pctCapUsd, RISK_CONFIG.MAX_LIVE_TRADE_USD);
  let clippedBy: SizingResult["clippedBy"];
  if (targetUsd > maxOrderUsd) {
    targetUsd = maxOrderUsd;
    clippedBy = "bankroll_cap";
  }

  // 3. Per-candle exposure cap (shared budget across DCA entries)
  const exposureCap = cfg.liveBankrollUsd * (cfg.maxCandleExposurePct ?? RISK_CONFIG.MAX_CANDLE_EXPOSURE_PCT);
  const currentExposure = cfg.currentCandleExposureUsd ?? 0;
  const remainingExposure = Math.max(0, exposureCap - currentExposure);
  if (simAction.side === "BUY" && targetUsd > remainingExposure) {
    targetUsd = remainingExposure;
    clippedBy = "exposure_cap";
  }

  // 4. Cash availability (BUY only)
  if (simAction.side === "BUY" && targetUsd > liveState.cashBalance) {
    targetUsd = liveState.cashBalance;
    clippedBy = "cash";
  }

  // 5. For SELL, we can't scale up beyond what we actually hold
  if (simAction.side === "SELL") {
    const pos = liveState.positions.get(simAction.tokenId);
    if (!pos || pos.shares <= 0) {
      return { action: null, reason: "SELL with no position", originalUsd, scaledUsd: 0 };
    }
    const maxSellUsd = pos.shares * simAction.price;
    if (targetUsd > maxSellUsd) {
      targetUsd = maxSellUsd;
      clippedBy = "cash";
    }
  }

  // Round to whole shares — PM CLOB doesn't accept fractional
  let newSize = Math.floor(targetUsd / simAction.price);
  if (newSize <= 0) {
    return {
      action: null,
      reason: `sized to ${newSize} shares after rounding`,
      originalUsd,
      scaledUsd: targetUsd,
      clippedBy: "rounding",
    };
  }

  // 6. Maker-minimum bump: PM rejects resting orders < MIN_ORDER_SHARES.
  // Run BEFORE the notional floor so that a sub-min order that bumps to
  // 5 shares satisfies both checks. Taker orders crossing the book bypass
  // the share rule, but we can't tell at sizing time whether the book will
  // be crossed — safe default is to bump if cash + exposure allow.
  if (newSize < RISK_CONFIG.MIN_ORDER_SHARES && simAction.side === "BUY") {
    const neededUsd = RISK_CONFIG.MIN_ORDER_SHARES * simAction.price;
    if (neededUsd <= liveState.cashBalance && neededUsd <= remainingExposure) {
      newSize = RISK_CONFIG.MIN_ORDER_SHARES;
      clippedBy = "maker_min_bump";
    } else {
      return {
        action: null,
        reason: `cannot meet ${RISK_CONFIG.MIN_ORDER_SHARES}-share maker min: need $${neededUsd.toFixed(2)}, cash=$${liveState.cashBalance.toFixed(2)}, exposure_remaining=$${remainingExposure.toFixed(2)}`,
        originalUsd,
        scaledUsd: newSize * simAction.price,
        clippedBy: "min_order",
      };
    }
  }

  // 6a. Price-zone gate (2026-05-11). Live data showed taker BUYs outside
  // the alpha zone (default 0.55-0.70) lose 70-100% under OUR engines.
  // 2026-05-13 update: LIVE_SIZING_OVERRIDE_ZONE_GATE bypasses the gate
  // here — whale data (Marketing101) shows tail entries can be profitable
  // with the right signal/timing. Referee.ts still enforces the gate in
  // sim so sim PnL stays honest per empirical calibration; live now lets
  // orders flow through so engines can test their own tail-selection edge.
  const isMaker = simAction.orderType === "maker";
  if (!isMaker && simAction.side === "BUY"
      && CONFIG.LIVE_PRICE_ZONE_ENABLED
      && !CONFIG.LIVE_SIZING_OVERRIDE_ZONE_GATE) {
    if (simAction.price < CONFIG.LIVE_PRICE_ZONE_MIN || simAction.price > CONFIG.LIVE_PRICE_ZONE_MAX) {
      return {
        action: null,
        reason: `taker BUY @ $${simAction.price.toFixed(3)} outside alpha zone [${CONFIG.LIVE_PRICE_ZONE_MIN}, ${CONFIG.LIVE_PRICE_ZONE_MAX}]`,
        originalUsd,
        scaledUsd: 0,
        clippedBy: "min_order",
      };
    }
  }

  // 6b. Marketable BUY $1 minimum bump. Real PM CLOB rejects taker BUYs
  // (orderType="taker" or unspecified) with notional < $1. After the share
  // bump above we may still be under $1 (e.g. 5 sh × $0.16 = $0.80). Bump
  // shares further if budget permits; reject if not. Makers (resting
  // limits below the ask) are exempt — same rule as the sim referee.
  if (!isMaker && simAction.side === "BUY") {
    const currentNotional = newSize * simAction.price;
    if (currentNotional < CONFIG.CLOB_MIN_MARKETABLE_BUY_USD && simAction.price > 0) {
      const sharesNeeded = Math.ceil(CONFIG.CLOB_MIN_MARKETABLE_BUY_USD / simAction.price);
      const neededUsd = sharesNeeded * simAction.price;
      if (neededUsd <= liveState.cashBalance && neededUsd <= remainingExposure) {
        newSize = sharesNeeded;
        clippedBy = "marketable_min_bump";
      } else {
        return {
          action: null,
          reason: `cannot meet $${CONFIG.CLOB_MIN_MARKETABLE_BUY_USD} marketable BUY min: need ${sharesNeeded}sh × $${simAction.price.toFixed(3)} = $${neededUsd.toFixed(2)}, cash=$${liveState.cashBalance.toFixed(2)}, exposure_remaining=$${remainingExposure.toFixed(2)}`,
          originalUsd,
          scaledUsd: newSize * simAction.price,
          clippedBy: "min_order",
        };
      }
    }
  }

  const finalUsd = newSize * simAction.price;
  // 7. Minimum notional floor — only enforced on the FINAL sized order.
  // Lowered to $0.50 Apr 25; PM's protocol minimum is share-count (see
  // MIN_ORDER_SHARES), not notional. A 5-share × $0.10 fill = $0.50 is
  // the realistic floor.
  if (finalUsd < RISK_CONFIG.MIN_ORDER_USD) {
    return {
      action: null,
      reason: `final $${finalUsd.toFixed(2)} < min $${RISK_CONFIG.MIN_ORDER_USD}`,
      originalUsd,
      scaledUsd: finalUsd,
      clippedBy: "min_order",
    };
  }
  return {
    action: {
      ...simAction,
      size: newSize,
    },
    originalUsd,
    scaledUsd: finalUsd,
    clippedBy,
  };
}

/**
 * Compute current candle exposure from live state.
 * Sums the cost basis of open positions + pending BUY orders.
 */
export function computeCandleExposure(liveState: LiveEngineState): number {
  let exposure = 0;
  for (const [, pos] of liveState.positions) {
    exposure += pos.costBasis;
  }
  for (const [, order] of liveState.pendingOrders) {
    if (order.side === "BUY") {
      const remaining = order.size - order.filledSize;
      exposure += remaining * order.price;
    }
  }
  return exposure;
}
