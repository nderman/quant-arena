import { AbstractEngine } from "./BaseEngine";
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

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    // Detect candle rotation — capture the strike price at the new window's start
    const currentTokens = `${upTokenId}:${downTokenId}`;
    if (currentTokens !== this.lastMarketTokens) {
      this.lastMarketTokens = currentTokens;
      this.candleEntries = 0;
      this.currentMarketSymbol = this.getMarketSymbol();
      // Capture strike at window start (current Chainlink price = the level
      // the market is asking about). This locks in the reference for the
      // entire candle — for "BTC up in next 5min" markets, this is the
      // price BTC must beat to resolve UP.
      this.strikePrice = this.getChainlinkPrice(this.currentMarketSymbol);
    }

    if (this.candleEntries >= this.maxEntriesPerCandle) return [];

    const secsLeft = this.getSecondsRemaining();
    if (secsLeft < 0 || secsLeft > this.maxSecondsRemaining) return [];

    if (this.strikePrice === null) {
      // No strike captured (Chainlink unavailable at window start) — can't trade
      return [];
    }

    // Get fresh Chainlink price for the comparison
    const currentChainlink = this.getChainlinkPrice(this.currentMarketSymbol);
    if (currentChainlink === null) return [];

    // Determine which side Chainlink confirms
    const chainlinkSaysUp = currentChainlink > this.strikePrice;
    const chainlinkConfidenceBps = Math.abs((currentChainlink - this.strikePrice) / this.strikePrice) * 10000;
    // Need at least 5bps of separation to be confident — Chainlink reports in
    // small increments and a 0bps "match" is a coin flip
    if (chainlinkConfidenceBps < 5) return [];

    // PM mid for the UP side
    const upMid = tick.tokenSide === "UP" ? tick.midPrice : (1 - tick.midPrice);
    const downMid = 1 - upMid;
    const leadingPrice = chainlinkSaysUp ? upMid : downMid;
    if (leadingPrice < this.minLeadingPrice || leadingPrice >= this.maxLeadingPrice) return [];

    // Spread check on the side we're buying — read the live book
    const targetTokenId = chainlinkSaysUp ? upTokenId : downTokenId;
    const targetBestAsk = chainlinkSaysUp
      ? (tick.tokenSide === "UP" ? tick.bestAsk : (1 - tick.bestBid))
      : (tick.tokenSide === "DOWN" ? tick.bestAsk : (1 - tick.bestBid));
    const targetBestBid = chainlinkSaysUp
      ? (tick.tokenSide === "UP" ? tick.bestBid : (1 - tick.bestAsk))
      : (tick.tokenSide === "DOWN" ? tick.bestBid : (1 - tick.bestAsk));
    const spread = targetBestAsk - targetBestBid;
    if (spread <= 0 || spread > this.maxSpreadCents) return [];

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
