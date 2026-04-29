import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * TradeSettlePingerEngine
 *
 * Thesis: in the LAST 60 seconds of a candle, the side priced at 70-85c
 * has typically already accumulated late-window directional flow that
 * the early-candle uncertainty pricing missed. The current PM bid is
 * the market's most up-to-date estimate. Buying the leader cheaply via
 * a maker just under bid and holding to settle wins ~70% empirically.
 *
 * Differs from stingo43-late-v1 (T+150-210s on 5m): this fires later
 * (T+240-300s on 5m, T+780-900s on 15m, etc) and only as a maker — pure
 * rebate-capture play on near-resolution price.
 *
 * Gates:
 *  - secondsRemaining < 60 (last minute of candle)
 *  - leading-side ask in 70-85¢ (high-conviction band)
 *  - bookImbalance on leading side > 0 (book confirms direction)
 *  - feeAdjustedEdge profitable at modelProb=0.70
 *  - 5-share min, 15% cash cap
 */
export class TradeSettlePingerEngine extends AbstractEngine {
  id = "trade-settle-pinger-v1";
  name = "Trade-Settle Pinger";
  version = "1.0.0";

  private readonly entryMin = 0.70;
  private readonly entryMax = 0.85;
  private readonly maxSecondsLeft = 60;
  private readonly maxCashPct = 0.15;

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    // Late-window gate — only fire in last 60s of candle
    const secsLeft = this.getSecondsRemaining();
    if (secsLeft < 0 || secsLeft >= this.maxSecondsLeft) return [];

    const upBook = this.getBookForToken(upTokenId);
    const downBook = this.getBookForToken(downTokenId);
    if (!this.isBookTradeable(upBook) || !this.isBookTradeable(downBook)) return [];

    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    // Leader must be in 70-85¢ band — late-window confidence zone
    const upLeading = upAsk >= this.entryMin && upAsk <= this.entryMax;
    const downLeading = downAsk >= this.entryMin && downAsk <= this.entryMax;
    if (!upLeading && !downLeading) return [];

    const buyUp = upLeading && (!downLeading || upAsk > downAsk);
    const tokenId = buyUp ? upTokenId : downTokenId;
    const askPrice = buyUp ? upAsk : downAsk;

    // Book confirmation — leading side must show non-negative imbalance
    const imbalance = this.bookImbalance(tokenId, 3);
    if (imbalance < 0) return [];

    const edge = this.feeAdjustedEdge(0.70, askPrice);
    if (!edge.profitable) return [];

    // Maker price 1 tick below ask. Tiny spread (1¢) because we have <60s
    // and need to fill — wider offset risks no fill.
    const makerPrice = Math.round((askPrice - 0.01) * 100) / 100;
    if (makerPrice <= 0) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / askPrice);
    if (shares < 5) return [];

    const bestAsk = askPrice;
    if (makerPrice >= bestAsk) {
      // Spread already 1 tick — fall back to taker
      this.markPending(tokenId);
      return [this.buy(tokenId, askPrice, shares, {
        orderType: "taker",
        note: `pinger: taker ${buyUp ? "UP" : "DOWN"} @${askPrice.toFixed(3)} secs=${secsLeft.toFixed(0)} imb=${imbalance.toFixed(2)}`,
        signalSource: "trade_settle_pinger",
      })];
    }

    this.markPending(tokenId);
    return [this.buy(tokenId, makerPrice, shares, {
      orderType: "maker",
      note: `pinger: maker ${buyUp ? "UP" : "DOWN"} @${makerPrice.toFixed(3)} secs=${secsLeft.toFixed(0)} imb=${imbalance.toFixed(2)}`,
      signalSource: "trade_settle_pinger",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
