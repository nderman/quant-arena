/**
 * Late Sniper Engine
 *
 * Strategy: Wait until PM price reaches an extreme (>0.85 or <0.15),
 * confirming the candle direction is "locked in", then buy the winning
 * side for the $1.00 resolution payout.
 *
 * Key insight: At >0.85, the fee is only 0.92% (vs 1.8% at 0.50).
 * If the outcome holds, you profit (1.00 - 0.85 - fee) = ~$0.14/share.
 * If it flips, you lose the whole entry. So we need high conviction.
 *
 * Conviction signal: PM price has been on the same side (>0.50 or <0.50)
 * for at least N consecutive PM ticks. This filters out noise spikes.
 *
 * Exit: HOLD to resolution — the whole point is the $1.00 payout.
 * Only emergency exit if price crosses back through 0.50 (direction flipped).
 */

import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

export class LateSniperEngine extends AbstractEngine {
  id = "late-sniper-v1";
  name = "Late Sniper";
  version = "1.0.0";

  // Direction tracking
  private consecutiveSameSide = 0;
  private lastSide: "UP" | "DOWN" | null = null;
  private pmTickCount = 0;

  // Entry params
  private readonly entryThreshold = 0.82;    // PM price must be > this (or < 1-this) to enter
  private readonly minConsecutive = 8;        // need 8+ ticks on same side for conviction
  private readonly maxPositionPct = 0.40;     // risk 40% — high conviction, concentrated bet
  private readonly emergencyExitLevel = 0.45; // if we hold UP and price drops below this, bail

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    const tokenId = state.activeTokenId;
    if (!tokenId) return [];

    if (tick.source !== "polymarket") return [];

    const price = tick.midPrice;
    this.pmTickCount++;

    // ── Track direction conviction ──
    const currentSide: "UP" | "DOWN" = price >= 0.50 ? "UP" : "DOWN";
    if (currentSide === this.lastSide) {
      this.consecutiveSameSide++;
    } else {
      this.consecutiveSameSide = 1;
      this.lastSide = currentSide;
    }

    const pos = this.getPosition(tokenId);

    // ── Exit logic: emergency bail if direction flipped ──
    if (pos && pos.shares > 0) {
      // We hold UP tokens. If price drops below emergency level, cut loss.
      if (price < this.emergencyExitLevel) {
        const exit = this.cheapestExit(price, pos.shares);
        if (exit.method === "MERGE") {
          return [this.merge(tokenId, pos.shares, {
            note: `emergency: price=${price.toFixed(3)} < ${this.emergencyExitLevel}`,
            signalSource: "late_sniper_emergency",
          })];
        }
        return [this.sell(tokenId, tick.bestBid, pos.shares, {
          note: `emergency: price=${price.toFixed(3)} flipped`,
          signalSource: "late_sniper_emergency",
        })];
      }

      // Otherwise HOLD — waiting for resolution payout
      return [];
    }

    // ── Entry logic ──

    // Need conviction: same side for enough ticks
    if (this.consecutiveSameSide < this.minConsecutive) return [];

    // Need extreme price
    const isUpEntry = price >= this.entryThreshold;
    const isDownEntry = price <= (1 - this.entryThreshold);

    if (!isUpEntry && !isDownEntry) return [];

    // We can only buy UP tokens currently
    if (!isUpEntry) return [];

    // Fee check — at 0.85, fee is ~0.92%
    // Expected profit if holds: (1.00 - price - fee%) per share
    const edge = this.feeAdjustedEdge(0.95, price); // model says 95% chance it holds
    if (!edge.profitable) return [];

    const expectedProfit = (1.0 - price) - edge.feeAtPrice;
    if (expectedProfit < 0.05) return []; // need at least 5c/share expected

    // Size — concentrated bet
    const maxUsd = state.cashBalance * this.maxPositionPct;
    const shares = Math.floor(maxUsd / tick.bestAsk);
    if (shares < 5) return [];

    return [this.buy(tokenId, tick.bestAsk, shares, {
      note: `late snipe: price=${price.toFixed(3)}, consec=${this.consecutiveSameSide}, exp_profit=$${(expectedProfit * shares).toFixed(2)}`,
      signalSource: "late_sniper_entry",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.consecutiveSameSide = 0;
    this.lastSide = null;
    this.pmTickCount = 0;
  }
}
