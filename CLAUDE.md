# Quant Farm — Claude Code Instructions

## What This Is
Evolutionary arena for Polymarket 5M crypto binary markets. AI-bred engines compete in 1-hour rounds with a high-fidelity referee: dual orderbooks, quartic fees, latency, toxic flow, fill decay, oracle noise, and on-chain merge latency.

**Multi-coin:** BTC, ETH, SOL each run their own arena + breeder process. Telegram is shared.

## Scripts catalog
**Before writing any one-off analysis script, check `scripts/README.md`.** It indexes every script with purpose, args, status, and known issues. Update it in the same PR when you add or change a script.

## Key Commands
- `npm run arena:dry` — simulated data, no APIs
- `npm run arena:live` — live PM + Binance data (auto-discovers markets)
- `npm run arena:1round:dry` — quick test (1 min round)
- `npm run test:unit` — 310 tests, must all pass
- `python3 scripts/auto_rotate.py` — dry-run engine roster selection (prints ranked candidates + diff). Add `--commit` to actually swap.
- `python3 scripts/livePnLByEngine.py` — per-engine PnL from data/live_trades.jsonl (FILL+SETTLE ledger). Add `--since 24h` for window.
- `python3 scripts/backfillLiveLedger.py --reset --write` — rebuild ledger from Polymarket Activity API + ROSTER_HISTORY (script-internal).
- `python3 scripts/syncManualTrades.py --write` — incrementally sync recent Activity API events into the ledger. Catches manual UI buys/sells + any forward-emit gaps. Wired on VPS as `*/10 * * * *`.

## Known operational issue: phantom-position silence

If wide variant (or any engine using `if (positions > 0) skip` self-gating) goes silent for >12h on a 4h arena, suspect **phantom positions stuck in liveArena state** because `pollLiveSettlements` is failing on Gamma API errors (returns HTML instead of JSON when rate-limited). The May 5 rehydration fix (arena-keyed settled tracking) handles this on RESTART but not at runtime.

Workaround: `pm2 restart quant-arena-<arena>`. Rehydration will skip settled tokens correctly.

Real fix pending (task #93): make liveSettlement use the local ledger's SETTLE rows as auth source for "this position is settled" instead of (or in addition to) Gamma polling.

Diagnostic (the lesson from May 4 — always check first, don't assume regime):
```bash
ssh root@VPS 'pm2 logs quant-arena-<arena> --lines 5000 --nostream --raw 2>&1 | grep -E "live snapshot|wide-v1: cash=.* positions="'
```
If `positions=N` for N>0 with no recent SETTLE → phantom. Restart unblocks.

## Safety Nets
- **Portfolio halt watcher** (`scripts/portfolioHaltWatcher.py`, cron `*/5 * * * *`): sums realized P&L from `data/live_trades.jsonl` over rolling `PORTFOLIO_HALT_LOOKBACK_HOURS` (default 12h). If loss exceeds `PORTFOLIO_HALT_LOSS_USD` (default $25), touches `data/live_halt.flag`. User must manually `rm` the flag to resume. Built after May 2 2026 incident (-$52 in 24h with no system-level circuit breaker).
- **Streak cull in auto_rotate**: any incumbent live engine with `STREAK_CULL_LOOKBACK` (default 5) consecutive sim losses gets auto-removed + 6h cooldown, regardless of aggregate sharpe. Prevents incumbent_bonus from holding declining engines.
- **Live halt flag** (`data/live_halt.flag`): if exists, liveArena/liveExecutor refuse new orders. Manual: `touch ~/quant-arena/data/live_halt.flag`.
- **Flat $$ ceiling on per-trade size** (`MAX_LIVE_TRADE_USD`, default $8): per-order USD capped at `min(bankroll × MAX_POSITION_PCT, MAX_LIVE_TRADE_USD)`. Prevents adverse-fill selection (polymarket-ai-bot lesson: stakes >$10 drop WR 75%→40%). Scale horizontally (more engines, more arenas) instead of vertically (bigger trades).
- **Trial gate on engine promotions** (`auto_rotate.py`, May 6): new engines run at `TRIAL_BANKROLL_USD` (default $5) for first `TRIAL_FIRE_COUNT` (default 5) settled live fires. After N: promote to full bankroll if net positive realized PnL, drop from candidates if net negative. Catches sim:live divergence at -$3 instead of -$13 like chop-fader did.
- **Engine-class haircut on auto_rotate scoring** (`auto_rotate.py CLASS_HAIRCUTS`, May 6): sim Sharpe multiplied by class confidence (1.0 momentum-settle, 0.6 vol-regime-gate / mid-price-hold, 0.3 maker-stack, 0.0 chop-fader). Live-validated engines (5+ positive settles) override class default with 1.0. Belt-and-braces with the `config/sim_unreliable.json` blacklist.
- **Ledger fallback for live settlement** (`liveSettlement.ts applyLedgerSettlements`, May 6): when Gamma API fails (returns HTML), pollLiveSettlements scans local `data/live_trades.jsonl` SETTLE rows to clear positions. Fixes the chronic phantom-position freeze where Gamma rate-limits → settlements never process → engine self-gates → silence.

## Auto-Rotation
Hourly cron on VPS at :05 runs `auto_rotate.py --commit`. Picks top SAFE engines by `recent_sharpe × regime_fit × incumbent_bonus × live_pnl_penalty` (compound penalty floored at 0.5×). Writes `data/live_engines.json`; `liveArena.ts` fs.watch picks up the new roster within 30s, no PM2 restart.

Manual override paths:
- Edit `data/live_engines.json` directly — file-watcher reloads, cron respects via auto-detected manual-cull cooldown.
- Touch `data/auto_rotation.disabled` — cron exits early.
- Edit `config/sim_unreliable.json` — `(engine, arena)` blacklist for engines whose sim score is known not to translate to live (e.g. extreme-price entries before May 2026 referee patch). Auto-rotate excludes from candidate pool. Versioned in git (unlike `data/` which is runtime-only).
- See `data/auto_rotation.log` for hourly decisions, `data/auto_rotation_cooldown.json` for active cooldowns.

`bankrollUsd` per engine is the **sizing basis** (scales sim positions to live), NOT a wallet allocation. All engines share the single PM funder wallet. Bump per-engine `bankrollUsd` when the wallet tops up.

## Live ledger
`data/live_trades.jsonl` — append-only log of FILL + SETTLE events tagged with engineId. `src/live/liveLedger.ts` exports `recordFill` (called from liveExecutor + liveReconcile), `recordSettle` (liveSettlement), and `rehydratePositionsFromLedger` (called from liveArena startup to restore in-memory positions across PM2 restarts — closes the chronic double-buy bug). All wire-points pass `coin` + `arenaInstanceId` from liveArena.

Read: `scripts/livePnLByEngine.py`. Historical backfill: `scripts/backfillLiveLedger.py`. Continuous sync (every 10 min, catches manual UI trades + emit gaps): `scripts/syncManualTrades.py` (cron). Dedup uses (slug, side, size, price) fingerprint since forward `clientOrderId` ≠ Activity API `transactionHash`.
- `npm run build` — TypeScript compile
- `npm run discover` — list active crypto markets
- `npm run signals` — test all signal sources
- `python3 scripts/engineSelectivity.py` — selectivity-aware leaderboard (mean PnL per firing round, firing win rate)
- `python3 scripts/engineCompare.py --prefix dca-` — head-to-head engine A/B comparison
- `python3 scripts/engineRegimeReport.py` — engine PnL cross-tabulated by regime

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
- Makers: 0% fee + 20% rebate of taker fees, 5bps adverse selection. **Post-Only enforced**: maker BUY rejects if `action.price >= bestAsk`; maker SELL rejects if `action.price <= bestBid`. All maker orders go straight to GTC FIFO queue (no instant-fill lottery).
- **GTC FIFO virtual queue**: Orders track `sharesAhead` (book depth at/above limit price on entry). Each tick: depth decreases advance queue by 50% (can't distinguish fills from cancellations), depth increases push us back (price jumpers). Order only fills when `sharesAhead <= 0`. At 5¢ with 10k shares queued, you wait until queue clears. At 50¢ with thin books, fills are fast.
- Tick size: $0.001, Latency: 50ms (realistic API lag, no artificial delay)
- **Limit price enforcement**: `action.price` is the engine's max-acceptable BUY (or min-acceptable SELL). walkBook rejects fills that would breach the limit. No more "submit at $0.10, fill at $0.83" silent market-order behavior.
- **Per-tick book snapshots:** referee eagerly clones UP+DOWN books at snapshot creation (not lazy). Engines processed in the same tick share depletion (no ghost liquidity) and see the same moment-in-time state.
- **walkBook validity guards** (via `isBookTradeable()`): rejects walks where best bid >= best ask (crossed book), best prices outside [`PM_PRICE_MIN`, `PM_PRICE_MAX`] inclusive (default 0.005-0.995), bid-ask spread > `PM_BOOK_MAX_SPREAD` (default $0.50), one-sided book, or stale book (> `PM_BOOK_STALE_MS`, default 30s). Engines can call `isBookTradeable(book)` directly to pre-check.
- **Ingestion-time PM book filtering** (`parsePmL2` + `isBookUpdateReasonable` in pulse.ts): drops invalid levels, rejects crossed books at parse time, filters transient quotes where best price jumps > `PM_BOOK_MAX_JUMP_FRACTION` (default 25%) in a single update. Catches PM's occasional bad/transient WS messages before they pollute our books.
- **Dual-book consistency check**: BUY/SELL actions reject when `thisToken_ask + oppositeToken_ask < CONFIG.DUAL_BOOK_MIN_SUM` (default $0.85). Real PM keeps the sum near $1.00; impossibly cheap sums indicate stale/corrupt book data on one side.
- **Snipe-stale-makers cancellation model**: taker BUY/SELL rejects with probability scaling on Binance momentum when the local PM book is stale relative to a recent move. Models real-world MM cancellation latency (~30-50ms). At default 5bps cumulative momentum over 5s + 100ms book staleness, rejection prob is ~50%; 10bps → ~95%. Configurable via `SNIPE_*` env vars.
- **Extreme-price adverse selection (May 2026, two layers)**:
  - **Layer 1 (fill cost)** in `simulateToxicFlow` (`referee.ts`): at `|fillPrice - 0.5| > EXTREME_PRICE_THRESHOLD` (0.30), amplifies toxic prob (+ up to `EXTREME_PRICE_ADVERSE_PROB_BOOST_MAX` = 0.65) and bps magnitude (up to 2x). Knobs: `EXTREME_PRICE_ENABLED` (true), `EXTREME_PRICE_EXTRA_ADVERSE_BPS` (30).
  - **Layer 2 (settlement bias)** in `pollAndSettle` (`settlement.ts`, sim only — `liveSettlement.ts` unaffected): at settle time, if `pos.avgEntry` is extreme, with probability `extremity × EXTREME_SETTLEMENT_BIAS_PROB_MAX` (0.40 default), force a winning candle to resolve as a loss. Models the empirical mechanism that depth at extreme prices is informed flow. Knob: `EXTREME_SETTLEMENT_BIAS_ENABLED` (true).
  - Calibration: chop-fader-v1 sim:live gap was -$22/fire (sim too optimistic). Layer 1 alone closes ~$0.01. Layer 2 closes another ~$0.61 (at default prob 0.40) up to ~$1.47 (at prob 1.0). Remaining gap is unmodeled — likely position-size effects in live. **The `config/sim_unreliable.json` blacklist remains the primary defense for extreme-price strategies until a more complete model lands.**
  - **2026-05-08 verdict: layers 1+2 are still INSUFFICIENT.** Activity API audit of 29 settled live trades on 4 promoted engines (bred-fw8t, bred-znra-small-v1, maker-momentum-v1, rotation-fade-v1) showed 86% loss rate (-$25 / $49 stake) while sim claimed +$50-$107 per engine. Every extreme-price taker (5-25¢) lost in live regardless of sim score. Layer 2's 0.40 max flip prob caps at ~80% sim WR; live is showing ~14%. Real adverse-selection probability at extremes is closer to 0.85, not 0.40.
  - **2026-05-11 fix shipped (#100):** `scripts/calibrateLayer2.py` pulls Activity API, buckets settled trades by entry price, computes empirical per-bucket flip_prob. Writes `config/empirical_flip_prob.json`. `extremeFlipProb()` reads it; buckets with ≥5 samples use empirical, smaller buckets fall back to the linear formula. **Calibration summary (n=169):** midband loss rate 69%, alpha zone 0.55-0.70 best (43-60% loss), 0.05-0.25 catastrophic (75-100%).
- **Price-zone gate (2026-05-11)**: live data was unambiguous that taker BUYs outside [0.55, 0.70] lose 70-100% regardless of engine. Hard reject in BOTH `src/referee.ts` (sim) and `src/live/liveSizing.ts` (live) with reason `outside_price_zone`. Makers exempt (different fill dynamics — resting orders on the book). Knobs: `LIVE_PRICE_ZONE_{ENABLED,MIN,MAX}`. Re-tune the zone as more data lands and `calibrateLayer2.py` re-runs.
  - **2026-05-13: `LIVE_SIZING_OVERRIDE_ZONE_GATE` (default true)** — whale analysis (Marketing101) showed taker BUYs below 0.55 can be profitable with right signal. Override bypasses the gate in live (real orders flow through) but referee.ts still enforces the gate in sim so sim PnL stays honest per empirical curve. Flip false to restore previous behavior.
- **Live-settle watchdog (2026-05-08, #101)**: `scripts/liveSettleWatchdog.py` runs every 15 min, joins Activity API REDEEMs to forward BUYs via slug→tokenId, and auto-blacklists (engine, arena) pairs with ≥4/5 live losses AND sim claiming ≥$0 in same rounds. Idempotent. Catches chop-fader pattern at trade #5 not trade #25.
- **Whale-scan cron (2026-05-13)**: `scripts/whaleScan.py` runs weekly (Sun 00:00 UTC), snapshots Polymarket's monthly crypto leaderboard top-50 to `data/whale_scan/<isodate>.json`, diffs vs prior snapshot to surface persisters (sustained edge) vs flash-in-the-pan. See `docs/whale_analysis_2026-05-13.md` for the first deep-dive (Bonereaper1 = DCA-discipline, Marketing101 = selective tail bets).
- **Settlement** writes a `SETTLE` row to the trades table with the true payout pnl, so `SUM(pnl)` is honest
- **Phantom alpha detector**: arena.runRound flags any engine with > $500 single-round PnL (impossible from $50 starting cash) as a likely sim bug.

## Rules
- Use `updatePendingOrders()` / `hasPendingOrder()` / `markPending()` for fill-latency race protection (prevents pyramiding during 50ms fill window). Returns true on market rotation.
- Every engine must call `feeAdjustedEdge()` before trading
- Never trade at mid-prices without > 2% raw edge
- Use `cheapestExit(price, shares, tokenId)` to compare SELL vs MERGE with real book prices
- TokenId must match active market (referee rejects fabricated tokens)
- Must hold ≥ 5 shares to sell (CLOB), ≥ 1 share to merge (on-chain)
- Engines auto-load from `src/engines/` — just extend `AbstractEngine`
- Tests must pass before any deploy: `npm run test:unit`

## Deploy
```bash
bash scripts/deploy.sh           # full deploy: rsync, rebuild, PM2 restart (kills in-flight rounds)
bash scripts/deploy-engines.sh   # surgical: rsync only src/engines/, no PM2 restart
bash scripts/deploy-engines.sh btc  # only one coin
```
- VPS: <your-vps-host> (DigitalOcean)
- PM2 processes (7 total): `quant-arena-{btc,eth,sol}`, `quant-breeder-{btc,eth,sol}`, `quant-telegram`
- Deploy excludes BredEngine_* files and `data/` (preserved on VPS)
- **Use deploy-engines.sh for hand-built engine adds/edits/deletes** — it touches a per-coin reload flag that arena.ts picks up at the next round boundary, swapping the engine roster without disrupting the round. Position state lives per-round in EngineState so swapping instances is safe.
- **Use full deploy.sh** for arena.ts / referee.ts / pulse.ts changes — those don't go through the require-cache reload path and need a real restart.

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
