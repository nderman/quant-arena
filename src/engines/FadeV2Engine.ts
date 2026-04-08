import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

export class FadeV2Engine extends AbstractEngine {
  id = "fade-v2";
  name = "Fade the Weak Hands v3";
  version = "3.0.0";

  // ── Strategy params ──
  private readonly maxEntryPrice = 0.15;           // only buy tokens priced below 15¢
  private readonly makerBias = 0.70;
  private readonly maxPositionPct = 0.20;           // can afford more when buying cheap
  private readonly takeProfitBps = 200;
  private readonly counterMomentumThreshold = 0.004;

  // ── Per-market cooldown ──
  private readonly marketCooldownThreshold = 100;   // $100 realized profit → stop this candle
  private readonly maxWinsPerMarket = 3;

  // ── Tracking state ──
  private lastBinanceMid = 0;
  private binanceMomentum = 0;
  private ticksSinceEntry = 0;
  private entryMomentum = 0;
  private consecutiveStrongMoves = 0;

  // ── Per-market tracking ──
  private marketRealizedPnl = 0;
  private marketWinCount = 0;
  private lastMarketTokens = "";
  private coolingDown = false;

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

    // Detect market rotation — reset per-market state
    const currentTokens = `${upTokenId}:${downTokenId}`;
    if (currentTokens !== this.lastMarketTokens) {
      this.marketRealizedPnl = 0;
      this.marketWinCount = 0;
      this.coolingDown = false;
      this.lastMarketTokens = currentTokens;
    }

    this.ticksSinceEntry++;

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    const hasPosition = (upPos && upPos.shares > 0) || (downPos && downPos.shares > 0);

    // ── Exit logic (always active) ──
    if (hasPosition) {
      const activePos = upPos && upPos.shares > 0 ? upPos : downPos;
      const activeTokenId = upPos && upPos.shares > 0 ? upTokenId : downTokenId;
      const currentPrice = upPos && upPos.shares > 0 ? mid : (1 - mid);

      if (activePos) {
        const unrealizedBps = ((currentPrice - activePos.avgEntry) / activePos.avgEntry) * 10000;
        const exitMethod = this.cheapestExit(currentPrice, activePos.shares, activeTokenId);

        // Take profit
        if (unrealizedBps >= this.takeProfitBps) {
          const realizedPnl = (currentPrice - activePos.avgEntry) * activePos.shares;
          this.marketRealizedPnl += realizedPnl;
          this.marketWinCount++;

          if (this.marketRealizedPnl >= this.marketCooldownThreshold || this.marketWinCount >= this.maxWinsPerMarket) {
            this.coolingDown = true;
          }

          if (exitMethod.method === "MERGE") {
            return [this.merge(activeTokenId, activePos.shares, {
              note: `TP merge: ${unrealizedBps.toFixed(0)}bps, mktPnL=$${this.marketRealizedPnl.toFixed(0)}${this.coolingDown ? " [COOL]" : ""}`,
              signalSource: "fade_tp_merge"
            })];
          } else {
            const exitPrice = upPos && upPos.shares > 0 ? tick.bestBid : (1 - tick.bestAsk);
            return [this.sell(activeTokenId, exitPrice, activePos.shares, {
              note: `TP sell: ${unrealizedBps.toFixed(0)}bps, mktPnL=$${this.marketRealizedPnl.toFixed(0)}${this.coolingDown ? " [COOL]" : ""}`,
              signalSource: "fade_tp_sell"
            })];
          }
        }

        // Reversal exit
        const momentumReversed = (this.entryMomentum > 0 && this.binanceMomentum < -0.002) ||
                                 (this.entryMomentum < 0 && this.binanceMomentum > 0.002);

        if (momentumReversed && this.ticksSinceEntry >= 3) {
          const realizedPnl = (currentPrice - activePos.avgEntry) * activePos.shares;
          this.marketRealizedPnl += realizedPnl;

          if (exitMethod.method === "MERGE") {
            return [this.merge(activeTokenId, activePos.shares, {
              note: `Reversal merge, mktPnL=$${this.marketRealizedPnl.toFixed(0)}`,
              signalSource: "fade_reversal_merge"
            })];
          } else {
            const exitPrice = upPos && upPos.shares > 0 ? tick.bestBid : (1 - tick.bestAsk);
            return [this.sell(activeTokenId, exitPrice, activePos.shares, {
              note: `Reversal sell, mktPnL=$${this.marketRealizedPnl.toFixed(0)}`,
              signalSource: "fade_reversal_sell"
            })];
          }
        }
      }

      return [];
    }

    // ── Entry logic: only buy cheap tokens ──

    if (this.coolingDown) return [];
    if (this.marketWinCount >= this.maxWinsPerMarket) return [];

    // Don't enter in last 60 seconds
    const secsLeft = this.getSecondsRemaining();
    if (secsLeft >= 0 && secsLeft < 60) return [];

    const absMomentum = Math.abs(this.binanceMomentum);
    if (absMomentum < this.counterMomentumThreshold) return [];

    const detectedActivity = this.consecutiveStrongMoves >= 2 && absMomentum > 0.006;
    const momentumExtreme = absMomentum > 0.008;

    if (!detectedActivity && !momentumExtreme) return [];

    // Determine which token is cheap enough to buy
    const upPrice = mid;
    const downPrice = 1 - mid;

    const maxSize = state.cashBalance * this.maxPositionPct;
    const useMaker = Math.random() < this.makerBias;

    // Buy UP token if it's cheap (price is crashing, UP is below 15¢)
    if (upPrice <= this.maxEntryPrice && this.binanceMomentum < 0) {
      const modelProb = upPrice + 0.025;
      const edge = this.feeAdjustedEdge(modelProb, upPrice);
      if (!edge.profitable) return [];

      this.ticksSinceEntry = 0;
      this.entryMomentum = this.binanceMomentum;

      if (useMaker) {
        const limitPrice = tick.bestBid + 0.001;
        const shares = Math.floor(maxSize / limitPrice);
        if (shares < 5) return [];
        return [this.buy(upTokenId, limitPrice, shares, {
          orderType: "maker",
          note: `Cheap UP: maker at ${(limitPrice * 100).toFixed(1)}%`,
          signalSource: "fade_cheap_maker"
        })];
      } else {
        const shares = Math.floor(maxSize / tick.bestAsk);
        if (shares < 5) return [];
        return [this.buy(upTokenId, tick.bestAsk, shares, {
          note: `Cheap UP: taker at ${(tick.bestAsk * 100).toFixed(1)}%`,
          signalSource: "fade_cheap_taker"
        })];
      }
    }

    // Buy DOWN token if it's cheap (price is pumping, DOWN is below 15¢)
    if (downPrice <= this.maxEntryPrice && this.binanceMomentum > 0) {
      const modelProb = downPrice + 0.025;
      const edge = this.feeAdjustedEdge(modelProb, downPrice);
      if (!edge.profitable) return [];

      this.ticksSinceEntry = 0;
      this.entryMomentum = this.binanceMomentum;

      if (useMaker) {
        const limitPrice = (1 - tick.bestAsk) + 0.001;
        const shares = Math.floor(maxSize / limitPrice);
        if (shares < 5) return [];
        return [this.buy(downTokenId, limitPrice, shares, {
          orderType: "maker",
          note: `Cheap DOWN: maker at ${(limitPrice * 100).toFixed(1)}%`,
          signalSource: "fade_cheap_maker"
        })];
      } else {
        const downAsk = 1 - tick.bestBid;
        const shares = Math.floor(maxSize / downAsk);
        if (shares < 5) return [];
        return [this.buy(downTokenId, downAsk, shares, {
          note: `Cheap DOWN: taker at ${(downAsk * 100).toFixed(1)}%`,
          signalSource: "fade_cheap_taker"
        })];
      }
    }

    return [];
  }

  onRoundEnd(_state: EngineState): void {
    this.lastBinanceMid = 0;
    this.binanceMomentum = 0;
    this.ticksSinceEntry = 0;
    this.entryMomentum = 0;
    this.consecutiveStrongMoves = 0;
    this.marketRealizedPnl = 0;
    this.marketWinCount = 0;
    this.coolingDown = false;
    this.lastMarketTokens = "";
  }
}
