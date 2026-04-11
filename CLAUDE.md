# Quant Farm — Claude Code Instructions

## What This Is
Evolutionary arena for Polymarket 5M crypto binary markets. AI-bred engines compete in 1-hour rounds with a high-fidelity referee: dual orderbooks, quartic fees, latency, toxic flow, fill decay, oracle noise, and on-chain merge latency.

**Multi-coin:** BTC, ETH, SOL each run their own arena + breeder process. Telegram is shared.

## Key Commands
- `npm run arena:dry` — simulated data, no APIs
- `npm run arena:live` — live PM + Binance data (auto-discovers markets)
- `npm run arena:1round:dry` — quick test (1 min round)
- `npm run test:unit` — 21 tests, must all pass
- `npm run build` — TypeScript compile
- `npm run discover` — list active crypto markets
- `npm run signals` — test all signal sources

## Architecture
- `src/arena.ts` — main loop, loads engines, runs rounds
- `src/referee.ts` — fee model, dual-book fills, latency, toxic flow, merge
- `src/pulse.ts` — WebSocket data feeds (PM dual books + Binance + simulated)
- `src/settlement.ts` — 5M market settlement with oracle purgatory
- `src/breeder.ts` — AI engine breeding (Gemini Flash analysis + Claude Sonnet code gen)
- `src/telegram.ts` — Telegram bot for phone monitoring
- `src/signals.ts` — Fear/Greed, funding rate, DVOL, realized vol
- `src/discovery.ts` — Gamma API market discovery (deterministic slug-based 5M)
- `src/ledger.ts` — SQLite trade ledger
- `src/engines/BaseEngine.ts` — abstract base class with fee-adjusted edge
- `src/engines/*.ts` — concrete engine implementations
- `data/ledger_<coin>.db` — SQLite per coin (auto-created)
- `data/round_intel_<coin>.json` — leader spy file per coin
- `data/round_history_<coin>.json` — completed round history per coin
- `data/last_breed_<coin>.json` — breeder data-gate marker

## Dual Orderbook Model (Critical)
UP and DOWN tokens have **independent orderbooks**. UP + DOWN ≠ $1.00.
The gap is where merge arb profit lives. The referee uses each token's real book — no price inversion.

## The Fee Model (Quartic, Apr 2026)
```
fee = amount × 0.25 × (P × (1 − P))²
```
- At P=0.50: 1.56% (maximum — kills most edges)
- At P=0.80: 0.64% (manageable)
- At P=0.90: 0.20% (edge trading sweet spot)
- At P=0.99: 0.003% (near zero)
- **MERGE: Flavor A only.** Engine must already hold BOTH sides of the same conditional pair before calling MERGE — referee burns both legs and credits $1/pair. Flavor B (buy opposite + merge atomically) was removed because it kept producing exploit paths. To emulate B, emit BUY for the opposite then MERGE on a subsequent tick.
- Makers: 0% fee + 20% rebate of taker fees, **12% fill probability** (was 60% — unrealistic vs HFT queue priority), 5bps adverse selection. **Post-Only enforced**: maker BUY rejects if `action.price >= bestAsk`; maker SELL rejects if `action.price <= bestBid`.
- Tick size: $0.001, Latency: 50ms (realistic API lag, no artificial delay)
- **Limit price enforcement**: `action.price` is the engine's max-acceptable BUY (or min-acceptable SELL). walkBook rejects fills that would breach the limit. No more "submit at $0.10, fill at $0.83" silent market-order behavior.
- **Per-tick book snapshots:** referee eagerly clones UP+DOWN books at snapshot creation (not lazy). Engines processed in the same tick share depletion (no ghost liquidity) and see the same moment-in-time state.
- **walkBook validity guards**: rejects walks where best price < $0.01 or > $0.99, where bid-ask spread > $0.50, where book is one-sided, or where book.timestamp > 30s old. Catches stale/empty/corrupted data.
- **Settlement** writes a `SETTLE` row to the trades table with the true payout pnl, so `SUM(pnl)` is honest
- **Phantom alpha detector**: arena.runRound flags any engine with > $500 single-round PnL (impossible from $50 starting cash) as a likely sim bug.

## Rules
- Every engine must call `feeAdjustedEdge()` before trading
- Never trade at mid-prices without > 2% raw edge
- Use `cheapestExit(price, shares, tokenId)` to compare SELL vs MERGE with real book prices
- TokenId must match active market (referee rejects fabricated tokens)
- Must hold ≥ 5 shares to sell (CLOB), ≥ 1 share to merge (on-chain)
- Engines auto-load from `src/engines/` — just extend `AbstractEngine`
- Tests must pass before any deploy: `npm run test:unit`

## Deploy
```bash
bash scripts/deploy.sh  # rsync to VPS, rebuild, PM2 restart
```
- VPS: 165.22.29.245 (DigitalOcean)
- PM2 processes (7 total): `quant-arena-{btc,eth,sol}`, `quant-breeder-{btc,eth,sol}`, `quant-telegram`
- Deploy excludes BredEngine_* files and `data/` (preserved on VPS)

## Config
All via environment variables. Key:
`PEAK_FEE_RATE`, `LATENCY_MS`, `TOXIC_FLOW_ENABLED`, `PM_CONDITION_ID`, `BINANCE_SYMBOL`,
`GAS_COST_USD`, `GAS_VOL_MULTIPLIER`, `ORACLE_NOISE_BPS`, `MAKER_FILL_PROBABILITY`,
`ARENA_COIN` (per-process), `ARENA_INSTANCE_ID`, `BREED_INTERVAL_HOURS`, `MIN_NEW_ROUNDS_TO_BREED`, `CODER_MODEL`.

## Breeder
- Default `CODER_MODEL=anthropic/claude-haiku-4-5` (cheap; override to `claude-sonnet-4-5` for richer codegen)
- Loop cadence: 6h per coin (`BREED_INTERVAL_HOURS`)
- Data gate: skip cycle unless `MIN_NEW_ROUNDS_TO_BREED` (default 3) new rounds since last successful breed
- Bred engines load on next natural arena restart (breeder no longer auto-restarts pm2)
