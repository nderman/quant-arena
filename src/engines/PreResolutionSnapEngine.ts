import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Pre-resolution snap engine — captures the last-minute lag between
 * Polymarket book pricing and the true Binance close.
 *
 * In the final 60-90 seconds of a 4h candle, slow players (mostly retail)
 * misprice the imminent close. If Binance spot is near the candle's open
 * price (within a few bps), the resolution is essentially a coin flip with
 * a slight directional bias from the current spot vs open delta.
 *
 * We fire a SMALL maker bet on the side that matches `current_spot vs
 * candle_open`. High frequency, tiny edge per fire, catches the snap.
 *
 * Gates:
 *   - 4h arenas only
 *   - Last MIN_REMAINING_SEC ≤ remaining ≤ MAX_REMAINING_SEC (default 30-90s)
 *   - We've captured the candle-start price (recorded at first tick of round)
 *   - Current spot vs open delta within DELTA_BPS (default 25 bps —
 *     close enough that a small directional bias is meaningful)
 *   - Alpha-zone entry [0.40, 0.70]
 */
export class PreResolutionSnapEngine extends AbstractEngine {
  id = "pre-resolution-snap-v1";
  name = "Pre-Resolution Snap";
  version = "1.0.0";

  private readonly minRemainingSec =
    Number(process.env.SNAP_MIN_REMAINING_SEC) || 30;
  private readonly maxRemainingSec =
    Number(process.env.SNAP_MAX_REMAINING_SEC) || 90;
  private readonly maxDeltaBps =
    Number(process.env.SNAP_MAX_DELTA_BPS) || 25;
  private readonly maxCashPct = 0.10;

  // Per-round candle-open Binance price, captured on first tick of the round.
  private candleOpenPrice = 0;
  private capturedForWindow = 0;

  onTick(
    tick: MarketTick,
    state: EngineState,
    _signals?: SignalSnapshot,
  ): EngineAction[] {
    if (tick.source === "binance") this.trackBinance(tick);
    if (tick.source !== "polymarket") return [];

    if (this.candleSeconds() !== 14400) return [];

    this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];
    this.clearStalePositions();

    // Capture candle-open price once per window. Window changes when
    // marketWindowStart changes (arena rotation).
    const windowStart = this.getWindowStart();
    if (windowStart !== this.capturedForWindow) {
      const px = this.lastBinancePrice();
      if (px > 0) {
        this.candleOpenPrice = px;
        this.capturedForWindow = windowStart;
      }
    }
    if (this.candleOpenPrice <= 0) return [];

    const remaining = this.getSecondsRemaining();
    if (remaining < this.minRemainingSec || remaining > this.maxRemainingSec) {
      return [];
    }

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    const currentSpot = this.lastBinancePrice();
    if (currentSpot <= 0) return [];

    const deltaBps = ((currentSpot - this.candleOpenPrice) / this.candleOpenPrice) * 10000;
    // Only fire when delta is small (close-to-flat candle — slight bias matters)
    if (Math.abs(deltaBps) > this.maxDeltaBps) return [];
    // Need SOME bias to bet a direction
    if (Math.abs(deltaBps) < 2) return [];

    const buyUp = deltaBps > 0;
    const tokenId = buyUp ? upTokenId : downTokenId;
    const book = this.getBookForToken(tokenId);
    if (!this.isBookTradeable(book)) return [];
    const ask = book.asks[0]?.price ?? 0;
    if (ask < 0.40 || ask > 0.70) return [];

    const edge = this.feeAdjustedEdge(0.58, ask);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / ask);
    if (shares < 5) return [];

    this.markPending(tokenId);
    return [
      this.buy(tokenId, ask, shares, {
        orderType: "taker",
        note: `pre-res-snap: ${buyUp ? "UP" : "DOWN"} @ ${ask.toFixed(3)} delta=${deltaBps.toFixed(1)}bps remaining=${remaining}s`,
        signalSource: "pre_resolution_snap",
      }),
    ];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.candleOpenPrice = 0;
    this.capturedForWindow = 0;
  }
}
