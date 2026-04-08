/**
 * Quant Farm — Shared Types
 *
 * Evolutionary arena for Polymarket strategy bots.
 * All engines, the referee, and the arena share these types.
 */

// ── Market Data ─────────────────────────────────────────────────────────────

export interface L2Level {
  price: number;
  size: number;
}

export interface OrderBook {
  bids: L2Level[];  // descending by price
  asks: L2Level[];  // ascending by price
  timestamp: number;
}

export interface MarketTick {
  source: "polymarket" | "binance";
  symbol: string;       // e.g. "BTC-USD-5min" or "BTCUSDT"
  tokenSide?: "UP" | "DOWN"; // which token this tick is for (PM only)
  midPrice: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  distanceFrom50: number; // |price - 0.50| — fee regime indicator
  book: OrderBook;
  timestamp: number;
}

// ── Engine Interface ────────────────────────────────────────────────────────

export type ActionSide = "BUY" | "SELL" | "HOLD" | "MERGE";
export type OrderType = "maker" | "taker";

export interface EngineAction {
  side: ActionSide;
  tokenId: string;      // which outcome token
  price: number;        // limit price (0..1 for PM, spot for Binance)
  size: number;         // shares or USDC amount
  orderType?: OrderType; // maker = limit order (0% fee + rebate), taker = market order (parabolic fee)
  note?: string;        // engine's rationale
  signalSource?: string; // what triggered this (e.g. "binance_momentum", "mean_revert")
}

export interface FeeAdjustedEdge {
  rawEdge: number;       // model prob - market price
  feeAtPrice: number;    // parabolic fee at current price
  netEdge: number;       // rawEdge - feeAtPrice (per dollar)
  profitable: boolean;   // netEdge > 0
  breakeven: number;     // minimum edge needed to overcome fee
}

export interface EngineState {
  engineId: string;
  positions: Map<string, PositionState>;
  cashBalance: number;
  roundPnl: number;
  tradeCount: number;
  feePaid: number;
  feeRebate: number;       // maker rebate earned (20% of taker fees in market)
  slippageCost: number;
  activeTokenId: string;    // current market's UP (YES) token ID (set by arena on rotation)
  activeDownTokenId: string; // current market's DOWN (NO) token ID
  expiringTokenIds: Map<string, string>; // old tokenId → its paired opposite tokenId (for correct MERGE pricing)
  // Market context (set by arena on rotation)
  marketSymbol: string;      // e.g. "BTCUSDT", "ETHUSDT"
  marketWindowEnd: number;   // epoch ms when 5-min window closes
  marketWindowStart: number; // epoch ms when 5-min window opened
}

export interface PositionState {
  tokenId: string;
  side: "YES" | "NO";
  shares: number;
  avgEntry: number;
  costBasis: number;
}

export interface SignalSnapshot {
  timestamp: number;
  fearGreed: { value: number; label: string; timestamp: number } | null;
  funding: { symbol: string; rate: number; annualized: number; direction: "long" | "short" | "neutral" } | null;
  impliedVol: { currency: string; dvol: number; timestamp: number } | null;
  realizedVol: { symbol: string; vol5m: number; vol1h: number; vol1d: number } | null;
  binancePrice: number | null;
}

export interface BaseEngine {
  id: string;
  name: string;
  version: string;

  /** Called once at round start with initial state */
  init(state: EngineState): void;

  /** Called on every market tick — return actions or empty array */
  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[];

  /** Called at round end for cleanup */
  onRoundEnd(state: EngineState): void;
}

// ── Referee Types ───────────────────────────────────────────────────────────

export interface FillResult {
  action: EngineAction;
  filled: boolean;
  fillPrice: number;      // actual fill price (may differ due to toxic flow)
  fillSize: number;
  fee: number;
  rebate: number;          // maker rebate earned (0 for takers)
  slippage: number;        // fillPrice - action.price
  pnl: number;             // realized P&L (non-zero only for SELL)
  latencyMs: number;
  toxicFlowHit: boolean;   // price moved against us during latency window
  orderType: OrderType;    // maker or taker
}

export interface RefereeConfig {
  peakFeeRate: number;          // 0.018 for crypto 2026
  latencyMs: number;            // 300ms default
  mergeFeeRate: number;         // 0.001 flat gas offset
  enableToxicFlow: boolean;     // simulate adverse selection
  toxicFlowProbability: number; // chance of adverse move during latency
  toxicFlowBps: number;         // magnitude of adverse move in basis points
}

// ── Ledger Types ────────────────────────────────────────────────────────────

export interface LedgerRow {
  id: number;
  roundId: string;
  engineId: string;
  timestamp: string;
  action: ActionSide;
  tokenId: string;
  price: number;
  size: number;
  fee: number;
  slippage: number;
  pnl: number;
  cashAfter: number;
  signalSource: string;
  note: string;
}

// ── Arena / Round Types ─────────────────────────────────────────────────────

export interface RoundResult {
  roundId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  results: EngineRoundResult[];
}

export interface EngineRoundResult {
  engineId: string;
  finalCash: number;
  positionValue: number;  // mark-to-market of open positions
  totalPnl: number;       // cash + position value - starting cash
  tradeCount: number;
  feePaid: number;
  slippageCost: number;
  winRate: number;
  sharpeRatio: number;    // annualized
}

export interface RoundIntel {
  roundId: string;
  leaderEngineId: string;
  leaderPnl: number;
  leaderTradeCount: number;
  leaderAvgFee: number;
  leaderStrategy: string; // summary from engine notes
  allResults: EngineRoundResult[];
}
