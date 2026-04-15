import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * DCA into the cheap side, hold to settlement. Inspired by weidan1C2C
 * (#3 on daily LB: 47% WR, 3.6:1 payoff, 100% DCA, $14k/day P&L).
 *
 * Unlike single-entry engines, this ladders up to maxEntries buys per
 * candle, adding on each tick where the cheap side is in range and the
 * previous fill has confirmed. Uses equal cash slices so total risk is
 * bounded by maxCashPct regardless of entry count.
 */
export class DcaSettleEngine extends AbstractEngine {
  id = "dca-settle-v1";
  name = "DCA Settle";
  version = "1.0.0";

  private readonly entryMin = 0.15;
  private readonly entryMax = 0.40;
  private readonly maxEntries = 8;
  private readonly maxCashPct = 0.60;
  private readonly entryWindowEndSec = 30; // stop entering in final 30s
  private entriesThisCandle = 0;
  private lastCandleKey = "";
  private enteredSide: "UP" | "DOWN" | null = null;

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    this.trackBinance(tick);
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    const rotated = this.updatePendingOrders();

    const candleKey = `${upTokenId}:${downTokenId}`;
    if (candleKey !== this.lastCandleKey || rotated) {
      this.entriesThisCandle = 0;
      this.enteredSide = null;
      this.lastCandleKey = candleKey;
    }

    if (this.hasPendingOrder()) return [];
    if (this.entriesThisCandle >= this.maxEntries) return [];

    // Regime gate (Apr 15 tightened): dca-settle's original gate fired on
    // runtime TREND labels (10+ bps over 600s) but the regime report still
    // showed 6 rounds where the full 6h regime was CHOP and dca-settle took
    // -$33/round. The subperiod TREND was real but didn't persist — the
    // engine was catching fake mini-trends inside larger CHOP rounds.
    //
    // Tightened gate:
    //  1. Hysteresis 30s → 90s — require trend to hold for 1.5 min before firing
    //  2. Explicit absMomentum > 15 bps threshold (1.5x the TREND label cutoff)
    //  3. Direction log for post-hoc analysis of which trends we caught
    const regime = this.currentRegimeStable(90_000, 600);
    if (regime !== "TREND" && regime !== "SPIKE") return [];
    const absMom = this.absMomentum(600);
    if (absMom < 0.0015) return [];

    const secsRemaining = this.getSecondsRemaining();
    if (secsRemaining >= 0 && secsRemaining < this.entryWindowEndSec) return [];

    const upBook = getBookForToken(upTokenId);
    const downBook = getBookForToken(downTokenId);
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;

    const upCheap = upAsk >= this.entryMin && upAsk <= this.entryMax;
    const downCheap = downAsk >= this.entryMin && downAsk <= this.entryMax;
    if (!upCheap && !downCheap) return [];

    // Stick to the same side once committed (don't flip mid-candle)
    let buyUp: boolean;
    if (this.enteredSide === "UP") {
      if (!upCheap) return [];
      buyUp = true;
    } else if (this.enteredSide === "DOWN") {
      if (!downCheap) return [];
      buyUp = false;
    } else {
      buyUp = upCheap && (!downCheap || upAsk < downAsk);
    }

    const tokenId = buyUp ? upTokenId : downTokenId;
    const askPrice = buyUp ? upAsk : downAsk;

    const edge = this.feeAdjustedEdge(0.55, askPrice);
    if (!edge.profitable) return [];

    // Equal cash slices: total budget / maxEntries
    const sliceBudget = (state.cashBalance > 0 ? state.cashBalance : 0) *
      (this.maxCashPct / this.maxEntries);
    const shares = Math.floor(sliceBudget / askPrice);
    if (shares < 5) return [];

    this.entriesThisCandle++;
    this.enteredSide = buyUp ? "UP" : "DOWN";
    this.markPending(tokenId);

    return [this.buy(tokenId, askPrice, shares, {
      orderType: "taker",
      note: `dca-settle: ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)}, entry ${this.entriesThisCandle}/${this.maxEntries}`,
      signalSource: "dca_settle",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.entriesThisCandle = 0;
    this.enteredSide = null;
    this.lastCandleKey = "";
  }
}
