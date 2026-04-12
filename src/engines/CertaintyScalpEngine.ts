import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Late-candle certainty scalper. Inspired by "durrrrrrrr" (#22 on daily LB):
 * 439 positions, 95% WR, avg entry 81¢, 68% entries at 90¢+.
 *
 * Buy the near-certain winner in the final 60s of the candle at 90-97¢.
 * Settlement pays $1/share → 3-10¢ profit per share × large size.
 * Edge is tiny per trade but compounds with 95%+ WR and high frequency.
 */
export class CertaintyScalpEngine extends AbstractEngine {
  id = "certainty-scalp-v1";
  name = "Certainty Scalp";
  version = "1.0.0";

  private readonly entryMin = 0.88;
  private readonly entryMax = 0.97;
  private readonly entryWindowSec = 60;
  private readonly maxCashPct = 0.40;
  private enteredThisCandle = false;
  private lastCandleKey = "";

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();

    const candleKey = `${upTokenId}:${downTokenId}`;
    if (candleKey !== this.lastCandleKey) {
      this.enteredThisCandle = false;
      this.lastCandleKey = candleKey;
    }

    if (this.hasPendingOrder()) return [];
    if (this.enteredThisCandle) return [];

    const secsRemaining = this.getSecondsRemaining();
    if (secsRemaining < 0 || secsRemaining > this.entryWindowSec) return [];

    const upBook = getBookForToken(upTokenId);
    const downBook = getBookForToken(downTokenId);
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;

    const upInRange = upAsk >= this.entryMin && upAsk <= this.entryMax;
    const downInRange = downAsk >= this.entryMin && downAsk <= this.entryMax;
    if (!upInRange && !downInRange) return [];

    // Buy the side closer to $1 (more certain winner)
    const buyUp = upInRange && (!downInRange || upAsk > downAsk);
    const tokenId = buyUp ? upTokenId : downTokenId;
    const askPrice = buyUp ? upAsk : downAsk;

    // At 90¢+, model prob is the ask price itself — market is efficient this late
    const edge = this.feeAdjustedEdge(askPrice + 0.02, askPrice);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / askPrice);
    if (shares < 5) return [];

    this.enteredThisCandle = true;
    this.markPending(tokenId);
    return [this.buy(tokenId, askPrice, shares, {
      orderType: "taker",
      note: `certainty-scalp: ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)}, ${secsRemaining}s remain`,
      signalSource: "certainty_scalp",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.enteredThisCandle = false;
    this.lastCandleKey = "";
  }
}
