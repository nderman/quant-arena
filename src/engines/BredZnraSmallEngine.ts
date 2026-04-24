import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * bred-znra-small-v1 — small-sized variant of bred-znra.
 *
 * Sim analysis (24 rounds, Apr 23):
 *   bred-znra +$34 total, 21% WR, avg win $22 / avg loss $26, range ±$37.
 *   Profitable BUT variance is too high for $25 live bankroll — a single
 *   bad round can lose $37 (~150% of bankroll after compounding).
 *
 * This variant: same strategy (5-20¢ underdog taker, 3 entries/candle, TREND
 * regime filter), but 2.50 per entry instead of $5. Max exposure $7.50
 * per candle instead of $15. Expected variance ~$18 per round (halved).
 *
 * Tradeoff: smaller wins too. But +$10-12 per good round on $25 bankroll
 * is still 40-48% daily — and we survive the bad ones. Risk of ruin drops
 * from ~15% (on 24 rounds) to ~1%.
 *
 * Source engine (bred-znra) lives on VPS only (bred by breeder). This
 * clone is local so we can deploy/iterate without touching VPS bred engines.
 */
export class BredZnraSmallEngine extends AbstractEngine {
  id = "bred-znra-small-v1";
  name = "Toxic Flow Reactor (small size)";
  version = "1.0.0";

  private readonly extremeMin = 0.05;
  private readonly extremeMax = 0.20;

  private candleEntries = 0;
  private candleExposure = 0;
  private lastCandleKey = "";

  private readonly maxEntriesPerCandle = 3;
  private readonly maxExposurePerCandle = 7.5;   // was 15
  private readonly dcaStepSize = 2.5;             // was 5

  private readonly earlyWindowSec = 60;
  private readonly settlementBufferSec = 15;

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    this.trackBinance(tick);
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    const candleKey = `${upTokenId}:${downTokenId}`;
    if (candleKey !== this.lastCandleKey) {
      this.candleEntries = 0;
      this.candleExposure = 0;
      this.lastCandleKey = candleKey;
    }

    this.updatePendingOrders();

    if (this.currentRegime(this.arenaScaledSec(300)) === "UNKNOWN") return [];

    const secsRemaining = this.getSecondsRemaining();
    if (secsRemaining < 0) return [];
    if (secsRemaining < this.settlementBufferSec) return [];

    const candleSec = this.candleSeconds() || 300;
    const scale = candleSec / 300;
    const secondsElapsed = candleSec - secsRemaining;
    const inEarlyWindow = secondsElapsed <= this.earlyWindowSec * scale;

    const regime = this.currentRegimeStable(this.arenaScaledSec(60));
    const rejectQuietEarly = inEarlyWindow && regime === "QUIET";
    if (rejectQuietEarly) return [];

    if (this.hasPendingOrder()) return [];

    if (this.candleEntries >= this.maxEntriesPerCandle) return [];
    if (this.candleExposure >= this.maxExposurePerCandle) return [];

    const upBook = this.getBookForToken(upTokenId);
    const downBook = this.getBookForToken(downTokenId);
    if (!this.isBookTradeable(upBook) || !this.isBookTradeable(downBook)) return [];
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    const upInZone = upAsk >= this.extremeMin && upAsk <= this.extremeMax;
    const downInZone = downAsk >= this.extremeMin && downAsk <= this.extremeMax;
    if (!upInZone && !downInZone) return [];

    const buyUp = upInZone && (!downInZone || upAsk < downAsk);
    const tokenId = buyUp ? upTokenId : downTokenId;
    const askPrice = buyUp ? upAsk : downAsk;

    const modelProb = Math.min(askPrice + 0.03, 0.99);
    const edge = this.feeAdjustedEdge(modelProb, askPrice);
    if (!edge.profitable) return [];

    const notionalCost = this.dcaStepSize;
    const size = Math.floor(notionalCost / askPrice);
    if (size < 3) return [];

    if (this.candleExposure + notionalCost > this.maxExposurePerCandle) return [];

    this.candleEntries++;
    this.candleExposure += notionalCost;
    this.markPending(tokenId);

    const side = buyUp ? "UP" : "DOWN";
    return [this.buy(tokenId, askPrice, size, {
      orderType: "taker",
      note: `znra-small-${side} #${this.candleEntries} @ ${askPrice.toFixed(3)} (regime=${regime})`,
      signalSource: "bred_znra_small",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.candleEntries = 0;
    this.candleExposure = 0;
    this.lastCandleKey = "";
    this.clearPendingOrders();
  }
}
