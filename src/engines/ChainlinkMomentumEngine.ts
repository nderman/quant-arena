import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Chainlink Momentum — velocity-based cousin of the existing ChainlinkSniper.
 *
 * ChainlinkSniperEngine only fires in the last 60 seconds of a candle when
 * the outcome is essentially decided. This engine fires in the MIDDLE of a
 * candle (30-180 seconds in) when Chainlink price velocity over a rolling
 * 30-second window gives a directional signal.
 *
 * The premise: Chainlink updates are the authoritative oracle. If BTC has
 * moved +15bps in the last 30s, the PM book will reprice over the next
 * 10-20s as takers arb it. Getting there first on the UP side captures
 * the rerate.
 *
 * Why it might work where naive momentum-follower-v1 fails:
 *   - Uses Chainlink (the settlement oracle) instead of Binance mid, so
 *     the signal aligns with the actual resolution source.
 *   - Gates on secsLeft > 60 — never fires in the dying seconds where
 *     ChainlinkSniperEngine lives.
 *   - Requires a minimum velocity (no noise trades).
 *   - Max 1 entry per candle.
 */
export class ChainlinkMomentumEngine extends AbstractEngine {
  id = "chainlink-momentum-v1";
  name = "Chainlink Momentum";
  version = "1.0.0";

  // Time window for velocity measurement
  private readonly velocityWindowSec = 30;
  // Minimum bps movement over the window to fire
  private readonly minVelocityBps = 15;
  // Only fire between these seconds-into-candle
  private readonly minSecsInto = 30;
  private readonly minSecsLeft = 60;
  // PM price gates — must still have upside
  private readonly maxEntryPrice = 0.70;
  private readonly minEntryPrice = 0.30;
  // Sizing
  private readonly maxCashPct = 0.20;

  // Chainlink samples: [timestamp, price]
  private clSamples: Array<[number, number]> = [];
  private candleEntries = 0;
  private readonly maxEntriesPerCandle = 1;

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    // Rotation: reset per-candle state, drop stale chainlink samples
    const rotated = this.updatePendingOrders();
    if (rotated) {
      this.candleEntries = 0;
      this.clSamples = [];
    }

    // Sample chainlink every tick (pulse throttles the underlying fetch)
    const clPrice = this.getChainlinkPrice();
    const now = Date.now();
    if (clPrice !== null && clPrice > 0) {
      this.clSamples.push([now, clPrice]);
      // Keep only samples within the velocity window (+5s buffer)
      const cutoff = now - (this.velocityWindowSec + 5) * 1000;
      while (this.clSamples.length > 0 && this.clSamples[0][0] < cutoff) {
        this.clSamples.shift();
      }
    }

    if (this.hasPendingOrder()) return [];

    if (this.candleEntries >= this.maxEntriesPerCandle) return [];

    // Skip if already holding either side
    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    // Time gates: within "middle" of candle
    const windowStart = this.getWindowStart();
    if (!windowStart) return [];
    const secsIn = (now - windowStart) / 1000;
    const secsLeft = this.getSecondsRemaining();
    if (secsIn < this.minSecsInto) return [];
    if (secsLeft < 0 || secsLeft < this.minSecsLeft) return [];

    // Need at least 2 chainlink samples spanning close to the full window
    if (this.clSamples.length < 2) return [];
    const oldest = this.clSamples[0];
    const newest = this.clSamples[this.clSamples.length - 1];
    const spanSec = (newest[0] - oldest[0]) / 1000;
    if (spanSec < this.velocityWindowSec * 0.7) return [];

    const velocityBps = ((newest[1] - oldest[1]) / oldest[1]) * 10_000;
    if (Math.abs(velocityBps) < this.minVelocityBps) return [];

    // Direction: positive velocity → buy UP, negative → buy DOWN
    const buyUp = velocityBps > 0;

    const upBook = getBookForToken(upTokenId);
    const downBook = getBookForToken(downTokenId);
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    const tokenId = buyUp ? upTokenId : downTokenId;
    const askPrice = buyUp ? upAsk : downAsk;

    if (askPrice < this.minEntryPrice || askPrice > this.maxEntryPrice) return [];

    // Model prob: base 0.50 + 0.20 confidence boost from velocity direction
    const modelProb = 0.50 + 0.20;
    const edge = this.feeAdjustedEdge(modelProb, askPrice);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / askPrice);
    if (shares < 5) return [];

    this.markPending(tokenId);
    this.candleEntries++;

    return [this.buy(tokenId, askPrice, shares, {
      orderType: "taker",
      note: `cl-momentum ${buyUp ? "UP" : "DOWN"}: ${velocityBps.toFixed(1)}bps/${spanSec.toFixed(0)}s, ask=${askPrice.toFixed(3)}`,
      signalSource: "chainlink_momentum",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.clSamples = [];
    this.candleEntries = 0;
  }
}
