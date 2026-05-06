import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

export class FadeV3Engine extends AbstractEngine {
  id = "fade-v3";
  name = "Fade & Hold";
  version = "3.0.0";

  // ── Entry: same as fy47 but only cheap tokens ──
  private readonly maxEntryPrice = 0.15;
  private readonly makerBias = 0.70;
  private readonly counterMomentumThreshold = 0.004;

  // ── Bankroll: size from starting cash, not current ──
  private readonly positionSize = 10;             // fixed $10 per entry (from $50 start)

  // ── Per-candle limits ──
  private readonly maxEntriesPerCandle = 3;       // max 3 entries per 5-min candle
  private readonly profitLockThreshold = 20;      // $20 realized → stop trading this candle

  // ── Tracking ──
  private lastBinanceMid = 0;
  private binanceMomentum = 0;
  private consecutiveStrongMoves = 0;
  private lastMarketTokens = "";
  private candleEntries = 0;
  private candleRealizedPnl = 0;
  private candleLocked = false;

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    if (tick.source === "binance") {
      if (this.lastBinanceMid > 0) {
        const newMomentum = (tick.midPrice - this.lastBinanceMid) / this.lastBinanceMid;
        if (Math.abs(newMomentum) > 0.005) {
          this.consecutiveStrongMoves++;
        } else {
          this.consecutiveStrongMoves = 0;
        }
        this.binanceMomentum = newMomentum;
      }
      this.lastBinanceMid = tick.midPrice;
      return [];
    }

    if (tick.source !== "polymarket") return [];

    const mid = tick.midPrice;
    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();

    // Detect candle rotation — reset per-candle state
    const currentTokens = `${upTokenId}:${downTokenId}`;
    if (currentTokens !== this.lastMarketTokens) {
      this.candleEntries = 0;
      this.candleRealizedPnl = 0;
      this.candleLocked = false;
      this.lastMarketTokens = currentTokens;
    }

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    const hasPosition = (upPos && upPos.shares > 0) || (downPos && downPos.shares > 0);

    // ── Exit: only on stop-loss. Otherwise HOLD TO SETTLEMENT. ──
    if (hasPosition) {
      const activePos = upPos && upPos.shares > 0 ? upPos : downPos;
      const activeTokenId = upPos && upPos.shares > 0 ? upTokenId : downTokenId;
      const currentPrice = upPos && upPos.shares > 0 ? mid : (1 - mid);

      // HOLD. No stop-loss. Let settlement resolve at $1 or $0.
      // Max loss is capped by fixed position size ($10 per entry).
      return [];
    }

    // ── Entry logic ──

    if (this.candleLocked) return [];
    if (this.candleEntries >= this.maxEntriesPerCandle) return [];

    // Don't enter in last 30 seconds — too close to settlement
    const secsLeft = this.getSecondsRemaining();
    if (secsLeft >= 0 && secsLeft < 30) return [];

    const absMomentum = Math.abs(this.binanceMomentum);
    if (absMomentum < this.counterMomentumThreshold) return [];

    const detectedActivity = this.consecutiveStrongMoves >= 2 && absMomentum > 0.006;
    const momentumExtreme = absMomentum > 0.008;
    if (!detectedActivity && !momentumExtreme) return [];

    // Only buy cheap tokens
    const upPrice = mid;
    const downPrice = 1 - mid;
    const useMaker = Math.random() < this.makerBias;

    // Fixed position size from starting cash, not current
    const size = this.positionSize;

    if (upPrice <= this.maxEntryPrice && this.binanceMomentum < 0) {
      const modelProb = upPrice + 0.025;
      const edge = this.feeAdjustedEdge(modelProb, upPrice);
      if (!edge.profitable) return [];

      this.candleEntries++;
      if (this.candleRealizedPnl >= this.profitLockThreshold) this.candleLocked = true;

      if (useMaker) {
        const limitPrice = tick.bestBid + 0.001;
        const shares = Math.floor(size / limitPrice);
        if (shares < 5) return [];
        return [this.buy(upTokenId, limitPrice, shares, {
          orderType: "maker",
          note: `Fade&Hold UP: maker ${(limitPrice * 100).toFixed(1)}%, entry #${this.candleEntries}, hold to settle`,
          signalSource: "fade_hold_maker"
        })];
      } else {
        const shares = Math.floor(size / tick.bestAsk);
        if (shares < 5) return [];
        return [this.buy(upTokenId, tick.bestAsk, shares, {
          note: `Fade&Hold UP: taker ${(tick.bestAsk * 100).toFixed(1)}%, entry #${this.candleEntries}, hold to settle`,
          signalSource: "fade_hold_taker"
        })];
      }
    }

    if (downPrice <= this.maxEntryPrice && this.binanceMomentum > 0) {
      const modelProb = downPrice + 0.025;
      const edge = this.feeAdjustedEdge(modelProb, downPrice);
      if (!edge.profitable) return [];

      this.candleEntries++;
      if (this.candleRealizedPnl >= this.profitLockThreshold) this.candleLocked = true;

      if (useMaker) {
        const limitPrice = (1 - tick.bestAsk) + 0.001;
        const shares = Math.floor(size / limitPrice);
        if (shares < 5) return [];
        return [this.buy(downTokenId, limitPrice, shares, {
          orderType: "maker",
          note: `Fade&Hold DOWN: maker ${(limitPrice * 100).toFixed(1)}%, entry #${this.candleEntries}, hold to settle`,
          signalSource: "fade_hold_maker"
        })];
      } else {
        const downAsk = 1 - tick.bestBid;
        const shares = Math.floor(size / downAsk);
        if (shares < 5) return [];
        return [this.buy(downTokenId, downAsk, shares, {
          note: `Fade&Hold DOWN: taker ${(downAsk * 100).toFixed(1)}%, entry #${this.candleEntries}, hold to settle`,
          signalSource: "fade_hold_taker"
        })];
      }
    }

    return [];
  }

  onRoundEnd(_state: EngineState): void {
    this.lastBinanceMid = 0;
    this.binanceMomentum = 0;
    this.consecutiveStrongMoves = 0;
    this.lastMarketTokens = "";
    this.candleEntries = 0;
    this.candleRealizedPnl = 0;
    this.candleLocked = false;
  }
}
