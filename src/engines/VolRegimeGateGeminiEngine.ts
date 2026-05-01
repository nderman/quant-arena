/**
 * VolRegimeGateGeminiEngine — Gemini's enhancement of vol-regime-gate-v1.
 * Renamed from VolRegimeGateV2Engine (same id collided with Claude's v2).
 *
 * THESIS:
 * Volatility regimes (Ratio of 5m/1h Realized Vol) provide the "weather report,"
 * but we need "radar confirmation" to trade. v2 enhances the naive v1 by:
 *
 * 1. REGIME STABILITY: Tracks a 30-tick rolling AVERAGE of the vol ratio
 *    to prevent reacting to single-tick outliers or "flickering" regimes.
 * 2. DIRECTIONAL SYNC (EXPAND): In trending regimes, confirm Binance momentum
 *    matches the PM token we are buying. Don't buy UP if Binance is dumping.
 * 3. LIQUIDITY CONFIRMATION: Uses PM Book Imbalance to ensure there is actual
 *    bid-side pressure (for buys) supporting the entry.
 * 4. ADAPTIVE CONFIDENCE: Scaled modelProb based on the strength of the vol signal.
 * 5. SETTLEMENT GUARD: Skips the final 45 seconds of any candle to avoid noise
 *    and toxic flow associated with settlement pinning.
 * 6. COMPRESS REGIME-GATE: only fades in QUIET/CHOP regime (not TREND).
 *
 * Authored by Gemini, reviewed by Claude. Compared head-to-head with
 * VolRegimeGateV2Engine (Claude's enhancement) which uses 3-tick mode-vote
 * persistence vs this engine's 30-tick rolling-average smoothing.
 */

import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

export class VolRegimeGateGeminiEngine extends AbstractEngine {
  id = "vol-regime-gate-gemini-v1";
  name = "Vol Regime Gate (Gemini)";
  version = "1.0.0";

  // Configuration
  private readonly ratioHistorySize = 30; // ~30 ticks of history
  private readonly settlementBuffer = 45; // seconds
  private ratioHistory: number[] = [];

  // Adaptive Thresholds
  private readonly EXPAND_BASE = 1.35;
  private readonly COMPRESS_BASE = 0.65;

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    // 1. Basic Validation & Binance Tracking
    this.trackBinance(tick);
    if (tick.source !== "polymarket") return [];
    if (!signals?.realizedVol || !signals?.binancePrice) return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    // 2. State & Congestion Management
    this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    // 3. Time-in-Candle Gate — avoid the "Settlement Scramble"
    const secsLeft = this.getSecondsRemaining();
    if (secsLeft >= 0 && secsLeft < this.settlementBuffer) return [];

    // 4. Volatility Ratio Stability via rolling average
    const currentRatio = signals.realizedVol.vol5m / signals.realizedVol.vol1h;
    if (!Number.isFinite(currentRatio) || currentRatio <= 0) return [];
    this.ratioHistory.push(currentRatio);
    if (this.ratioHistory.length > this.ratioHistorySize) this.ratioHistory.shift();

    if (this.ratioHistory.length < 10) return [];

    const avgRatio = this.ratioHistory.reduce((a, b) => a + b, 0) / this.ratioHistory.length;

    // 5. Determine Regime
    let mode: "EXPAND" | "COMPRESS" | null = null;
    if (avgRatio > this.EXPAND_BASE) mode = "EXPAND";
    else if (avgRatio < this.COMPRESS_BASE) mode = "COMPRESS";

    if (!mode) return [];

    // 6. Access Orderbooks
    const upBook = this.getBookForToken(upTokenId);
    const downBook = this.getBookForToken(downTokenId);
    if (!this.isBookTradeable(upBook) || !this.isBookTradeable(downBook)) return [];

    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    let targetTokenId = "";
    let entryPrice = 0;
    let modelProb = 0.50;

    // 7. Logic Branching
    if (mode === "EXPAND") {
      // EXPAND STRATEGY: Trend Following
      const momentum = this.recentMomentum(30);
      const imbalanceUp = this.bookImbalance(upTokenId, 3);
      const imbalanceDown = this.bookImbalance(downTokenId, 3);

      const upSignal = momentum > 1.0005 && imbalanceUp > 0.1;
      const downSignal = momentum < 0.9995 && imbalanceDown > 0.1;

      const upperLimit = Math.min(0.85, 0.75 + (avgRatio - 1.3) * 0.1);
      const lowerLimit = 0.55;

      if (upSignal && upAsk >= lowerLimit && upAsk <= upperLimit) {
        targetTokenId = upTokenId;
        entryPrice = upAsk;
      } else if (downSignal && downAsk >= lowerLimit && downAsk <= upperLimit) {
        targetTokenId = downTokenId;
        entryPrice = downAsk;
      }

      modelProb = Math.min(0.82, 0.65 + (avgRatio - 1.3) * 0.2);
    } else {
      // COMPRESS STRATEGY: Mean Reversion (Fade)
      const regime = this.currentRegime(60);
      if (regime !== "QUIET" && regime !== "CHOP") return [];

      const imbalanceUp = this.bookImbalance(upTokenId, 3);
      const imbalanceDown = this.bookImbalance(downTokenId, 3);

      const upUnderdog = upAsk >= 0.20 && upAsk <= 0.45 && imbalanceUp > 0.05;
      const downUnderdog = downAsk >= 0.20 && downAsk <= 0.45 && imbalanceDown > 0.05;

      if (upUnderdog && (!downUnderdog || upAsk < downAsk)) {
        targetTokenId = upTokenId;
        entryPrice = upAsk;
      } else if (downUnderdog) {
        targetTokenId = downTokenId;
        entryPrice = downAsk;
      }

      modelProb = 0.55 + (this.COMPRESS_BASE - avgRatio) * 0.1;
    }

    if (!targetTokenId || entryPrice === 0) return [];

    // 8. Edge Validation (Quartic Fee Check)
    const edge = this.feeAdjustedEdge(modelProb, entryPrice);
    if (!edge.profitable) return [];

    // 9. Position Sizing (15% cap, min 10 shares)
    const sizeLimit = state.cashBalance * 0.15;
    const shares = Math.floor(sizeLimit / entryPrice);
    if (shares < 10) return [];

    this.markPending(targetTokenId);
    return [
      this.buy(targetTokenId, entryPrice, shares, {
        orderType: "taker",
        note: `gemini-${mode}: ratioAvg=${avgRatio.toFixed(2)} prob=${modelProb.toFixed(2)}`,
        signalSource: "vol_regime_gemini",
      }),
    ];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.ratioHistory = [];
  }
}
