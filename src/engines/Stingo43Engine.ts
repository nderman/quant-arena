import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Validated signal: Binance direction at T+60-120s predicts 5M settlement
 * 62-69% of the time (72h backtest, 861 candles per coin).
 *
 * Inspired by stingo43 (#10 weekly LB, +$340k, 69% WR, 0 sells, all coins).
 * No PM price gate — buys at whatever price PM offers for the winning side.
 * No exits — pure hold to settlement.
 */
export class Stingo43Engine extends AbstractEngine {
  id = "stingo43-v1";
  name = "Stingo43 Momentum Settler";
  version = "1.0.0";

  private readonly entryWindowStartSec = 60;
  private readonly entryWindowEndSec = 120;
  private readonly momentumThreshold = 0.0005; // 5bps minimum move from candle open
  private readonly maxCashPct = 0.30;

  private candleOpenPrice = 0;
  private lastBinancePrice = 0;
  private enteredThisCandle = false;
  private lastCandleKey = "";

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    if (tick.source === "binance") {
      this.lastBinancePrice = tick.midPrice;
      return [];
    }

    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    const rotated = this.updatePendingOrders();

    const candleKey = `${upTokenId}:${downTokenId}`;
    if (candleKey !== this.lastCandleKey || rotated) {
      this.enteredThisCandle = false;
      this.lastCandleKey = candleKey;
      if (this.lastBinancePrice > 0) {
        this.candleOpenPrice = this.lastBinancePrice;
      }
    }

    if (this.hasPendingOrder()) return [];
    if (this.enteredThisCandle) return [];
    if (this.candleOpenPrice <= 0 || this.lastBinancePrice <= 0) return [];

    const secsRemaining = this.getSecondsRemaining();
    if (secsRemaining < 0) {
      console.log(`[stingo43] SKIP: secsRemaining=${secsRemaining} (windowEnd not set?)`);
      return [];
    }
    const elapsed = 300 - secsRemaining;
    if (elapsed < this.entryWindowStartSec || elapsed > this.entryWindowEndSec) return [];

    const momentum = (this.lastBinancePrice - this.candleOpenPrice) / this.candleOpenPrice;
    if (Math.abs(momentum) < this.momentumThreshold) {
      console.log(`[stingo43] SKIP: mom=${(momentum*100).toFixed(4)}% < threshold at T+${elapsed.toFixed(0)}s`);
      return [];
    }

    const buyUp = momentum > 0;
    const tokenId = buyUp ? upTokenId : downTokenId;
    const book = getBookForToken(tokenId);
    const askPrice = book.asks[0]?.price ?? 0;
    if (askPrice <= 0 || askPrice > 0.95) return [];

    const edge = this.feeAdjustedEdge(0.65, askPrice);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / askPrice);
    if (shares < 5) return [];

    this.enteredThisCandle = true;
    this.markPending(tokenId);
    return [this.buy(tokenId, askPrice, shares, {
      orderType: "taker",
      note: `stingo43: ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)}, mom=${(momentum * 100).toFixed(3)}%, T+${elapsed.toFixed(0)}s`,
      signalSource: "stingo43_momentum",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.enteredThisCandle = false;
    this.lastCandleKey = "";
    this.candleOpenPrice = 0;
  }
}
