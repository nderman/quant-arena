import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * PanicFadeEngine-v1
 *
 * Thesis: Binary markets over-index on local volatility spikes. This engine
 * buys UP when local realized vol exceeds macro implied vol (panic), the
 * regime has cooled to CHOP/QUIET (post-spike), the F&G index is fearful,
 * AND the spread has compressed (liquidity returned). Authored by Gemini,
 * fixed by human review (currentRegimeStable bug fixed; book guard added).
 *
 * Logic:
 *  - F&G < 40 (broad fear)
 *  - vol5m / DVOL > 1.5 (local vol spiked above macro expectation)
 *  - regime == CHOP or QUIET (panic ended)
 *  - spreadBps < 60 (book tight again)
 *  - UP ask in 20-45¢ value zone
 *  - Buy maker 2 ticks below ask, take the rebate on the recovery
 */
export class PanicFadeEngine extends AbstractEngine {
  id = "panic-fade-v1";
  name = "Fear-Vol Mean Reversion";
  version = "1.0.0";

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    if (!upTokenId) return [];

    this.updatePendingOrders();
    if (this.hasPendingOrder() || this.hasPosition(upTokenId)) return [];

    const fearGreed = signals?.fearGreed?.value ?? 50;
    const dvol = signals?.impliedVol?.dvol ?? 50;
    const vol5m = signals?.realizedVol?.vol5m ?? 0;

    this.trackBinance(tick);
    const regime = this.currentRegime(60);  // returns regime label string

    if (fearGreed > 40) return [];                       // need fear
    if (vol5m < dvol * 1.5) return [];                   // local vol must be stretched
    if (regime !== "CHOP" && regime !== "QUIET") return [];  // post-spike cooldown

    const spread = this.spreadBps(upTokenId);
    if (spread <= 0 || spread > 60) return [];           // tight book = liquidity back

    const upBook = this.getBookForToken(upTokenId);
    if (!this.isBookTradeable(upBook)) return [];

    const bestAsk = upBook.asks[0]?.price ?? 0;
    if (bestAsk < 0.20 || bestAsk > 0.45) return [];

    const entryPrice = Math.round((bestAsk - 0.02) * 100) / 100;
    if (entryPrice <= 0) return [];

    // Model: 8pp edge above market (panic-discounted underdog)
    const modelProb = Math.min(0.95, entryPrice + 0.08);
    const edge = this.feeAdjustedEdge(modelProb, entryPrice);
    if (!edge.profitable) return [];

    // Sizing: 25% cash, 5-40 share band
    const sharesAffordable = Math.floor((state.cashBalance * 0.25) / entryPrice);
    const size = Math.max(5, Math.min(sharesAffordable, 40));
    if (size < 5) return [];

    this.markPending(upTokenId);
    return [
      this.buy(upTokenId, entryPrice, size, {
        orderType: "maker",
        note: `panic_fade: fng=${fearGreed} vol5m=${vol5m.toFixed(0)} dvol=${dvol} spread=${spread.toFixed(0)}bps`,
        signalSource: "panic_fade",
      }),
    ];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
