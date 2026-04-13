/**
 * Quant Farm — Base Engine
 *
 * Abstract base class for all arena engines.
 * Provides:
 *   - Fee-Adjusted Edge calculator (the critical pre-trade check)
 *   - Position helpers
 *   - State accessors
 *
 * Engines extend this and implement onTick() with their strategy.
 */

import { calculateFeeAdjustedEdge, cheaperExit } from "../referee";
import { getBookForToken } from "../pulse";
import type {
  BaseEngine as IBaseEngine,
  EngineAction,
  EngineState,
  MarketTick,
  SignalSnapshot,
  FeeAdjustedEdge,
  PositionState,
} from "../types";

export abstract class AbstractEngine implements IBaseEngine {
  abstract id: string;
  abstract name: string;
  abstract version: string;

  protected state!: EngineState;

  init(state: EngineState): void {
    this.state = state;
  }

  abstract onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[];

  onRoundEnd(_state: EngineState): void {
    // Override in subclass for cleanup
  }

  // ── Fee-Aware Helpers ────────────────────────────────────────────────────

  /**
   * Calculate if a trade is profitable AFTER the parabolic fee.
   *
   * This is THE critical function. A bot that ignores this will bleed out
   * at mid-prices where the fee is 1.8%.
   *
   * Usage:
   *   const edge = this.feeAdjustedEdge(0.65, 0.50);
   *   if (!edge.profitable) return []; // skip — fee eats the edge
   */
  protected feeAdjustedEdge(modelProb: number, marketPrice: number): FeeAdjustedEdge {
    return calculateFeeAdjustedEdge(modelProb, marketPrice);
  }

  /**
   * Determine the cheapest way to exit a position. Only recommends MERGE if
   * the engine actually holds enough opposite-side shares for a Flavor A
   * merge — Flavor B (buy opposite + merge) is no longer supported by the
   * referee. Engines that want a Flavor B-style merge must explicitly emit
   * a BUY for the opposite side first, then call MERGE on a subsequent tick.
   */
  protected cheapestExit(price: number, shares: number, tokenId?: string) {
    const pos = tokenId ? this.state.positions.get(tokenId) : undefined;
    const isDown = pos ? pos.side === "NO" : false;
    const oppositeTokenId = isDown ? this.getUpTokenId() : this.getDownTokenId();
    const oppositePos = oppositeTokenId ? this.state.positions.get(oppositeTokenId) : undefined;
    const holdsOpposite = !!(oppositePos && oppositePos.shares >= shares);
    return cheaperExit(price, shares, holdsOpposite);
  }

  // ── Position Helpers ─────────────────────────────────────────────────────

  protected getPosition(tokenId: string): PositionState | undefined {
    return this.state.positions.get(tokenId);
  }

  protected hasPosition(tokenId: string): boolean {
    return this.state.positions.has(tokenId);
  }

  protected totalPositionValue(_currentPrice?: number): number {
    let value = 0;
    for (const [tokenId, pos] of this.state.positions) {
      const book = getBookForToken(tokenId);
      const bestBid = book.bids[0]?.price;
      value += pos.shares * (bestBid && bestBid > 0 ? bestBid : pos.avgEntry);
    }
    return value;
  }

  protected portfolioValue(currentPrice: number): number {
    return this.state.cashBalance + this.totalPositionValue(currentPrice);
  }

  // ── Pending-Order Guard ──────────────────────────────────────────────────
  // Prevents pyramiding during the ~50ms fill latency window: between
  // emitting a BUY and seeing the fill in state.positions, onTick fires
  // multiple times. This Set tracks in-flight tokens and auto-clears on
  // fill confirmation or market rotation.

  private _pendingTokens = new Set<string>();
  private _lastMarketKey = "";

  protected hasPendingOrder(): boolean {
    return this._pendingTokens.size > 0;
  }

  protected markPending(tokenId: string): void {
    this._pendingTokens.add(tokenId);
  }

  /** Call at the start of onTick (after source filter). Clears on rotation, removes filled. Returns true if market rotated. */
  protected updatePendingOrders(): boolean {
    const marketKey = `${this.getUpTokenId()}:${this.getDownTokenId()}`;
    let rotated = false;
    if (marketKey !== this._lastMarketKey) {
      this._pendingTokens.clear();
      this._lastMarketKey = marketKey;
      rotated = true;
    }
    for (const t of [...this._pendingTokens]) {
      const pos = this.getPosition(t);
      if (pos && pos.shares > 0) this._pendingTokens.delete(t);
    }
    return rotated;
  }

  protected clearPendingOrders(): void {
    this._pendingTokens.clear();
    this._lastMarketKey = "";
  }

  // ── Regime Signals ──────────────────────────────────────────────────────
  // Track Binance price history so engines can compute realized vol and
  // momentum without each maintaining their own buffer. Fed automatically
  // whenever the engine sees a Binance tick — call `trackBinance(tick)` at
  // the start of onTick() (before the source filter) to enable.

  private _binancePrices: { price: number; time: number }[] = [];
  private readonly _binanceMaxSamples = 120; // ~2 minutes @ 1 sample/sec

  /**
   * Call from onTick() before your source filter. Records Binance ticks
   * into a bounded rolling window. Safe to call on non-Binance ticks
   * (it's a no-op).
   */
  protected trackBinance(tick: MarketTick): void {
    if (tick.source !== "binance") return;
    this._binancePrices.push({ price: tick.midPrice, time: Date.now() });
    if (this._binancePrices.length > this._binanceMaxSamples) {
      this._binancePrices.shift();
    }
  }

  /** Most recent Binance price, or 0 if none seen yet. */
  protected lastBinancePrice(): number {
    const n = this._binancePrices.length;
    return n > 0 ? this._binancePrices[n - 1].price : 0;
  }

  /**
   * Realized vol over the last `lookbackSec` seconds as stddev of 1-sample
   * log returns (proportional, not annualized). Returns 0 if insufficient data.
   * Typical BTC 5-min vol is 1-5 bps per tick (~0.0001-0.0005); use >0.0005
   * as a "high vol / trending" threshold.
   */
  protected realizedVol(lookbackSec: number = 60): number {
    const cutoff = Date.now() - lookbackSec * 1000;
    const samples = this._binancePrices.filter(s => s.time >= cutoff);
    if (samples.length < 3) return 0;
    const returns: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      const prev = samples[i - 1].price;
      const curr = samples[i].price;
      if (prev > 0) returns.push((curr - prev) / prev);
    }
    if (returns.length === 0) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
    return Math.sqrt(variance);
  }

  /**
   * Recent momentum: fractional return from `lookbackSec` seconds ago to now.
   * Positive = price up, negative = price down. Returns 0 if insufficient data.
   * Example: 0.001 = +0.1% move, -0.002 = -0.2% move.
   */
  protected recentMomentum(lookbackSec: number = 60): number {
    if (this._binancePrices.length === 0) return 0;
    const cutoff = Date.now() - lookbackSec * 1000;
    const latest = this._binancePrices[this._binancePrices.length - 1];
    // Find the oldest sample at or after the cutoff
    let oldest = this._binancePrices[0];
    for (const s of this._binancePrices) {
      if (s.time >= cutoff) { oldest = s; break; }
    }
    if (oldest.price <= 0 || oldest === latest) return 0;
    return (latest.price - oldest.price) / oldest.price;
  }

  /**
   * Absolute momentum — useful for "is anything happening" gates without
   * caring about direction. Equivalent to `Math.abs(recentMomentum())`.
   */
  protected absMomentum(lookbackSec: number = 60): number {
    return Math.abs(this.recentMomentum(lookbackSec));
  }

  /**
   * Coarse regime label based on the last 60s of Binance. Values:
   *   - "QUIET"  : realizedVol < 2 bps, abs momentum < 0.05%
   *   - "CHOP"   : vol between 2-8 bps, low momentum
   *   - "TREND"  : abs momentum >= 0.10% over 60s
   *   - "SPIKE"  : realizedVol >= 15 bps
   * Returns "QUIET" when insufficient data.
   */
  protected currentRegime(): "QUIET" | "CHOP" | "TREND" | "SPIKE" {
    const vol = this.realizedVol(60);
    const mom = this.absMomentum(60);
    if (vol >= 0.0015) return "SPIKE";
    if (mom >= 0.0010) return "TREND";
    if (vol >= 0.0002) return "CHOP";
    return "QUIET";
  }

  // ── Token Helpers ────────────────────────────────────────────────────────

  /** Get the DOWN (NO) token ID for the current market */
  protected getDownTokenId(): string {
    return this.state.activeDownTokenId || "";
  }

  /** Get the UP (YES) token ID for the current market */
  protected getUpTokenId(): string {
    return this.state.activeTokenId || "";
  }

  /** Get the Binance symbol for the current market (e.g. "BTCUSDT") */
  protected getMarketSymbol(): string {
    return this.state.marketSymbol || "";
  }

  /**
   * Get the latest Chainlink price for the current arena's coin (from Polygon
   * RPC). This is the same data Polymarket uses to resolve 5M markets — engine
   * decisions based on this align with eventual settlement.
   * Returns null if Chainlink is unavailable or stale (>2min old).
   */
  protected getChainlinkPrice(symbol?: string): number | null {
    // Fallback to the arena's configured Binance symbol — NOT a hardcoded
    // BTCUSDT, which would be wrong on ETH/SOL arena processes.
    const { CONFIG } = require("../config");
    const sym = symbol || this.getMarketSymbol() || CONFIG.ARENA_BINANCE_SYMBOL;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getLatestChainlinkPrice } = require("../chainlink");
    return getLatestChainlinkPrice(sym);
  }

  /** Seconds remaining in the current 5-minute market window. Returns -1 if unknown. */
  protected getSecondsRemaining(): number {
    if (!this.state.marketWindowEnd) return -1;
    return Math.max(0, Math.round((this.state.marketWindowEnd - Date.now()) / 1000));
  }

  /** Epoch ms when the current 5-minute window started */
  protected getWindowStart(): number {
    return this.state.marketWindowStart || 0;
  }

  /** Epoch ms when the current 5-minute window ends */
  protected getWindowEnd(): number {
    return this.state.marketWindowEnd || 0;
  }

  // ── Action Builders ──────────────────────────────────────────────────────

  protected buy(tokenId: string, price: number, size: number, opts?: {
    note?: string; signalSource?: string; orderType?: "maker" | "taker";
  }): EngineAction {
    return {
      side: "BUY",
      tokenId,
      price,
      size,
      orderType: opts?.orderType,
      note: opts?.note,
      signalSource: opts?.signalSource,
    };
  }

  protected sell(tokenId: string, price: number, size: number, opts?: {
    note?: string; signalSource?: string; orderType?: "maker" | "taker";
  }): EngineAction {
    return {
      side: "SELL",
      tokenId,
      price,
      size,
      orderType: opts?.orderType,
      note: opts?.note,
      signalSource: opts?.signalSource,
    };
  }

  protected merge(tokenId: string, amount: number, opts?: {
    note?: string; signalSource?: string;
  }): EngineAction {
    return {
      side: "MERGE",
      tokenId,
      price: 1.0,
      size: amount,
      note: opts?.note,
      signalSource: opts?.signalSource ?? "merge_exit",
    };
  }

  protected hold(): EngineAction {
    return { side: "HOLD", tokenId: "", price: 0, size: 0 };
  }
}
