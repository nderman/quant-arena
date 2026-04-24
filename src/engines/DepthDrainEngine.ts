import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Tracks best-bid depth over time on each side's book. When the bid is
 * rapidly DRAINED (depth dropping faster than normal), someone is eating
 * the bid — a sell pressure signal. Contra-trade it at maker price if
 * the drain is large enough.
 *
 * Thesis:
 *   - If UP's best bid drains ≥ 60% of its peak in last 30s → sellers are
 *     hitting UP's bid = UP is weakening = fade UP (buy DOWN maker).
 *   - Mirror logic for DOWN.
 *
 * Teaches the breeder to maintain a rolling window of book state, not just
 * read instant snapshots. depthAtBestBid() is a stateless read; turning it
 * into a drain signal requires per-tick memory.
 */
export class DepthDrainEngine extends AbstractEngine {
  id = "depth-drain-v1";
  name = "Depth Drain";
  version = "1.0.0";

  private readonly windowSec = 30;
  private readonly drainThreshold = 0.60; // 60% drop from peak
  private readonly minPeakShares = 200;   // skip thin books
  private readonly entryMin = 0.30;
  private readonly entryMax = 0.60;
  private readonly maxCashPct = 0.15;

  // Per-token rolling history of (timestamp, depth) samples
  private upHistory: { t: number; depth: number }[] = [];
  private downHistory: { t: number; depth: number }[] = [];

  private record(history: { t: number; depth: number }[], depth: number, now: number): void {
    history.push({ t: now, depth });
    const cutoff = now - this.windowSec * 1000;
    while (history.length > 0 && history[0].t < cutoff) history.shift();
  }

  private peakInWindow(history: { t: number; depth: number }[]): number {
    let peak = 0;
    for (const h of history) if (h.depth > peak) peak = h.depth;
    return peak;
  }

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];

    // Sample depths every tick (arrive at ~5-10 Hz during active candle)
    const now = Date.now();
    this.record(this.upHistory, this.depthAtBestBid(upTokenId), now);
    this.record(this.downHistory, this.depthAtBestBid(downTokenId), now);

    // Need position-free state to enter
    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    // Identify which side (if any) is draining
    const upPeak = this.peakInWindow(this.upHistory);
    const downPeak = this.peakInWindow(this.downHistory);
    const upCurrent = this.upHistory[this.upHistory.length - 1]?.depth ?? 0;
    const downCurrent = this.downHistory[this.downHistory.length - 1]?.depth ?? 0;

    const upDraining = upPeak >= this.minPeakShares && upCurrent < upPeak * (1 - this.drainThreshold);
    const downDraining = downPeak >= this.minPeakShares && downCurrent < downPeak * (1 - this.drainThreshold);

    // If UP is being drained, sellers hitting UP = UP weakens = buy DOWN.
    // If DOWN is being drained, buy UP. If both or neither, skip.
    let targetSide: "UP" | "DOWN" | null = null;
    if (upDraining && !downDraining) targetSide = "DOWN";
    else if (downDraining && !upDraining) targetSide = "UP";
    if (!targetSide) return [];

    const targetTokenId = targetSide === "UP" ? upTokenId : downTokenId;
    const book = this.getBookForToken(targetTokenId);
    if (!this.isBookTradeable(book)) return [];
    const askPrice = book.asks[0]?.price ?? 0;
    if (askPrice < this.entryMin || askPrice > this.entryMax) return [];

    const edge = this.feeAdjustedEdge(0.62, askPrice);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / askPrice);
    if (shares < 5) return [];

    const makerPrice = Math.round((askPrice - 0.015) * 1000) / 1000;
    this.markPending(targetTokenId);
    if (makerPrice >= askPrice) {
      return [this.buy(targetTokenId, askPrice, shares, {
        orderType: "taker",
        note: `depth-drain: ${targetSide} (other side draining) @ ${askPrice.toFixed(3)}`,
        signalSource: "depth_drain",
      })];
    }
    return [this.buy(targetTokenId, makerPrice, shares, {
      orderType: "maker",
      note: `depth-drain: ${targetSide} maker @ ${makerPrice.toFixed(3)}`,
      signalSource: "depth_drain",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.upHistory = [];
    this.downHistory = [];
  }
}
