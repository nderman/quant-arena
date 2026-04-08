# Quant Farm — Claude Code Instructions

## What This Is
Evolutionary arena for Polymarket 5M crypto binary markets. AI-bred engines compete in 6-hour rounds with a high-fidelity referee: dual orderbooks, parabolic fees, latency, toxic flow, fill decay, and oracle noise.

## Key Commands
- `npm run arena:dry` — simulated data, no APIs
- `npm run arena:live` — live PM + Binance data (auto-discovers markets)
- `npm run arena:1round:dry` — quick test (1 min round)
- `npm run test:unit` — 15 tests, must all pass
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
- `data/ledger.db` — SQLite (auto-created)
- `data/round_intel.json` — leader spy file

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
- MERGE: buy opposite side at real book price + dynamic gas (contract itself is free)
- Makers: 0% fee + 20% rebate of taker fees, 60% fill probability, 5bps adverse selection
- Tick size: $0.001, Latency: 50ms (realistic API lag, no artificial delay)

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
- PM2: quant-arena, quant-breeder, quant-telegram
- Deploy excludes BredEngine_* files (preserved on VPS)

## Config
All via environment variables. Key:
`PEAK_FEE_RATE`, `LATENCY_MS`, `TOXIC_FLOW_ENABLED`, `PM_CONDITION_ID`, `BINANCE_SYMBOL`,
`GAS_COST_USD`, `GAS_VOL_MULTIPLIER`, `ORACLE_NOISE_BPS`, `MAKER_FILL_PROBABILITY`.
