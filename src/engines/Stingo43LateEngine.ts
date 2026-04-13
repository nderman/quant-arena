import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * stingo43-late-v1 — same signal as stingo43-v1 but waits longer into the candle.
 *
 * Momentum backtest on 72h BTC (scripts/backtestMomentumSweep.py):
 *   stingo43-v1  (T+60-120s, 5bps):   80% WR, 140 triggers,  $665 synth PnL
 *   stingo43-late (T+150-210s, 5bps): 94% WR, 326 triggers, $2292 synth PnL
 *
 * Waiting 90 more seconds into the candle buys ~14 points of WR at the
 * cost of a slightly higher PM entry price (the winner is already more
 * expensive by T+180s). A/B against stingo43-v1 in the arena.
 *
 * Uses the new AbstractEngine.trackBinance() + recentMomentum() helpers
 * instead of maintaining a private price buffer.
 */
export class Stingo43LateEngine extends AbstractEngine {
  id = "stingo43-late-v1";
  name = "Stingo43 Late Entry";
  version = "1.0.0";

  private readonly entryWindowStartSec = 150;
  private readonly entryWindowEndSec = 210;
  private readonly momentumThreshold = 0.0005; // 5 bps
  private readonly maxCashPct = 0.30;
  /**
   * Lookback for recentMomentum(): we want the cumulative move from candle
   * open to "now" (T+150-210s into a 5-min candle), so lookback = elapsed.
   * Bounded to avoid pulling samples from the previous candle.
   */

  private enteredThisCandle = false;
  private lastCandleKey = "";

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    // Feed the Binance buffer regardless of source — no-op on PM ticks
    this.trackBinance(tick);

    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    const rotated = this.updatePendingOrders();

    const candleKey = `${upTokenId}:${downTokenId}`;
    if (candleKey !== this.lastCandleKey || rotated) {
      this.enteredThisCandle = false;
      this.lastCandleKey = candleKey;
    }

    if (this.hasPendingOrder()) return [];
    if (this.enteredThisCandle) return [];

    const secsRemaining = this.getSecondsRemaining();
    if (secsRemaining < 0) return [];
    const elapsed = 300 - secsRemaining;
    if (elapsed < this.entryWindowStartSec || elapsed > this.entryWindowEndSec) return [];

    // Measure momentum from candle open (T+0) up to now (T+elapsed).
    // Lookback = elapsed seconds so we capture the full candle move.
    const momentum = this.recentMomentum(Math.min(elapsed, 240));
    if (Math.abs(momentum) < this.momentumThreshold) return [];

    const buyUp = momentum > 0;
    const tokenId = buyUp ? upTokenId : downTokenId;
    const book = getBookForToken(tokenId);
    const askPrice = book.asks[0]?.price ?? 0;
    if (askPrice <= 0 || askPrice > 0.95) return [];

    // Derating the backtest's 94% WR: model prob 0.75 to account for
    // arena fee drag + uncertainty in the lookback calc.
    const edge = this.feeAdjustedEdge(0.75, askPrice);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / askPrice);
    if (shares < 5) return [];

    this.enteredThisCandle = true;
    this.markPending(tokenId);
    return [this.buy(tokenId, askPrice, shares, {
      orderType: "taker",
      note: `stingo43-late: ${buyUp ? "UP" : "DOWN"} @ ${askPrice.toFixed(3)}, mom=${(momentum * 100).toFixed(3)}%, T+${elapsed.toFixed(0)}s`,
      signalSource: "stingo43_late_momentum",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.enteredThisCandle = false;
    this.lastCandleKey = "";
  }
}
