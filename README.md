# Quant Farm — Evolutionary Arena for Polymarket

A multi-coin TypeScript arena where AI-bred trading engines compete on **live Polymarket crypto binary markets** (BTC / ETH / SOL across 5m / 15m / 1h / 4h candles). A high-fidelity referee simulates dual orderbooks, the 2026 quartic fee model, latency, toxic flow, fill decay, oracle noise, and on-chain merge latency.

**The full lifecycle:** signals → sim arenas → AI breeder evolves new engines → cross-arena leaderboard → auto-rotation cron picks the SAFE+regime-fit top 5 → real CLOB execution against pUSD wallet → live ledger records every fill+settle → feedback loop scores live PnL drift back into the rotation algorithm.

The goal: evolve engines that can survive the structural costs of a real prediction market and graduate to live execution with real capital — autonomously.

---

## System Flow

How a tick travels from data feed → engines → fills → settlement → breeder.

```mermaid
flowchart TD
  subgraph DataFeeds["Data Feeds"]
    PMws["Polymarket WS<br/>(dual book + price)"]
    BNws["Binance WS<br/>(spot L2)"]
    CL["Chainlink poller<br/>(Polygon RPC)"]
    Disco["Gamma API discovery<br/>(retry + backoff)"]
  end

  subgraph Arena["Arena (per coin)"]
    Pulse["pulse.ts<br/>tick stream"]
    Snap["snapshotTickBooks<br/>(per-tick clone)"]
    Loop["onTick loop"]
    Engines[["engines<br/>onTick → actions"]]
    Ref["referee.processActions"]
    Settle["settlement.pollAndSettle<br/>(every 30s)"]
  end

  subgraph Persistence["Persistence (per coin)"]
    Ledger[("ledger_&lt;coin&gt;.db<br/>SQLite WAL")]
    Hist["round_history_&lt;coin&gt;.json"]
    Intel["round_intel_&lt;coin&gt;.json"]
    Marker["last_breed_&lt;coin&gt;.json"]
  end

  subgraph Breeder["Breeder (per coin, 6h cadence)"]
    Gate{"data gate:<br/>≥3 new rounds?"}
    Analyst["Gemini Flash<br/>analyzeArena"]
    Coder["Haiku 4.5<br/>generateEngine"]
    Compile["tsc validate"]
    Write["BredEngine_xxxx.ts"]
  end

  TG["Telegram bot<br/>(shared)"]

  Disco --> Pulse
  PMws --> Pulse
  BNws --> Pulse
  CL --> Pulse
  Pulse --> Loop
  Loop --> Snap
  Snap --> Engines
  Engines -- "BUY / SELL / MERGE / HOLD" --> Ref
  Ref -- "fills + pnl" --> Ledger
  Settle -- "SETTLE rows + payouts" --> Ledger
  Loop -- "round end" --> Hist
  Loop -- "leader stats" --> Intel

  Hist --> Gate
  Marker --> Gate
  Gate -- "yes" --> Analyst
  Analyst --> Coder
  Coder --> Compile
  Compile --> Write
  Write -. "loaded on next arena restart" .-> Engines
  Compile --> Marker

  Ledger --> TG
  Hist --> TG
```

**Key invariants:**
- Books are snapshot-and-cloned **once per tick**; engines share liquidity depletion within a tick (no ghost liquidity).
- Settlement writes a `SETTLE` row to the ledger, so `SUM(pnl)` reflects true outcomes (settlement wins are not silent cash bumps).
- Breeder is gated on **new round count**, not wall clock — deploys never fire fresh codegen on identical data.

---

## Sim → Live Pipeline

How an engine goes from "lives in `src/engines/` and gets simulated" to "fires real orders against the PM CLOB with real money". Fully autonomous since May 2026.

```mermaid
flowchart LR
  subgraph Sim["Sim Arena (per coin × interval)"]
    Engines[["~50 engines<br/>(hand-built + bred)"]]
    Ref["referee<br/>fills + fees + toxic"]
    Hist["round_history_*.json<br/>per-arena"]
  end

  subgraph Score["scoring (auto_rotate.py, hourly cron)"]
    Sharpe["recent_sharpe<br/>last 10 rounds<br/>×n/(n+5) shrinkage"]
    SAFE{"SAFE filter:<br/>worst > -$20<br/>n ≥ 8 rounds"}
    Regime["regime_fit_mult<br/>×1.5 / ×0.5 / ×1.0<br/>(SPIKE/QUIET/TREND/CHOP)"]
    LivePnL["live_pnl_penalty<br/>×0.5 if coin bled<br/>last 6h"]
    Cooldown["6h cooldown<br/>(swapped + manual culls)"]
    Score["score = sharpe<br/>× regime × livepnl<br/>× incumbent_bonus"]
  end

  subgraph LiveExec["Live Arena (in same PM2 process)"]
    Roster[("data/<br/>live_engines.json<br/>(top 5)")]
    Watcher["fs.watch (30s)<br/>hot-reload on change"]
    Rehydrate["rehydratePositionsFromLedger<br/>(restores state on PM2 restart)"]
    Exec["liveExecutor<br/>+ liveSizing"]
    Submit["clobSubmitter<br/>(@polymarket/clob-client-v2)"]
    Reconcile["liveReconcile<br/>(5s poll, 1s last 30s)"]
    Settle["liveSettlement<br/>(Gamma poll, 30s)"]
  end

  subgraph Ledger["Live Ledger (data/live_trades.jsonl)"]
    Fill["FILL rows<br/>{engineId, slug, side,<br/>size, fillPrice, cost}"]
    SettleRow["SETTLE rows<br/>{won, payout, pnl,<br/>costBasis}"]
    Sync["scripts/syncManualTrades.py<br/>(10min cron, catches<br/>manual UI trades)"]
  end

  PM[/"Polymarket CLOB v2<br/>+ pUSD wallet"/]

  Hist --> Sharpe
  Sharpe --> SAFE
  SAFE --> Regime
  Regime --> LivePnL
  LivePnL --> Score
  Cooldown -. "blocks" .-> Score

  Score -- "top 5, atomic write" --> Roster
  Roster -- "mtime change" --> Watcher
  Watcher -- "HOT-ADD/REMOVE/RESUME" --> Exec
  Engines -- "EngineAction" --> Exec
  Exec -- "sized order" --> Submit
  Submit --> PM
  PM -- "fill" --> Reconcile
  Reconcile -- "FILL" --> Fill
  Exec -- "FILL (instant)" --> Fill
  PM -- "candle resolves" --> Settle
  Settle --> SettleRow

  Sync -. "catches gaps" .-> Fill
  PM -. "Activity API" .-> Sync

  Fill -- "rehydrate on boot" --> Rehydrate
  SettleRow -- "rehydrate on boot" --> Rehydrate
  Rehydrate --> Exec

  Fill -- "fetch_live_pnl_by_coin" --> LivePnL
  SettleRow -- "fetch_live_pnl_by_coin" --> LivePnL
```

### How the auto-rotation cron decides each hour

1. **Read sim history** for all (engine, arena) pairs from `data/round_history_*.json`
2. **Detect current regime** via direct Binance API (5m vs 1h vs 1d realized vol → SPIKE/QUIET/TREND/CHOP)
3. **Detect live PnL drift per coin** via Polymarket Activity API (last 6h cash flow per ETH/SOL/BTC)
4. **Score every candidate**: shrunken Sharpe × regime fit × incumbent bonus × live-PnL penalty
5. **Hard SAFE filter** (worst round ≥ -$20, ≥8 firing rounds) + 6h cooldown
6. **Construct roster** (top K by score, no engine repeated, max 3 per coin)
7. **Compare aggregate score** vs current — only swap if proposed > current × 1.30
8. **Atomic write** `data/live_engines.json` → liveArena's `fs.watch` picks it up within 30s

The threshold prevents thrashing. The cooldown prevents re-adding what was just culled (manual or automatic). The compound-penalty floor (0.5×) prevents two simultaneous penalties from killing a proven winner.

### Live state persistence (closes the chronic double-buy bug)

The Apr 30 / May 1 lesson: PM2 restart wipes `LiveEngineState.positions` (in-memory only). Engine boots, sees no position, re-fires on the same candle → double-buy. Cost us ~$10 across three incidents.

**Fix:** `data/live_trades.jsonl` is a persistent append-only log of every FILL and SETTLE event tagged with `engineId` + `arenaInstanceId`. On `liveArena` startup, `rehydratePositionsFromLedger` replays unsettled FILLs to restore each engine's positions Map and adjusts cashBalance for the locked capital. Engine first-tick correctly sees its open position and `hasPendingOrder()` blocks the duplicate fire.

The ledger has three write paths:
- **Forward emission** (real-time): `liveExecutor.applyFill` and `liveReconcile` and `liveSettlement` call `recordFill` / `recordSettle`. Untagged `_source`.
- **Historical backfill** (one-shot): `scripts/backfillLiveLedger.py` reconstructs from Polymarket Activity API for periods before forward emission existed. Tagged `_source: "backfill"`.
- **Continuous sync** (10-min cron): `scripts/syncManualTrades.py` diffs Activity API against ledger and appends anything missing. Catches manual UI trades + emit gaps. Tagged `_source: "sync"`. Dedup uses `(slug, side, size, price)` fingerprint since forward `clientOrderId` ≠ Activity API `transactionHash`.

### Per-engine live PnL on demand

```bash
python3 scripts/livePnLByEngine.py --since 24h
```

Joins FILL → SETTLE rows by `(engineId, arenaInstanceId, tokenId)` and prints win rate + realized PnL + open exposure per engine. Ground truth — what made money, what didn't.

---

## Referee / Simulator

What happens to a single `EngineAction` between submission and the ledger.

```mermaid
flowchart TD
  Action["EngineAction<br/>BUY / SELL / MERGE"] --> Sanity{"price 0–1?<br/>token in active market?<br/>min size met?"}
  Sanity -- "fail" --> Reject1["reject (no fill)"]
  Sanity -- "ok" --> Latency["sleep LATENCY_MS (50ms)"]

  Latency --> RouteAction{action type?}

  RouteAction -- "BUY / SELL" --> WalkBook["walkBook(size, side, tickBook, mutate=true)"]
  WalkBook -- "deplete clone" --> FillCheck{"any fills?"}
  FillCheck -- "no" --> Reject2["reject"]
  FillCheck -- "yes" --> Maker{"maker order?"}
  Maker -- "yes (12% fill prob)" --> AdverseSel["+5bps adverse selection<br/>+0% fee + 20% rebate"]
  Maker -- "no — taker" --> Toxic{"toxic flow?<br/>15% × volume spike"}
  Toxic -- "hit" --> ToxicMove["price moves 50bps against fill"]
  Toxic -- "clear" --> FeeCalc
  AdverseSel --> FeeCalc
  ToxicMove --> FeeCalc

  FeeCalc["quartic fee:<br/>amount × 0.25 × (P×(1-P))²"]
  FeeCalc --> Fill["update positions, cash, pnl"]

  RouteAction -- "MERGE" --> MergeCheck{hold both sides<br/>of current market?}
  MergeCheck -- "no" --> Reject3["reject (Flavor A only)"]
  MergeCheck -- "yes" --> MergeA["burn both legs:<br/>credit $1/pair, gas only,<br/>3s on-chain delay"]
  MergeA --> Fill

  Fill --> Ledger[("recordFill →<br/>ledger.db")]

  Settlement["pollAndSettle<br/>(closed markets via Gamma)"] --> SettleHit{"engine holds<br/>settled token?"}
  SettleHit -- "yes" --> Payout["cash += shares (if won) or 0<br/>delete position"]
  Payout --> SettleRow["recordSettlement →<br/>SETTLE row in ledger"]
  SettleRow --> Ledger

  StaleCheck["stale data check<br/>(every 5s)"] -. "force PM reconnect<br/>after 10s silence" .-> Latency
  StaleCheck -.-> RotationCB["market rotation<br/>(every 2 min for 5M)"]
```

**The referee is the validator.** Engines submit intent; the referee determines whether and how that intent fills, using the *real* PM book at that moment, *real* fees, *real* latency, and *real* settlement payouts. Engines cannot lie about price or fabricate liquidity.

---

## Quick Start

```bash
npm install
npm run build       # tsc compile
npm run test:unit   # 255 tests — must all pass before deploy
```

### Run a single arena locally

```bash
ARENA_COIN=btc npm run arena:dry      # simulated random-walk pulse
ARENA_COIN=btc npm run arena:live     # live PM + Binance + Chainlink
npm run arena:1round:dry              # quick 1-min round for testing
```

### Production (multi-coin × multi-interval via PM2)

The shipped `ecosystem.config.js` runs **16 processes** — one arena per (coin × candle interval) plus shared services:

```
quant-arena-btc       quant-arena-btc-15m  quant-arena-btc-1h  quant-arena-btc-4h
quant-arena-eth       quant-arena-eth-15m  quant-arena-eth-1h  quant-arena-eth-4h
quant-arena-sol       quant-arena-sol-15m  quant-arena-sol-1h  quant-arena-sol-4h
quant-breeder-btc     quant-breeder-eth    quant-breeder-sol   quant-telegram
```

Each arena auto-discovers active markets for its (coin, interval) and runs the full sim engine roster against them. The same engines compete on different cadences — a 5m strategy can be tested simultaneously against 4h candles.

Each breeder evolves engines using its coin's history across all intervals. Telegram is shared. Auto-rotation cron picks live engines from the cross-arena leaderboard.

```bash
pm2 start ecosystem.config.js
pm2 logs quant-arena-btc
pm2 logs quant-breeder-btc
```

### Deploy to VPS

```bash
bash scripts/deploy.sh                # full: rsync + pm2 restart (kills in-flight rounds)
bash scripts/deploy-engines.sh        # surgical: engines/ only, no PM2 restart
bash scripts/deploy-engines.sh btc    # only one coin
```

`deploy-engines.sh` touches a per-arena-instance reload flag that `arena.ts` picks up at the next round boundary, swapping the engine roster without disrupting the round. Use this for hand-built engine adds/edits/deletes. Use full `deploy.sh` for `arena.ts` / `referee.ts` / `pulse.ts` changes.

---

## Signals

External free data feeds available to engines via `SignalSnapshot`. Wire access in `BaseEngine` so any engine can call them.

| Signal | Source | Refresh | Notes |
|---|---|---|---|
| **Fear & Greed** | alternative.me | 1h cache | 0-100 (0 = extreme fear, 100 = extreme greed) |
| **Funding rate** | Binance perp | 1h cache | Direction-coded (long-pays / short-pays / neutral) |
| **DVOL (BTC)** | Deribit | 1h cache | Annualized BTC implied vol |
| **Realized vol** | Binance klines | per call | 5m / 1h / 1d annualized — input to regime classifier |
| **Book imbalance** | PM L2 (live) | per tick | Engine-side helper `bookImbalance(tokenId, depth)` |
| **Binance momentum** | trackBinance helper | per tick | Cumulative bps over rolling lookback |

Engines that fire on multiple signals stacked tend to outperform single-signal ones. The breeder is prompted with the full signal catalog so newly-bred engines compose them.

`npm run signals` prints the current values for all signals (one-shot, useful for live debugging).

---

## The Quartic Fee Model

Polymarket's 2026 dynamic fee for crypto markets:

```
fee = amount × 0.25 × (P × (1−P))²
```

| Price | Fee % | Fee on $100 |
|------:|------:|------------:|
| 0.01 | 0.0025% | $0.0025 |
| 0.10 | 0.20%  | $0.20 |
| 0.30 | 1.10%  | $1.10 |
| 0.50 | **1.56%** | **$1.56** |
| 0.70 | 1.10%  | $1.10 |
| 0.90 | 0.20%  | $0.20 |
| 0.99 | 0.003% | $0.003 |

**Maker orders:** 0% fee + 20% rebate of taker fees, **12% fill probability** (was 60% — calibrated down to match real HFT queue priority), 5bps adverse selection.

**MERGE:** Flavor A only — engine must already hold both UP and DOWN of the same conditional pair. The referee burns both legs and credits $1 per pair (minus gas). Flavor B (buy opposite + merge atomically) was removed because it kept producing exploit paths in our sim. To do a Flavor B-style arb, emit a BUY for the opposite side first, wait for the fill, then call MERGE on a subsequent tick.

Winning engines must do at least one of:
1. Trade at the edges (P > 0.85 or P < 0.15) where fees vanish
2. Use MERGE to exit at mid-prices instead of crossing the spread
3. Have raw edge > 2% to overcome the fee at any price
4. Be a maker — accept the 12% fill rate and the 5bps adverse selection in exchange for zero fees and rebates

`feeAdjustedEdge()` on `BaseEngine` is the gatekeeper. Call it before every trade.

---

## Dual Orderbooks

UP and DOWN tokens have **independent orderbooks** delivered over PM WebSocket and routed by `asset_id`. UP + DOWN ≠ $1.00 — the gap is where merge arb profit lives.

Critical: an engine seeing a DOWN tick at $0.05 and buying UP tokens pays whatever the **UP book** says (~$0.95), not $0.05. The referee always fills from the correct token's book via `getBookForToken(action.tokenId)`. Never invert one book to derive the other.

---

## Writing an Engine

Drop a file in `src/engines/` extending `AbstractEngine`. Auto-loaded on next arena restart.

```typescript
import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

export class MyEngine extends AbstractEngine {
  id = "my-engine-v1";
  name = "My Engine";
  version = "1.0.0";

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    // Always check fee-adjusted edge before trading
    const modelProb = 0.60;
    const edge = this.feeAdjustedEdge(modelProb, tick.midPrice);
    if (!edge.profitable) return [];

    // Compare exit costs — sometimes MERGE beats SELL
    const exit = this.cheapestExit(tick.midPrice, 100, state.activeTokenId);

    return [this.buy(state.activeTokenId, tick.bestAsk, 50, {
      note: `edge=${edge.netEdge.toFixed(4)}`,
      signalSource: "my_signal",
    })];
  }
}
```

### BaseEngine helpers

| Method | Purpose |
|---|---|
| `feeAdjustedEdge(modelProb, marketPrice)` | Is this trade profitable after the quartic fee? |
| `cheapestExit(price, shares, tokenId)` | Should I SELL or MERGE? |
| `getPosition(tokenId)` | Current position |
| `portfolioValue(price)` | Cash + mark-to-market |
| `buy / sell / merge / hold` | Action builders |

### Engine rules

- Must call `feeAdjustedEdge()` before trading
- TokenId must match the active market (referee rejects fabricated tokens)
- ≥ 5 shares to SELL (CLOB), ≥ 1 share to MERGE (on-chain)
- `npm run test:unit` must pass before any deploy

---

## Breeder

Gemini Flash (analyst) + Claude Haiku 4.5 (coder) via OpenRouter.

| | |
|---|---|
| Cadence | 6h per coin (`BREED_INTERVAL_HOURS` to override) |
| Data gate | Skip cycle unless ≥ `MIN_NEW_ROUNDS_TO_BREED` (default 3) new rounds since last successful breed |
| Retries | 2 (compile-failure retries) |
| Coder model | `anthropic/claude-haiku-4-5` (override via `CODER_MODEL`) |
| Loading | Bred engines load on next natural arena restart — breeder no longer auto-restarts pm2 |

The data gate is the cost killer: every deploy / process restart used to fire 3 fresh Sonnet calls on identical data. Now the gate skips immediately if no new rounds have completed.

---

## Settlement

`pollAndSettle` runs every 30s per arena, queries Gamma for closed 5M markets, and:

1. Pays out cash to engines holding winning tokens (`shares × $1.00`)
2. Deletes losing positions (settled to $0)
3. **Writes a `SETTLE` row to the trades ledger** with the true payout pnl

Without #3, `SUM(pnl)` from the ledger lies — settlement wins silently bump cash without a row, so the column undercounts gains and overcounts losses. Always read leaderboards including SETTLE rows.

---

## Ledger Schema

`data/ledger_<coin>.db` (SQLite WAL, buffered writes flushed every 50 entries).

| Column | Notes |
|---|---|
| `round_id`, `engine_id`, `timestamp` | |
| `action` | `BUY` / `SELL` / `MERGE` / `SETTLE` |
| `token_id`, `price`, `size` | |
| `fee`, `rebate`, `slippage` | |
| `pnl` | Realized P&L for the row; settlement payouts now recorded too |
| `cash_after` | Engine cash post-fill |
| `signal_source`, `note` | |
| `toxic_flow` | 1 if adversely selected |
| `latency_ms` | |
| `order_type` | `taker` / `maker` / `merge` / `settle` |

```sql
-- Honest leaderboard (includes settlement payouts)
SELECT engine_id,
       COUNT(*) as trades,
       SUM(CASE WHEN action='SETTLE' THEN 1 ELSE 0 END) as settles,
       printf('%+.2f', SUM(pnl)) as pnl,
       printf('%.2f', SUM(fee)) as fees,
       SUM(toxic_flow) as toxic
FROM trades
GROUP BY engine_id
ORDER BY SUM(pnl) DESC;
```

---

## Key Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `ARENA_COIN` | `btc` | Per-process coin (set in ecosystem) |
| `ARENA_INSTANCE_ID` | `<coin>` | Ledger / intel suffix |
| `ROUND_DURATION_MS` | `3600000` | 1h rounds |
| `STARTING_CASH` | `50` | USDC per engine per round |
| `TICK_INTERVAL_MS` | `5000` | |
| `PEAK_FEE_RATE` | `0.015625` | Quartic peak (1.5625% at P=0.50) |
| `LATENCY_MS` | `50` | Realistic API lag |
| `MAKER_FILL_PROBABILITY` | `0.12` | Calibrated for HFT queue priority |
| `TOXIC_FLOW_PROBABILITY` | `0.15` | Per-fill toxic flow chance |
| `TOXIC_FLOW_BPS` | `50` | Adverse move size |
| `ON_CHAIN_LATENCY_MS` | `3000` | Polygon merge finality |
| `ORACLE_NOISE_BPS` | `35` | Settlement oracle noise |
| `BREED_INTERVAL_HOURS` | `6` | Breeder cadence per coin |
| `MIN_NEW_ROUNDS_TO_BREED` | `3` | Breeder data gate |
| `CODER_MODEL` | `anthropic/claude-haiku-4-5` | Breeder code-gen model |
| `OPENROUTER_API_KEY` | — | Required for breeder |

See `src/config.ts` for the full list.

---

## Layout

```
quant-farm/
├── src/
│   ├── arena.ts                 # main sim+live loop, per (coin × interval)
│   ├── referee.ts               # fee model, fills, toxic flow, merge
│   ├── pulse.ts                 # WS feeds + simulated pulse
│   ├── settlement.ts            # Gamma poller + SETTLE rows (sim)
│   ├── breeder.ts               # Gemini analysis + Haiku codegen
│   ├── discovery.ts             # Gamma API market discovery
│   ├── ledger.ts                # SQLite trade ledger (sim)
│   ├── historyStore.ts          # shared round history utilities
│   ├── signals.ts               # fear/greed, funding, DVOL, realized vol
│   ├── telegram.ts              # phone monitoring bot
│   ├── live/                    # LIVE execution stack
│   │   ├── liveArena.ts         # orchestrator: loads roster, hot-reloads, rehydrates
│   │   ├── liveExecutor.ts      # bridge: sim action → CLOB order
│   │   ├── liveSizing.ts        # bankroll-aware position sizing
│   │   ├── liveState.ts         # per-engine LiveEngineState
│   │   ├── liveReconcile.ts     # poll CLOB for async fills
│   │   ├── liveSettlement.ts    # poll Gamma for closed markets
│   │   ├── liveLedger.ts        # APPEND-ONLY data/live_trades.jsonl
│   │   ├── clobClient.ts        # @polymarket/clob-client-v2 wrapper
│   │   ├── clobSubmitter.ts     # createAndPostOrder + timeout reconcile
│   │   ├── riskManager.ts       # kill switch, daily loss cap
│   │   ├── graduation.ts        # candidate scoring → live_engines.json
│   │   ├── merger.ts            # MERGE flow on real PM
│   │   └── dryRunAdapter.ts     # mock submitter for tests
│   ├── engines/
│   │   ├── BaseEngine.ts        # AbstractEngine + helpers
│   │   ├── *.ts                 # ~25 hand-built strategies
│   │   └── BredEngine_*.ts      # AI-generated, preserved on VPS
│   └── tests/                   # 255 unit tests
├── data/                        # per (coin × interval): ledger, intel, history
│   ├── ledger_<arena>.db        # sim trade SQLite
│   ├── round_history_<arena>.json
│   ├── live_engines.json        # current live roster (top 5 from auto_rotate)
│   ├── live_trades.jsonl        # FILL + SETTLE log (forward + backfill + sync)
│   ├── auto_rotation.log        # hourly cron decisions
│   ├── auto_rotation_cooldown.json
│   ├── auto_rotation_last_seen.json   # for manual-cull detection
│   └── last_signals.json        # cached realized vol for cron regime
├── scripts/
│   ├── auto_rotate.py           # hourly live roster picker (cron)
│   ├── syncManualTrades.py      # 10min cron, Activity API → ledger
│   ├── backfillLiveLedger.py    # one-shot historical reconstruct
│   ├── livePnLByEngine.py       # per-engine realized PnL reader
│   ├── crossArenaAnalysis.py    # cross (coin × interval) leaderboard
│   ├── engineSelectivity.py     # mean PnL per firing round
│   ├── engineRegimeReport.py    # engine × regime cross-tab
│   ├── deploy.sh                # full deploy + pm2 restart
│   └── deploy-engines.sh        # surgical engine-roster swap
├── ecosystem.config.js          # PM2 process definitions (16 procs)
└── CLAUDE.md                    # AI assistant instructions
```
