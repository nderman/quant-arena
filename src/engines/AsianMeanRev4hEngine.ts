import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Asian-session mean reversion on 4h candles.
 *
 * Asian trading hours (UTC 00-08) have lower volume and weaker directional
 * conviction than US/Euro sessions. Mean reversion is structurally stronger
 * during these hours because:
 *   - Fewer macro-driven trades
 *   - Less HF / institutional flow
 *   - More retail noise that mean-reverts
 *
 * Strategy: during Asian-hours 4h candles, when 1h preceding return shows
 * meaningful directional move, bet on reversion.
 *
 * Gates:
 *   - 4h arenas only
 *   - Candle start is in UTC hours [0, 8)
 *   - 1h preceding return ≥ MIN_PRECEDING_BPS (default 30)
 *   - Alpha-zone entry [0.40, 0.70]
 *   - ≥ 2h remaining
 */
export class AsianMeanRev4hEngine extends AbstractEngine {
  id = "asian-mean-rev-4h-v1";
  name = "Asian Session Mean Rev 4h";
  version = "1.0.0";

  private readonly minPrecedingBps =
    Number(process.env.ASIAN_MIN_PRECEDING_BPS) || 30;
  private readonly minRemainingSec =
    Number(process.env.ASIAN_MIN_REMAINING_SEC) || 7200;
  private readonly maxCashPct = 0.20;

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

    // Asian session gate: candle started during UTC hours 0-7 (inclusive).
    // We use the candle START hour, not "now", so a candle that started at
    // UTC 06 still counts as Asian even if we're firing on it later.
    const windowStart = this.getWindowStart();
    if (windowStart <= 0) return [];
    const startHour = new Date(windowStart).getUTCHours();
    if (startHour < 0 || startHour > 7) return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    const remaining = this.getSecondsRemaining();
    if (remaining < this.minRemainingSec) return [];

    // 1h preceding return as the mean-rev trigger
    const precedingReturn = this.recentMomentum(3600);
    const precedingBps = Math.abs(precedingReturn) * 10000;
    if (precedingBps < this.minPrecedingBps) return [];

    // Mean rev: rising 1h → bet DOWN. Falling 1h → bet UP.
    const buyUp = precedingReturn < 0;
    const tokenId = buyUp ? upTokenId : downTokenId;
    const book = this.getBookForToken(tokenId);
    if (!this.isBookTradeable(book)) return [];
    const ask = book.asks[0]?.price ?? 0;
    if (ask < 0.40 || ask > 0.70) return [];

    const edge = this.feeAdjustedEdge(0.60, ask);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / ask);
    if (shares < 5) return [];

    this.markPending(tokenId);
    return [
      this.buy(tokenId, ask, shares, {
        orderType: "taker",
        note: `asian-mean-rev: ${buyUp ? "UP" : "DOWN"} @ ${ask.toFixed(3)} preceding=${(precedingReturn * 10000).toFixed(0)}bps utc${startHour.toString().padStart(2,"0")}`,
        signalSource: "asian_mean_rev_4h",
      }),
    ];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
