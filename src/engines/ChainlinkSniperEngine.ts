import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import { CONFIG } from "../config";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * Chainlink Sniper — replicates the strategy of real Polymarket trader
 * 0xd84c ("BoneReader") who has 95%+ win rate buying at $0.93-0.99 in the
 * last seconds of a candle.
 *
 * The trick: they're not gambling on PM price as a signal. They're using
 * EXTERNAL information (Chainlink) to confirm the candle outcome before
 * the market has fully repriced. By comparing the current Chainlink price
 * to the strike (price at window start), they know which side will win,
 * and grab the small remaining edge of $0.01-$0.07 per share.
 *
 * Why our late-sniper-v1 fails: it triggers on PM price > 0.85 alone, with
 * no external confirmation. So it fires on candles where the market
 * *thinks* one side is likely but the underlying could still flip. Result:
 * -$45/round, three coins, every round.
 *
 * This engine fixes that by:
 *   1. Capturing the strike price (Chainlink at window start) as truth
 *   2. Only firing if current Chainlink confirms the leading side
 *   3. Requiring tight book spread (no walking thin liquidity)
 *   4. Sizing tiny ($2-3) so slippage is bounded
 *   5. Holding to settlement
 *
 * Failure modes:
 *   - Chainlink stale or unavailable → no fire (returns null)
 *   - Spread > 2¢ → no fire (book too thin)
 *   - PM price already maxed (≥ 0.99) → no fire (no edge left)
 */
export class ChainlinkSniperEngine extends AbstractEngine {
  id = "chainlink-sniper-v1";
  name = "Chainlink Sniper";
  version = "1.0.0";

  // Trade only in the dying seconds when the outcome is essentially decided
  private readonly maxSecondsRemaining = 60;
  // Minimum PM price on the leading side to bother (anything below = uncertain)
  private readonly minLeadingPrice = 0.92;
  // Don't enter above this — no edge left
  private readonly maxLeadingPrice = 0.99;
  // Hard spread cap — book must be liquid for entry to be safe
  private readonly maxSpreadCents = 0.02;
  // Tiny size — this is a precision strategy, not a size game
  private readonly orderSizeUsd = 3;
  // One entry per candle max
  private readonly maxEntriesPerCandle = 1;

  // Per-candle state
  private lastMarketTokens = "";
  private candleEntries = 0;
  private strikePrice: number | null = null;
  private currentMarketSymbol = "";
  // First-call diagnostic — tells us if onTick is even being entered
  private firstCallLogged = false;

  // Skip-reason logging — emit at most every N seconds per coin so we can see
  // why the engine isn't firing without flooding logs
  private lastSkipLogAt = 0;
  private readonly skipLogIntervalMs = 60_000;
  private lastStateLogAt = 0;

  private logSkip(reason: string): void {
    const now = Date.now();
    if (now - this.lastSkipLogAt < this.skipLogIntervalMs) return;
    this.lastSkipLogAt = now;
    console.log(`[chainlink-sniper] ${this.currentMarketSymbol || "?"} skip: ${reason}`);
  }

  /** Unconditional state dump every 60s — runs even when guards block us early. */
  private logState(secsLeft: number): void {
    const now = Date.now();
    if (now - this.lastStateLogAt < 60_000) return;
    this.lastStateLogAt = now;
    const cl = this.getChainlinkPrice(this.currentMarketSymbol);
    console.log(
      `[chainlink-sniper] ${this.currentMarketSymbol || "?"} state: ` +
      `secsLeft=${secsLeft}, strike=${this.strikePrice ?? "null"}, ` +
      `currentCl=${cl ?? "null"}, candleEntries=${this.candleEntries}, ` +
      `tokens=${this.lastMarketTokens.slice(0, 12)}...`
    );
  }

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    if (!this.firstCallLogged) {
      this.firstCallLogged = true;
      console.log(
        `[chainlink-sniper] FIRST_CALL src=${tick.source} ` +
        `upToken=${this.getUpTokenId().slice(0, 12)}... ` +
        `downToken=${this.getDownTokenId().slice(0, 12)}... ` +
        `marketSymbol=${this.getMarketSymbol()} ` +
        `cash=${state.cashBalance}`
      );
    }

    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    // Detect candle rotation — reset per-candle state.
    // currentMarketSymbol uses CONFIG.ARENA_BINANCE_SYMBOL as a stable fallback.
    // state.marketSymbol can be empty on early ticks before the rotation
    // callback has populated it; without the fallback, getChainlinkPrice("")
    // returns null and the engine never captures a strike.
    const currentTokens = `${upTokenId}:${downTokenId}`;
    if (currentTokens !== this.lastMarketTokens) {
      this.lastMarketTokens = currentTokens;
      this.candleEntries = 0;
      this.strikePrice = null;
      this.currentMarketSymbol = this.getMarketSymbol() || CONFIG.ARENA_BINANCE_SYMBOL;
    }
    // Also keep symbol fresh in case it was empty on rotation but populated later
    if (!this.currentMarketSymbol) {
      this.currentMarketSymbol = this.getMarketSymbol() || CONFIG.ARENA_BINANCE_SYMBOL;
    }

    // Lazy strike capture — try every tick until we successfully read Chainlink.
    // Previous one-shot capture failed when the Chainlink poller hadn't run yet
    // at the moment of market rotation, leaving strikePrice null forever.
    if (this.strikePrice === null) {
      const cl = this.getChainlinkPrice(this.currentMarketSymbol);
      if (cl !== null) this.strikePrice = cl;
    }

    if (this.candleEntries >= this.maxEntriesPerCandle) return [];

    const secsLeft = this.getSecondsRemaining();
    // Periodic state dump regardless of where we are — answers "are we ever
    // even reaching this code path? what's secsLeft? does Chainlink work?"
    this.logState(secsLeft);
    if (secsLeft < 0 || secsLeft > this.maxSecondsRemaining) return [];

    if (this.strikePrice === null) {
      this.logSkip("strike not yet captured (Chainlink unavailable)");
      return [];
    }

    const currentChainlink = this.getChainlinkPrice(this.currentMarketSymbol);
    if (currentChainlink === null) {
      this.logSkip("current Chainlink unavailable");
      return [];
    }

    // Determine which side Chainlink confirms
    const chainlinkSaysUp = currentChainlink > this.strikePrice;
    const chainlinkConfidenceBps = Math.abs((currentChainlink - this.strikePrice) / this.strikePrice) * 10000;
    if (chainlinkConfidenceBps < 5) {
      this.logSkip(`Chainlink too close to strike (${chainlinkConfidenceBps.toFixed(1)}bps)`);
      return [];
    }

    // Read BOTH books directly. Never derive one side's price from the other
    // via 1-x — UP and DOWN have independent dual orderbooks, that inversion
    // is wrong. (See feedback_dual_books.md for the canonical version of this
    // mistake.)
    const targetTokenId = chainlinkSaysUp ? upTokenId : downTokenId;
    const targetBook = getBookForToken(targetTokenId);
    const targetBestAsk = targetBook.asks[0]?.price;
    const targetBestBid = targetBook.bids[0]?.price;
    if (!targetBestAsk || !targetBestBid || targetBestAsk <= 0) {
      this.logSkip(`target book empty (token=${targetTokenId.slice(0, 8)}...)`);
      return [];
    }

    if (targetBestAsk < this.minLeadingPrice || targetBestAsk >= this.maxLeadingPrice) {
      this.logSkip(`target ask ${targetBestAsk.toFixed(3)} out of [${this.minLeadingPrice}, ${this.maxLeadingPrice})`);
      return [];
    }

    const spread = targetBestAsk - targetBestBid;
    if (spread <= 0 || spread > this.maxSpreadCents) {
      this.logSkip(`spread ${spread.toFixed(3)} > ${this.maxSpreadCents}`);
      return [];
    }

    // Size — small, bounded
    const shares = Math.floor(this.orderSizeUsd / targetBestAsk);
    if (shares < 5) return [];

    if (state.cashBalance < shares * targetBestAsk) return [];

    this.candleEntries++;

    const expectedProfit = (1 - targetBestAsk) * shares;
    return [this.buy(targetTokenId, targetBestAsk, shares, {
      orderType: "taker",
      note: `ChainlinkSnipe ${chainlinkSaysUp ? "UP" : "DOWN"} @ ${(targetBestAsk * 100).toFixed(1)}¢, strike=${this.strikePrice.toFixed(2)}, now=${currentChainlink.toFixed(2)} (${chainlinkConfidenceBps.toFixed(0)}bps), est=$${expectedProfit.toFixed(2)}`,
      signalSource: "chainlink_sniper",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.lastMarketTokens = "";
    this.candleEntries = 0;
    this.strikePrice = null;
    this.currentMarketSymbol = "";
  }
}
