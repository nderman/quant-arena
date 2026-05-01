# Scripts catalog

When in doubt, look here first instead of writing a one-off. Every entry tells you when to use it and which args matter. If something here is wrong (gap, bug, drift), update this file in the same PR — that's how it stays useful.

## At-a-glance: situation → what to run

| Situation | Command |
|---|---|
| **"What's the live state right now?"** (one-shot) | `python3 scripts/liveStatus.py` (on VPS) |
| "How's live PnL by engine?" | `python3 scripts/livePnLByEngine.py --since 24h` (on VPS) |
| "What's the auto-rotation cron been doing?" | `tail -30 ~/quant-arena/data/auto_rotation.log` |
| "What would auto-rotation do right now?" | `python3 scripts/auto_rotate.py` (dry-run) |
| "Force a roster swap now" | `python3 scripts/auto_rotate.py --commit` |
| "Which engines are winning across all arenas in sim?" | `python3 scripts/crossArenaAnalysis.py --source local` (on VPS) |
| "Which engines pass SAFE thresholds for live?" | `python3 scripts/crossArenaAnalysis.py --source local` (SAFE table) |
| "Selectivity-aware sim leaderboard?" | `python3 scripts/engineSelectivity.py` (multi-arena) |
| "How is engine X doing per regime?" | `python3 scripts/engineRegimeReport.py` (multi-arena) |
| "Compare engine A vs engine B head-to-head" | `python3 scripts/engineDuel.py engine_a engine_b` |
| "A/B compare an engine family" | `python3 scripts/engineCompare.py --prefix dca-` |
| "Replay live trades from Polymarket Activity API" | `python3 scripts/backfillLiveLedger.py --reset --write` |
| "Pick up manual UI trades into the ledger" | `python3 scripts/syncManualTrades.py --write` (cron: */10 * * * *) |
| "Backtest momentum prediction" | `python3 scripts/backtestMomentum.py 24 BTC` |
| "Deploy engine code without restart" | `bash scripts/deploy-engines.sh [coin]` |
| "Full deploy (arena/referee/pulse changes)" | `bash scripts/deploy.sh` |

## Full catalog

### Live trading & operations

| Script | Purpose | Key args | Status |
|---|---|---|---|
| `liveStatus.py` | **One-shot live state**: roster + cooldowns + last 3 cron runs + 24h ledger PnL + open Polymarket positions. | `--since 24h\|7d\|ISO` | ✅ active |
| `auto_rotate.py` | Hourly cron — picks top SAFE engines, hot-swaps `data/live_engines.json`. Respects manual culls via 6h cooldown. | `--commit`, `--bankroll N` | ✅ active (cron :05) |
| `livePnLByEngine.py` | Per-engine PnL from `data/live_trades.jsonl` (FILL+SETTLE). Ground-truth attribution. | `--since 24h\|7d\|ISO` | ✅ active |
| `liveLb.py` | Live mid-round leaderboard scraped from PM2 log files. | `--top N`, `--active`, `--5m`, `[coin]` | ⚠️ broken — PM2 log files no longer on disk |
| `backfillLiveLedger.py` | Rebuild ledger from Polymarket Activity API + curated `ROSTER_HISTORY`. Joins BUYs to REDEEMs by slug. | `--reset`, `--write`, `--since ISO` | ✅ active |
| `syncManualTrades.py` | Incremental cron — appends Activity API events to ledger using fingerprint dedup. Catches manual UI trades + emit gaps. | `--write`, `--hours N`, `--limit N` | ✅ active (cron */10) |
| `analyzeTrader.py` | Pull any Polymarket wallet's trading patterns (uses Activity API). | wallet-as-positional | ✅ ad-hoc |
| `validate_settlements.py` | Validate our settlement WIN/LOSS decisions against Chainlink resolutions. | `[log_path] [ledger_path]` | ✅ ad-hoc |

### Sim analysis (engine performance)

All sim analysis scripts share `_arena_history.py` for multi-arena round_history loading. Default `--source local` (works on VPS); pass `--source vps` to SSH from laptop.

| Script | Purpose | Key args | Status |
|---|---|---|---|
| `crossArenaAnalysis.py` | **The canonical multi-arena leaderboard.** Per-(engine, arena) EV/round, WR, SAFE classification. | `--source`, `--min-rounds N`, `--bankroll N` | ✅ canonical |
| `engineSelectivity.py` | Mean PnL per firing round (silence-aware). One row per (engine, arena). | `--source`, `--rounds N`, `--min-firing N`, `--prefix`, `--by-engine` | ✅ multi-arena |
| `engineRegimeReport.py` | Engine × regime cross-tab + per-arena breakdown. | `--source` | ✅ multi-arena |
| `engineCompare.py` | Side-by-side engine comparison across arenas. | `--prefix`, `--engines a,b,c`, `--source`, `--arena` | ✅ multi-arena |
| `engineDuel.py` | Head-to-head A-vs-B per arena + grand totals. | `engine_a engine_b`, `--source`, `--rounds N`, `--arena` | ✅ multi-arena |
| `gateBacktest.py` | Backtest a regime gate proposal against an engine's historical trades. | `--engine X --allow CHOP,TREND`, `--local`, `--verbose` | ✅ ad-hoc |
| `graduationCandidates.py` | 🗄️ DEPRECATED — use `crossArenaAnalysis.py` SAFE table. | — | 🗄️ deprecated stub |
| `dailySummary.py` | 🗄️ DEPRECATED — use `crossArenaAnalysis.py` + `engineRegimeReport.py`. | — | 🗄️ deprecated stub |

### Backtesters

| Script | Purpose | Key args | Status |
|---|---|---|---|
| `backtestMomentum.py` | Does Binance momentum at T+Xs predict 5m candle outcome? | positional `HOURS` (no argparse) | ✅ ad-hoc |
| `backtestMomentumSweep.py` | Grid sweep momentum threshold × lookback to find optimal stingo43 config. | positional `HOURS` (no argparse) | ✅ ad-hoc |

### Data maintenance

| Script | Purpose | Key args | Status |
|---|---|---|---|
| `backfillArenaIds.py` | One-time: tag `round_history` rows with arena instance ID after the Apr 24 split. | none | 🗄️ one-time, kept for reference |
| `labelRegimes.py` | Classify market regime per round + per-engine PnL by regime. Fetches Binance klines. | none — hardcoded round IDs | ⚠️ stale config; SSH-from-laptop only |
| `tagRoundRegimes.py` | Retroactively tag rounds with regime labels in `round_history_<coin>.json`. | none | ⚠️ SSH-from-laptop only — fails when run on VPS |

### Deploy & infra

| Script | Purpose | When |
|---|---|---|
| `deploy.sh` | Full deploy: rsync, rebuild, PM2 restart (kills in-flight rounds). | `arena.ts`/`referee.ts`/`pulse.ts` changes |
| `deploy-engines.sh [coin]` | Surgical: rsync `src/engines/` only, touches reload flag, no PM2 restart. | Hand-built engine adds/edits/deletes |
| `vps-setup.sh` | First-time VPS bootstrap: swap, packages, Node 22 LTS. | New VPS provisioning |
| `smokeTestV2.ts` | Quick CTFv2 SDK connectivity test. | After clob-client-v2 upgrades |

## Known issues / gaps

### `liveLb.py` reads `/root/quant-arena/logs/` — directory doesn't exist

PM2 logs are not flushed to disk in current setup. Script returns empty. Either pipe `pm2 logs` into the parser or delete.

### `crossArenaAnalysis.py` default `--source vps` self-SSHes on VPS

When run on VPS, defaults to `--source vps` which SSHes back to itself and silently returns "No data". Always use `--source local` on VPS. The newer multi-arena scripts (`engineSelectivity`, etc.) default to `--source local` for this reason.

### `analyzeTrader.py` doesn't take `--help` cleanly

Treats `--help` as a wallet address and tries to fetch it. Add argparse next time it's touched.
