import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Rotation Fader — exploits the post-rotation initial-panic window.
 *
 * When a new 5-minute market opens, the PM book often reflects whatever
 * micro-move was happening at rotation time (e.g. a 5bps BTC tick makes UP
 * open at 0.58, or DOWN at 0.40). Over the next minute these tend to drift
 * back toward 0.50 because the strike is fresh and 5 minutes is a long
 * time at the scale of a single tick.
 *
 * Strategy: in the first 20 seconds of a new candle, if the book has
 * already moved ≥6¢ away from 0.50 in either direction, fade that move —
 * buy the far side. Exit when price returns within 3¢ of 0.50, or hold
 * to settlement if it resolves the "wrong" way.
 *
 * Different from mean-revert-v2 because:
 *   - Fires ONLY in the first 20s of a new candle (narrow window)
 *   - Uses window-start time, not cumulative book deviation
 *   - Exits at 3¢ from 0.50, not 2¢ — wider exit for faster cycling
 */
export class RotationFadeEngine extends AbstractEngine {
  id = "rotation-fade-v1";
  name = "Rotation Fader";
  version = "1.0.0";

  private readonly entryWindowSec = 20;
  private readonly entryDeviation = 0.06;  // ≥6¢ from 0.50
  private readonly exitDeviation = 0.03;   // exit within 3¢ of 0.50
  private readonly maxCashPct = 0.20;
  private readonly minEdgeAfterFee = 0.005;

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();

    const upBook = getBookForToken(upTokenId);
    const downBook = getBookForToken(downTokenId);
    const upBid = upBook.bids[0]?.price ?? 0;
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downBid = downBook.bids[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    const upMid = (upBid + upAsk) / 2;
    const deviation = upMid - 0.50;
    const absDev = Math.abs(deviation);

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    const hasPosition = (upPos && upPos.shares > 0) || (downPos && downPos.shares > 0);

    // ── Exit logic ──
    if (hasPosition) {
      if (absDev < this.exitDeviation) {
        const actions: EngineAction[] = [];
        if (upPos && upPos.shares > 0) {
          actions.push(this.sell(upTokenId, upBid, upPos.shares, {
            orderType: "taker",
            note: `fade exit UP dev=${deviation.toFixed(3)}`,
            signalSource: "rotation_fade_exit",
          }));
        }
        if (downPos && downPos.shares > 0) {
          actions.push(this.sell(downTokenId, downBid, downPos.shares, {
            orderType: "taker",
            note: `fade exit DOWN dev=${deviation.toFixed(3)}`,
            signalSource: "rotation_fade_exit",
          }));
        }
        return actions;
      }
      return []; // hold, wait for reversion or settlement
    }

    // ── Entry logic ──
    if (this.hasPendingOrder()) return [];

    // Only in the first 20 seconds of the candle
    const windowStart = this.getWindowStart();
    if (!windowStart) return [];
    const secsIntoWindow = (Date.now() - windowStart) / 1000;
    if (secsIntoWindow < 0 || secsIntoWindow > this.entryWindowSec) return [];

    // Must be ≥6¢ from 0.50
    if (absDev < this.entryDeviation) return [];

    // Fade: if UP is above 0.50 (market thinks UP likely) buy DOWN instead
    const buyDown = deviation > 0;
    const tokenId = buyDown ? downTokenId : upTokenId;
    const askPrice = buyDown ? downAsk : upAsk;

    const edge = this.feeAdjustedEdge(0.50, askPrice);
    if (!edge.profitable || edge.netEdge < this.minEdgeAfterFee) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / askPrice);
    if (shares < 5) return [];

    this.markPending(tokenId);
    return [this.buy(tokenId, askPrice, shares, {
      orderType: "taker",
      note: `rotation fade ${buyDown ? "DOWN" : "UP"}: dev=${deviation.toFixed(3)}, t+${secsIntoWindow.toFixed(0)}s`,
      signalSource: "rotation_fade_entry",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
