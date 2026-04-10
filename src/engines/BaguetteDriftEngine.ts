import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Baguette Drift — replicates the strategy of real Polymarket trader 0xe007
 * ("Baguette") who has +$812K lifetime P&L on PM.
 *
 * Their pattern (from off-chain analysis): mid-candle entry around $0.56,
 * 11-minute hold, exit around $0.72. They're not betting on direction —
 * they're betting that *the candle resolves over time*. Buy at high
 * uncertainty, hold while one side gains conviction, sell as the consensus
 * forms.
 *
 * For 5M markets the timing scales down: enter mid-candle (window mid),
 * hold ~half the remaining window, exit before the dead-zone last seconds.
 *
 * Differences from mean-reversion: mean-revert assumes price returns to
 * $0.50. Baguette assumes price *diverges from* $0.50. Opposite thesis,
 * tested in the same regime.
 */
export class BaguetteDriftEngine extends AbstractEngine {
  id = "baguette-drift-v1";
  name = "Baguette Drift";
  version = "1.0.0";

  // Entry: mid must be in the uncertainty band
  private readonly entryMin = 0.42;
  private readonly entryMax = 0.58;
  // Don't enter unless we have time for the drift to play out
  private readonly minSecondsRemainingForEntry = 90;
  // Exit triggers
  private readonly takeProfitPrice = 0.70;
  private readonly stopLossPrice = 0.25;
  private readonly secondsRemainingForceExit = 30;
  // Sizing
  private readonly orderSizeUsd = 8;
  // Cooldown — one entry attempt per market max
  private readonly maxEntriesPerCandle = 1;

  // Per-tick Binance momentum tracking (last N samples)
  private binanceMidHistory: number[] = [];
  private readonly historyWindow = 6; // ~30s at 5s tick

  // Per-candle state
  private lastMarketTokens = "";
  private candleEntries = 0;
  private entryTokenId = "";
  private entrySide: "UP" | "DOWN" | "" = "";

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    // Maintain Binance momentum history
    if (tick.source === "binance") {
      this.binanceMidHistory.push(tick.midPrice);
      if (this.binanceMidHistory.length > this.historyWindow) this.binanceMidHistory.shift();
      return [];
    }

    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    // Reset per-candle state on rotation
    const currentTokens = `${upTokenId}:${downTokenId}`;
    if (currentTokens !== this.lastMarketTokens) {
      this.lastMarketTokens = currentTokens;
      this.candleEntries = 0;
      this.entryTokenId = "";
      this.entrySide = "";
    }

    const mid = tick.midPrice;
    const secsLeft = this.getSecondsRemaining();

    // ── Exit logic: if we hold a position, check exit triggers ──
    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    const heldPos = upPos?.shares ? upPos : downPos?.shares ? downPos : null;
    const heldTokenId = upPos?.shares ? upTokenId : downPos?.shares ? downTokenId : "";

    if (heldPos && heldTokenId) {
      // The "side" price = price of our held token
      const heldPrice = heldTokenId === upTokenId ? mid : (1 - mid);
      const forceExit = secsLeft >= 0 && secsLeft < this.secondsRemainingForceExit;

      if (heldPrice >= this.takeProfitPrice || heldPrice <= this.stopLossPrice || forceExit) {
        const sellPrice = heldTokenId === upTokenId ? tick.bestBid : (1 - tick.bestAsk);
        const reason = heldPrice >= this.takeProfitPrice ? "TP"
                     : heldPrice <= this.stopLossPrice ? "SL"
                     : "FORCE";
        return [this.sell(heldTokenId, sellPrice, heldPos.shares, {
          orderType: "taker",
          note: `Baguette ${reason} @ ${(heldPrice * 100).toFixed(1)}¢ (entry ${this.entrySide})`,
          signalSource: "baguette_exit",
        })];
      }
      return [];
    }

    // ── Entry logic ──
    if (this.candleEntries >= this.maxEntriesPerCandle) return [];
    if (secsLeft < 0 || secsLeft < this.minSecondsRemainingForEntry) return [];
    if (mid < this.entryMin || mid > this.entryMax) return [];
    if (this.binanceMidHistory.length < this.historyWindow) return [];

    // Pick side from Binance momentum: rising → buy UP, falling → buy DOWN
    const oldest = this.binanceMidHistory[0];
    const newest = this.binanceMidHistory[this.binanceMidHistory.length - 1];
    const momentum = (newest - oldest) / oldest;
    const minMomentum = 0.0005; // 5 bps over the window
    if (Math.abs(momentum) < minMomentum) return [];

    const buyUp = momentum > 0;
    const targetTokenId = buyUp ? upTokenId : downTokenId;
    const targetPrice = buyUp ? tick.bestAsk : (1 - tick.bestBid);
    if (targetPrice <= 0 || targetPrice >= 1) return [];

    const shares = Math.floor(this.orderSizeUsd / targetPrice);
    if (shares < 5) return [];

    this.candleEntries++;
    this.entryTokenId = targetTokenId;
    this.entrySide = buyUp ? "UP" : "DOWN";

    return [this.buy(targetTokenId, targetPrice, shares, {
      orderType: "taker",
      note: `Baguette entry ${this.entrySide} @ ${(targetPrice * 100).toFixed(1)}¢, mid=${mid.toFixed(3)}, mom=${(momentum * 10000).toFixed(1)}bps, secsLeft=${secsLeft}`,
      signalSource: "baguette_entry",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.binanceMidHistory = [];
    this.lastMarketTokens = "";
    this.candleEntries = 0;
    this.entryTokenId = "";
    this.entrySide = "";
  }
}
