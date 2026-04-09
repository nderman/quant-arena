# Live Build Plan

Implementation roadmap for live execution. Sim keeps running on `main`; live work happens here on `live-execution`.

## Design principle

Sim is the brain; live is a shadow executor. Engines remain pure functions emitting `EngineAction[]`. Live mode intercepts those actions, translates to CLOB orders, reconciles fills back into a **separate** `LiveEngineState`, while the sim state runs in parallel as a health oracle. If live drifts from sim beyond tolerance, kill switch fires.

## Module breakdown (`src/live/`)

| File | Role |
|------|------|
| `clobClient.ts` | Singleton CLOB wrapper. Copy from polymarket-ai-bot `clobConnect.ts`. |
| `wallet.ts` | RPC failover + ethers v5 signer. Adapted from `wsClient.ts`. |
| `liveExecutor.ts` | `executeLiveAction(action, state)` — round, sign, post. ~200 lines. |
| `orderTracker.ts` | Polls + WS subscribes for own fills. Emits `fill`/`partial`/`cancelled`. |
| `reconciler.ts` | Merges fills into `liveState`. 30s Data API drift check. |
| `riskManager.ts` | Hard caps: 2% size, $50 daily loss, 5 max positions. |
| `killSwitch.ts` | `data/live_halt.flag`. Auto + manual triggers. |
| `liveState.ts` | `LiveEngineState` type + bootstrap from on-chain + persisted JSON. |
| `graduation.ts` | Round-end check against criteria, writes `live_engines.json`. |
| `dryRunAdapter.ts` | Mock CLOB for testing without signing. |
| `orphanGuard.ts` | Cancels positions we own but didn't place. |

`src/liveArena.ts` — new entrypoint. Loads only graduated engines, runs sim + live in parallel.

## State model

```ts
interface LiveEngineState extends EngineState {
  mode: "live";
  walletAddress: string;
  pendingOrders: Map<string, PendingOrder>;
  dailyLossUsd: number;
  dayStartCashUsd: number;
  lastReconcileAt: number;
  lastHeartbeatAt: number;
  driftFromSimUsd: number;
}
```

Sim state continues unchanged. Live state created only for graduated engines, hydrated from on-chain + persisted to `data/live_state_${coin}.json` every 10s.

## Order lifecycle

1. Engine emits `EngineAction` on tick
2. Sim referee fills against L2 → updates `simState`
3. `riskManager.canTrade(action, liveState)` → reject or proceed
4. `liveExecutor` rounds price/size, signs, POSTs → `PendingOrder`
5. `orderTracker` poll + WS → `fill` events
6. `reconciler.onFill()` updates liveState + writes to `live_fills` ledger
7. Every 30s: full Data API reconcile vs on-chain
8. **MERGE in v1 = SELL the smaller leg** via CLOB (skip on-chain merge complexity)

## Failure modes

| Failure | Detection | Response |
|---|---|---|
| Order POST fails | try/catch | Retry once with fresh nonce, log + skip |
| Partial fill | size_matched < size | Cancel remainder after 10s |
| RPC dies | heartbeat | Failover; >60s → kill switch |
| CLOB WS dies | no pings 30s | Fall back to REST polling, alert |
| Drift sim vs live > $5 | reconciler | Pause live, keep sim, alert |
| Sim performance collapses | round-end check | Remove from `live_engines.json`, flatten |
| PM2 restart | cold start | Hydrate from JSON + Data API; orphan cleanup |

## Graduation pipeline

Hook at end of every sim round in `arena.ts`. Reads `round_history_${coin}.json`, evaluates 6 criteria over last ≥10 rounds. Atomic write:

```json
{
  "btc": [
    {
      "engineId": "MeanRevertV2",
      "bankrollUsd": 50,
      "graduatedAt": "2026-04-09T...",
      "graduationRoundId": "R0047-..."
    }
  ]
}
```

`liveArena.ts` watches file, hot-adds engines. Demotion: Sharpe < 0.5 over last 5 rounds OR win rate < 40% → flatten + remove.

## Safety / observability

- **Dry-run** (`LIVE_DRY_RUN=1`): mock adapter, real books, no signing
- **Shadow mode** (`LIVE_SHADOW=1`): real auth + signing, orders 1bp outside best (won't fill). Validates plumbing with zero risk.
- **Logging**: `data/live_${coin}.log`, structured JSON. Every order: `{ts, engineId, side, price, size, simFillPrice, riskCheck}`
- **Telegram**: `liveOrderPlaced`, `liveOrderFilled`, `liveKillSwitch`, `liveGraduation`, `liveDrift`
- **Kill switch**: `touch data/live_halt.flag` cancels all orders, flattens via SELL

## Phases

| # | Scope | Time | Risk |
|---|-------|------|------|
| **0** | Branch, skeleton, copy CLOB client, deps. `npm run live:dry` exits cleanly. | 0.5d | None |
| **1** | `liveState`, `riskManager`, `graduation`, file watcher. Unit tests. No orders. | 1d | None |
| **2** | `liveArena.ts` parallel sim+live with `dryRunAdapter`. Full round in dry mode. | 1d | None |
| **3** | Real `liveExecutor`, `orderTracker`, `reconciler`, `orphanGuard`. Shadow mode on VPS. | 2d | Low (no fills) |
| **4** | Kill switch, drift detection, Telegram alerts, state hydration. | 1d | Low |
| **5** | $5 canary on BTC. Single engine. 48h run. | 0.5d | $5 |
| **6** | Scale to $50 per engine, enable more coins. | — | $450 max |

Phases 0–2 can merge to main safely. Phases 3+ stay on branch until canary passes.

## Decisions made

1. **Target market**: 5M markets (sim parity, fast feedback). Order lifecycle must complete in <2min — use IOC or maker orders that auto-cancel on next rotation.
2. **MERGE supported, two flavors**:
   - Flavor A (cheap): if we already hold both UP and NO from prior fills, just call `mergePositions(conditionId, min(upShares, downShares))` on-chain. Single tx, gas only.
   - Flavor B (arb): if we hold only one side, buy enough opposite via CLOB to reach `action.size`, wait for fill, then `mergePositions`. Two operations.
   - Live executor inspects on-chain balances first, picks the cheaper flavor.
   - Reuse `mergePositions` ABI + multicall pattern from polymarket-ai-bot/redeemer.ts.
3. **Wallet**: NEW wallet for arena, separate from polymarket-ai-bot. Accounting clean. Fund with $200 initially ($50 × 4 engines max).
4. **Bankroll cap**: $50 per engine, 5% per order = $2.50 max order size. Above PM $1 minimum.

## Outstanding unknowns

1. **Signature type drift**: funder vs signer confusion bit polymarket-ai-bot. Verify `SIGNATURE_TYPE` + `FUNDER` env before shadow phase.
2. **Drift calibration baseline**: sim has synthetic latency/toxic flow/fees. Live fills will differ systematically. Need calibration round to set $5 kill threshold.
3. **5M order timing**: maker orders may not fill before candle ends. Need to test in shadow mode whether fill rates are acceptable.

## Reuse from polymarket-ai-bot

**Copy verbatim**: `clobConnect.ts`, RPC failover from `wsClient.ts`, `liveOrphanGuard.ts`, pendingOrders polling.

**Reference, rewrite cleaner**: `executor.ts` (1086 lines, too coupled) — extract just tick rounding + post path into ~200 line `liveExecutor.ts`.

**Don't reuse**: `ledgerV2.ts` (domain-specific), `executor.ts` sizing logic.
