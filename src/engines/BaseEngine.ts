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
