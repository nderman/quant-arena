import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * SentimentFlowEngine
 *
 * Thesis: High-conviction moves occur when Binance Funding (Macro) and
 * PM Book Imbalance (Micro) align, provided we aren't in a chaotic SPIKE
 * regime. Authored by Gemini, reviewed/fixed by human.
 *
 * Strategy:
 *  - Macro filter: Binance funding rate signals crowded futures positioning
 *  - Micro trigger: PM book imbalance > 0.65 in the SAME direction
 *  - Volatility gate: skip SPIKE regime (high adverse-selection risk)
 *  - Execution: maker order 2 ticks behind ask (0% fee + 20% rebate)
 */
export class SentimentFlowEngine extends AbstractEngine {
  id = "sentiment-flow-v1";
  name = "Sentiment Flow Convergent";
  version = "1.1.0";

  // Loosened Apr 26: triple-conjunction at original thresholds never fired.
  // Generating data > maximizing signal purity at this stage.
  private readonly IMBALANCE_THRESHOLD = 0.45;     // was 0.65
  private readonly MIN_FUNDING_RATE = 0.00005;     // was 0.0001
  private readonly TICK_SIZE = 0.01;

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    // Track Binance for regime detection
    this.trackBinance(tick);

    // Volatility gate: skip SPIKE (toxic flow window) and UNKNOWN (warmup)
    const regime = this.currentRegime(60);
    if (regime === "SPIKE" || regime === "UNKNOWN") return [];

    const fundingRate = signals?.funding?.rate ?? 0;
    if (Math.abs(fundingRate) < this.MIN_FUNDING_RATE) return [];

    const upBook = this.getBookForToken(upTokenId);
    const downBook = this.getBookForToken(downTokenId);
    if (!this.isBookTradeable(upBook) || !this.isBookTradeable(downBook)) return [];

    const upImbalance = this.bookImbalance(upTokenId, 3);
    const downImbalance = this.bookImbalance(downTokenId, 3);
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    let targetTokenId: string | null = null;
    let entryPrice = 0;
    let logicNote = "";

    // Bullish convergence: positive funding + UP book bid-heavy
    if (fundingRate > this.MIN_FUNDING_RATE && upImbalance > this.IMBALANCE_THRESHOLD) {
      targetTokenId = upTokenId;
      entryPrice = Math.round((upAsk - this.TICK_SIZE * 2) * 100) / 100;
      logicNote = `bullish_convergence: funding=${fundingRate.toFixed(5)} upImb=${upImbalance.toFixed(2)}`;
    }
    // Bearish convergence: negative funding + DOWN book bid-heavy
    else if (fundingRate < -this.MIN_FUNDING_RATE && downImbalance > this.IMBALANCE_THRESHOLD) {
      targetTokenId = downTokenId;
      entryPrice = Math.round((downAsk - this.TICK_SIZE * 2) * 100) / 100;
      logicNote = `bearish_convergence: funding=${fundingRate.toFixed(5)} downImb=${downImbalance.toFixed(2)}`;
    }

    if (!targetTokenId || entryPrice <= 0) return [];
    if (entryPrice < 0.10 || entryPrice > 0.85) return [];

    // Conservative model: assume 5pp edge over market price
    const modelProb = Math.min(0.95, entryPrice + 0.05);
    const edge = this.feeAdjustedEdge(modelProb, entryPrice);
    if (!edge.profitable) return [];

    // Sizing: ~25% of cash, capped to share count that fits
    const sharesAffordable = Math.floor((state.cashBalance * 0.25) / entryPrice);
    const orderSize = Math.max(5, Math.min(sharesAffordable, 50));
    if (orderSize < 5) return [];

    this.markPending(targetTokenId);
    return [
      this.buy(targetTokenId, entryPrice, orderSize, {
        orderType: "maker",
        note: logicNote,
        signalSource: "sentiment_flow",
      }),
    ];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
