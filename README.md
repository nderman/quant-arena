# Quant Farm — Evolutionary Arena for Polymarket

A Node.js/TypeScript simulation arena where trading engines compete on Polymarket crypto markets. High-fidelity referee with the 2026 dynamic parabolic fee model, latency injection, and toxic flow simulation.

## Architecture

```
quant-farm/
├── src/
│   ├── arena.ts          # Main run loop — 6h rounds, engine competition, round_intel.json
│   ├── referee.ts        # Fee model, latency, toxic flow, fill simulation
│   ├── pulse.ts          # Data feeds: PM CLOB WS + Binance L2 + simulated mode
│   ├── signals.ts        # Free signal sources: Fear/Greed, funding, DVOL, realized vol
│   ├── discovery.ts      # Auto-discover active crypto markets via Gamma API
│   ├── ledger.ts         # SQLite trade ledger (FeePaid, LatencySlippage, SignalSource)
│   ├── config.ts         # Environment-driven configuration
│   ├── types.ts          # Shared type definitions
│   ├── engines/
│   │   ├── BaseEngine.ts         # Abstract base — feeAdjustedEdge(), cheapestExit(), action builders
│   │   ├── MeanRevertEngine.ts   # Example: mean reversion, fee-aware entry/exit
│   │   └── EdgeSniperEngine.ts   # Example: trades only in low-fee zone (edges)
│   └── tests/
│       └── unitTests.ts          # 14 tests: fee model, symmetry, edge calc, merge vs sell
├── data/
│   ├── ledger.db                 # SQLite (auto-created on first run)
│   └── round_intel.json          # Leader spy file — agents read this between rounds
├── engines/                      # User engine directory (configurable via ENGINES_DIR)
├── package.json
└── tsconfig.json
```

## Quick Start

```bash
npm install
npm run build              # TypeScript compile
npm run test:unit          # 14 tests — fee model validation
```

## Running the Arena

### Simulated (offline, no APIs)
```bash
npm run arena:dry                    # Infinite rounds, simulated random-walk data
npm run arena:1round:dry             # Single 1-min round with fast ticks (testing)
```

### Live Data (read-only, no Polymarket auth needed)
```bash
npm run arena:live                   # Auto-discovers most liquid crypto market
PM_CONDITION_ID="0x..." npm run arena  # Specify a market manually
```

### Custom Configuration
```bash
ROUND_DURATION_MS=3600000 \          # 1h rounds instead of 6h
TICK_INTERVAL_MS=1000 \              # 1s ticks instead of 5s
STARTING_CASH=5000 \                 # $5000 per engine instead of $1000
MAX_ROUNDS=10 \                      # Stop after 10 rounds
npm run arena
```

### Utilities
```bash
npm run discover           # Find active crypto markets on Polymarket
npm run signals            # Test all signal sources (Fear/Greed, funding, DVOL, vol)
npm run pulse:test         # Test WebSocket data feeds
```

## The Parabolic Fee Model

Polymarket's 2026 dynamic fee for crypto markets:

```
fee = amount × 0.018 × 4 × P × (1 − P)
```

| Price | Fee %  | Fee on $100 | Interpretation |
|-------|--------|-------------|----------------|
| 0.01  | 0.07%  | $0.07       | Near-zero — edges are cheap |
| 0.10  | 0.65%  | $0.65       | Low |
| 0.30  | 1.51%  | $1.51       | Getting expensive |
| 0.50  | 1.80%  | $1.80       | **Maximum** — kills most edges |
| 0.70  | 1.51%  | $1.51       | Getting expensive |
| 0.90  | 0.65%  | $0.65       | Low |
| 0.99  | 0.07%  | $0.07       | Near-zero — edges are cheap |

**MERGE** bypasses the parabolic fee entirely — flat 0.1% gas offset. At mid-prices, merging YES+NO is often cheaper than selling.

## Referee Simulation

Every engine action goes through the referee before it "fills":

1. **Latency Injection** — 300ms delay (configurable via `LATENCY_MS`)
2. **Toxic Flow Check** — After delay, 15% chance the price moved against you. Buys fill at the worse price; sells get sniped. Simulates HFT adverse selection.
3. **Parabolic Fee** — Deducted from proceeds (BUY/SELL). MERGE uses flat 0.1%.
4. **State Update** — Cash, positions, P&L all tracked per-engine.

### Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `PEAK_FEE_RATE` | 0.018 | Crypto peak fee rate (1.8%) |
| `LATENCY_MS` | 300 | Simulated fill delay |
| `MERGE_FEE_RATE` | 0.001 | Flat merge gas offset (0.1%) |
| `TOXIC_FLOW_ENABLED` | true | Enable adverse selection simulation |
| `TOXIC_FLOW_PROBABILITY` | 0.15 | Chance of toxic fill per trade |
| `TOXIC_FLOW_BPS` | 50 | Adverse move magnitude (basis points) |

## Signal Sources

All free, no API keys required. Fetched every 60s and passed to `engine.onTick(tick, state, signals)`.

| Source | API | What it provides | Use case |
|--------|-----|------------------|----------|
| **Fear & Greed** | alternative.me | 0-100 sentiment (Extreme Fear → Extreme Greed) | Contrarian signal |
| **Binance Funding** | fapi.binance.com | 8h perp funding rate + direction | Overcrowding detection |
| **Deribit DVOL** | deribit.com | Annualized implied vol (BTC/ETH options) | Expected move size |
| **Binance Klines** | api.binance.com | Realized vol at 5m/1h/1d timeframes | Volatility regime |
| **Binance Spot** | api.binance.com | Current BTC/ETH/SOL price | Reference price |

### Interpreting Signals

```
Fear & Greed:
  0-24: Extreme Fear → contrarian BUY signal
  75-100: Extreme Greed → contrarian SELL signal

Funding Rate:
  > 0.01%: Longs overcrowded → fade longs
  < -0.01%: Shorts overcrowded → fade shorts

DVOL:
  > 80: High vol → wider ranges, bigger moves
  < 40: Low vol → compression, breakout likely
```

## Market Discovery

The arena auto-discovers active markets if `PM_CONDITION_ID` is not set:

```bash
npm run discover     # Lists active crypto + up/down markets
```

Searches Polymarket's Gamma API for:
- **Crypto price markets** — "Will BTC be above $X?"
- **Up/Down markets** — 1H, 4H, daily candle markets (high-frequency)

Sorted by liquidity. The arena picks the most liquid market automatically.

## Writing an Engine

Create a file in `src/engines/` (auto-loaded) or `./engines/` (user directory):

```typescript
import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

export class MyEngine extends AbstractEngine {
  id = "my-engine-v1";
  name = "My Engine";
  version = "1.0.0";

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    // CRITICAL: Always check fee-adjusted edge before trading
    const modelProb = 0.60;  // your model's probability
    const edge = this.feeAdjustedEdge(modelProb, tick.midPrice);

    if (!edge.profitable) return [];  // fee eats the edge — skip

    // Check cheapest exit method
    const exit = this.cheapestExit(tick.midPrice, 100);
    // exit.method === "MERGE" at mid-prices, "SELL" at edges

    // Use signals for conviction
    if (signals?.fearGreed && signals.fearGreed.value < 25) {
      // Extreme fear — boost confidence
    }

    // Action builders
    return [this.buy("token-id", tick.bestAsk, 50, {
      note: `edge=${edge.netEdge.toFixed(4)}`,
      signalSource: "my_signal",
    })];
  }
}
```

### BaseEngine Helpers

| Method | Description |
|--------|-------------|
| `feeAdjustedEdge(modelProb, marketPrice)` | Is this trade profitable after the P(1-P) fee? |
| `cheapestExit(price, shares)` | Should I SELL or MERGE to exit? |
| `getPosition(tokenId)` | Current position in a token |
| `portfolioValue(price)` | Cash + mark-to-market |
| `buy(token, price, size, opts?)` | Build a BUY action |
| `sell(token, price, size, opts?)` | Build a SELL action |
| `merge(token, amount, opts?)` | Build a MERGE action (bypasses parabolic fee) |
| `hold()` | No-op action |

### Engine Actions

| Action | Fee | Description |
|--------|-----|-------------|
| `BUY` | Parabolic | Buy outcome shares — fee = `amount × 0.018 × 4 × P(1-P)` |
| `SELL` | Parabolic | Sell outcome shares — same fee curve |
| `MERGE` | Flat 0.1% | Buy YES+NO, merge for $1.00 — bypasses parabolic fee |
| `HOLD` | None | Do nothing |

## Round Intel (Spy File)

After each round, `data/round_intel.json` is written with the leader's stats:

```json
{
  "roundId": "R0001-1712345678",
  "leaderEngineId": "edge-sniper-v1",
  "leaderPnl": 12.45,
  "leaderTradeCount": 8,
  "leaderAvgFee": 0.0034,
  "leaderStrategy": "edge-sniper-v1: 8 trades, 60% win, $0.0272 fees",
  "allResults": [...]
}
```

Engines can read this file between rounds to adapt strategy (evolutionary pressure).

## Ledger (SQLite)

All trades logged to `data/ledger.db` with:

| Column | Description |
|--------|-------------|
| `round_id` | Which round |
| `engine_id` | Which engine |
| `action` | BUY/SELL/MERGE |
| `price` | Actual fill price |
| `fee` | Parabolic or merge fee paid |
| `slippage` | Price slippage from toxic flow |
| `signal_source` | What triggered the trade |
| `toxic_flow` | 1 if adversely selected |
| `latency_ms` | Simulated fill delay |

Query with any SQLite tool:
```sql
SELECT engine_id, SUM(pnl) as total_pnl, SUM(fee) as total_fees
FROM trades GROUP BY engine_id ORDER BY total_pnl DESC;
```

## All Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ROUND_DURATION_MS` | 21600000 (6h) | Round duration |
| `STARTING_CASH` | 1000 | USDC per engine per round |
| `TICK_INTERVAL_MS` | 5000 | Tick frequency |
| `MAX_ROUNDS` | 0 (infinite) | Stop after N rounds |
| `DRY_RUN` | false | Use simulated data |
| `ENGINES_DIR` | ./engines | User engine directory |
| `PEAK_FEE_RATE` | 0.018 | Parabolic fee peak |
| `LATENCY_MS` | 300 | Fill delay |
| `MERGE_FEE_RATE` | 0.001 | Flat merge fee |
| `TOXIC_FLOW_ENABLED` | true | Adverse selection |
| `TOXIC_FLOW_PROBABILITY` | 0.15 | Toxic flow chance |
| `TOXIC_FLOW_BPS` | 50 | Adverse move size |
| `PM_WS_URL` | wss://...polymarket.com | PM WebSocket |
| `PM_CONDITION_ID` | (auto-discover) | Market to track |
| `BINANCE_WS_URL` | wss://...binance.com | Binance WebSocket |
| `BINANCE_SYMBOL` | btcusdt | Binance pair |
| `LEDGER_DB_PATH` | ./data/ledger.db | SQLite path |
| `ROUND_INTEL_PATH` | ./data/round_intel.json | Intel output |
| `LOG_LEVEL` | info | Logging verbosity |

## Key Insight

The parabolic fee is the final boss. At P=0.50, the house takes 1.8% — most edges evaporate. Winning engines either:

1. **Trade at the edges** (P > 0.85 or P < 0.15) where fees are < 0.65%
2. **Use MERGE** to exit positions at mid-prices (0.1% vs 1.8%)
3. **Have massive edge** (> 2%) to overcome the fee at any price

The `feeAdjustedEdge()` calculator on `BaseEngine` is the gatekeeper. Call it before every trade.
