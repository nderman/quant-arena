# Quant Farm — Claude Code Instructions

## What This Is
Evolutionary arena for Polymarket crypto trading bots. Engines compete in 6-hour rounds with a high-fidelity referee that simulates the 2026 parabolic fee model, latency, and toxic flow.

## Key Commands
- `npm run arena:dry` — simulated data, no APIs
- `npm run arena:live` — live PM + Binance data (auto-discovers markets)
- `npm run arena:1round:dry` — quick test (1 min round)
- `npm run test:unit` — 14 tests, must all pass
- `npm run build` — TypeScript compile
- `npm run discover` — list active crypto markets
- `npm run signals` — test all signal sources

## Architecture
- `src/arena.ts` — main loop, loads engines, runs rounds
- `src/referee.ts` — fee model, latency, toxic flow simulation
- `src/pulse.ts` — WebSocket data feeds (PM + Binance + simulated)
- `src/signals.ts` — Fear/Greed, funding rate, DVOL, realized vol
- `src/discovery.ts` — Gamma API market discovery
- `src/ledger.ts` — SQLite trade ledger
- `src/engines/BaseEngine.ts` — abstract base class with fee-adjusted edge
- `src/engines/*.ts` — concrete engine implementations
- `data/ledger.db` — SQLite (auto-created)
- `data/round_intel.json` — leader spy file

## The Fee Model (Critical)
```
fee = amount × 0.018 × 4 × P × (1 − P)
```
- At P=0.50: 1.8% (maximum — kills most edges)
- At P=0.90: 0.65% (manageable)
- At P=0.99: 0.07% (near zero)
- MERGE: flat 0.1% (bypasses parabolic entirely)

## Rules
- Every engine must call `feeAdjustedEdge()` before trading
- Never trade at mid-prices without > 2% raw edge
- MERGE is cheaper than SELL when P is between ~0.15 and ~0.95
- All signal sources are free, no API keys needed
- Engines auto-load from `src/engines/` — just extend `AbstractEngine`
- Tests must pass before any deploy: `npm run test:unit`

## Config
All via environment variables — see README.md for full list.
Key: `PEAK_FEE_RATE`, `LATENCY_MS`, `TOXIC_FLOW_ENABLED`, `PM_CONDITION_ID`, `BINANCE_SYMBOL`.
