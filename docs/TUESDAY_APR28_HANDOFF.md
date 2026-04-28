# Tuesday Apr 28 Handoff — Weekend Learnings + Todo List

Last updated: 2026-04-28 09:30 UTC (Tuesday morning, post-investigation, pre-cutover)

## TUESDAY UPDATE (Apr 28, ~07-09 UTC)

### What happened today
- Pulled fresh leaderboards (#53 ✓). 26 SAFE entries now. **chop-fader-v1 still #1** (12r / 58% WR / +$11.86 EV). **book-imbalance-v1 in 5 SAFE arenas**, the new standout (eth-15m: 12r / 75% WR / +$5.85).
- Reload-flag bug fixed Mon evening (per-arena-instance flags) so all 12 arenas now actually receive surgical deploys.
- Discovered Polymarket v2 exchange upgrade lands today at **11:00 UTC** — all open orders cleared, v1 SDK stops working post-cutover.

### Live deployment chosen
- **book-imbalance-v1 @ ETH 15m, full $18 bankroll** (concentrated). Initially split with momentum-settle BTC 1h @ $6, but $6 was structurally below the 5-share-min × 45%-exposure-cap interaction (rejected on every fire). Concentrated where the engine can fire.
- Live trading runs from 07:30 UTC → 10:50 UTC halt.
- Cron-armed halt scheduled for 12:50 SAST (10:50 UTC).
- Expected fires: 1-2 trades over 3-hour window per sim history (0.4 fires/hr, 75% non-silent rounds).

### v2 SDK migration prep
- Branch: `clob-v2-migration` (commit 918e198, pushed)
- Migrated to **`@polymarket/clob-client-v2@1.0.0`** (separate npm package, not a higher version of `@polymarket/clob-client`)
- Constructor: positional → options object (`{host, chain, signer, creds, signatureType, funderAddress}`)
- 249 tests passing on migration branch
- DO NOT MERGE pre-cutover. Merge + deploy after 12:00 UTC + after pUSD signing.

### Post-cutover playbook
1. Wait for cutover to complete (~12:00 UTC)
2. **Manual: sign pUSD conversion in Polymarket UI** (one-time, can't be automated)
3. Check `npm view @polymarket/clob-client-v2 version` for any post-cutover bumps; update package.json if needed
4. Merge `clob-v2-migration` → `live-execution`
5. Full deploy with halt-flag protection (it's an arena.ts-equivalent change since clobClient.ts touches core init)
6. Verify `[clob] Connected using cached API credentials from .env` logs cleanly (or `[clob] Derived API key` if creds invalid post-pUSD migration)
7. Re-arm live engines roster only after a smoke-test trade succeeds



## Where we left off

**Live: HALTED** (`data/live_halt.flag` armed, `data/live_engines.json` cleared)
**Wallet: $18.63 USDC**
**Sim: running normally on all 12 arenas**

Halt reason: chop-fader-v1 went 0/3 live this weekend (-$2.78 total). Investigation showed sim is bleeding the same trades — same engine decisions, same losses, just different sizing (sim 35 shares, live 5 shares due to CLOB min). Not a sim-live execution bug; the engine is genuinely wrong about regime in current market conditions.

## Key weekend findings

### 1. The sim-live "divergence" was sizing, not logic
At 23:08 UTC on Apr 24, chop-fader fired in BOTH sim and live with the same direction (DOWN @ 21¢). Both lost.
- Sim: ~35 shares × $0.21 = $7.35 lost per trade × 2 = -$14.70 round PnL
- Live: 5 shares (CLOB min) × $0.21 = $1.05 lost per trade × 2 = -$1.88 PnL

Same engine decision, same outcome, just scaled differently. **No execution-path bug to fix.**

### 2. The real question — is chop-fader's regime classifier wrong?
The engine gate is `currentRegimeStable("CHOP" or "QUIET")` + leading-side ≥ 80¢. All 3 weekend fires:
1. Engine classified regime as CHOP/QUIET → gate passed → bought DOWN underdog
2. Candle then TRENDED → underdog → $0 → loss

Two reads, both possible:
- **(A) Classifier wrong**: labels CHOP when reality is trending. Alpha opportunity to fix.
- **(B) Historical 62% WR was lucky**: 8 rounds is small. Just bad sample, no fix needed.

Resolution path in todo list below.

### 3. Sim infrastructure is healthy
- Maker-min bump deploys properly (Apr 25 fix: notional check moved AFTER share rounding)
- Tick alignment is direction-aware (Apr 24 fix)
- Live mirror fires reliably when sim fires
- 248 unit tests passing
- All 12 arenas running, breeder cycles every ~6h

### 4. book-imbalance-v1 is the standout signal engine
- Now in SAFE candidates table on **3 arenas** (eth-1h, sol, sol-1h)
- This round: +$22.95 BTC 15m, +$5.06 BTC 1h
- Most promising candidate for graduation if cross-arena data holds Tuesday

### 5. Breeder prompt v2-signals worked
Pre-prompt: every bred engine read only Binance momentum.
Post-prompt: 3 new signal-aware engines:
- `bred-ops4-imbalance-fade` — uses `bookImbalance + spreadBps`
- `bred-or5j` — uses `fearGreed + funding.rate`
- `bred-jp1t` — multi-signal: `realizedVol + bookImbalance + fearGreed + Binance`

All 3 silent so far (just deployed Apr 25). Tuesday: see if they generated profitable patterns over the long weekend.

## Tuesday Apr 28 — Todo list (priority order)

### A. Pull current sim leaderboards (5 min)
- [ ] `python3 scripts/liveLb.py` — current round across all 12 arenas
- [ ] `python3 scripts/crossArenaAnalysis.py --min-rounds 5 --bankroll 50` — historical SAFE+profitable (should have ~4 days more data)
- [ ] Note any new SAFE candidates that appeared during the weekend

### B. Investigate chop-fader regime classifier (~20 min) — THE ALPHA QUESTION
- [ ] Run `python3 scripts/engineRegimeReport.py` — per-engine × regime cross-tab
- [ ] Compute: of chop-fader's CHOP/QUIET-labeled fires, what % had realized vol > 15bps in next 60s? (i.e. classifier wrong)
- [ ] If classifier wrong > 50% of fires: tighten regime gate, e.g. require `currentRegimeStable("CHOP") AND realizedVol(60) < 8 bps` (double-confirm)
- [ ] If classifier mostly correct: chop-fader's edge is real but variance was bad, n=3 unlucky

### C. Evaluate the 6 bred engines (~10 min)
- [ ] Check liveLb for trades > 0 across arenas — which fired during the weekend
- [ ] For ones that fired, compute per-arena: trade count, WR, PnL
- [ ] Compare: did signal-aware bred engines (ops4, or5j, jp1t) outperform Binance-only bred (fw8t, fwly, fxi5)?
- [ ] Flag any candidate for SAFE+profitable graduation

### D. Evaluate sentiment-flow-v1 (Gemini's first engine)
- [ ] Did it fire? On which arenas?
- [ ] WR vs sim entries — did Gemini-authored code work as intended?
- [ ] If profitable on any arena: graduation candidate. If silent/losing: note thesis didn't hold this regime.

### E. Decide next live engine (the big call)
Three honest paths:
1. **Stay halted longer** — wait for n=10+ on ALL candidates before risking real money again
2. **Restart with book-imbalance-v1** — its 3-arena SAFE classification is the strongest signal we have
3. **Restart with chop-fader-v1 in non-TREND regime ONLY** — add a "skip if TREND" override, smaller bankroll ($5)

If choosing 2 or 3:
- Bankroll: $5-10 (don't deploy more than 50% of $18.63 wallet)
- Halt flag protocol same as before
- Set up monitoring after every fire

### F. Update breeder if learnings warrant
- If signal-aware bred engines won: document the proven pattern in breeder prompt
- If they lost: examine why (over-fitting? bad gate combinations?) and update prompt accordingly

### G. Optional cleanups
- Bred engines that have traded extensively and are clearly losing: cull via `scripts/deploy-engines.sh` after local deletion
- Update CLAUDE.md test count if new tests shipped

## Things to NOT do Tuesday
- Don't deploy live without checking the regime classifier first — that's the open question
- Don't graduate any engine on n<5 rounds (the momentum-settle hallucination lesson)
- Don't bypass the SAFE/WILD classifier — worst-round bound matters
- Don't restart all 12 arenas at once unless absolutely necessary (each restart cycles WS connections)

## Live history (this week)

| Engine | Bankroll | Live trades | Result |
|---|---|---|---|
| stingo43-late-v1 | $25 | many | bled |
| momentum-settle-v1 | $25 → $12.50 | 5 (3W-2L) | +$0.82 |
| chop-fader-v1 | $25 → $12.50 → $6.25 × 2 | 3 (0W-3L) | -$2.78 |
| **Total** | starting $25 | — | wallet now $18.63 |

Net live: -$6.37 over a week. Within capped-downside. Lessons > dollars lost.

## State to be aware of

- **Branch**: `live-execution`, all pushed to origin
- **Recent commits**: `05e393b` (sentiment-flow), `d88864d` (liveSizing reorder), `9595a79` (loosen gates), `79e7f81` (3 signal engines), `fdfd739` (signal wiring Phase A+B+C)
- **Tests**: 248 passing
- **VPS** (165.232.84.91): pm2 running all 16 processes, halt flag armed
- **Live engine roster**: empty (`data/live_engines.json` = `{}`)
- **Kill switch path**: `~/quant-arena/data/live_halt.flag`

## Quick start commands for Tuesday

```bash
# Status across all arenas
python3 scripts/liveLb.py

# Historical winners (post-overhaul data only)
python3 scripts/crossArenaAnalysis.py --min-rounds 5 --bankroll 50

# Per-engine regime breakdown (the chop-fader question)
python3 scripts/engineRegimeReport.py

# Tail any specific arena log
ssh root@165.232.84.91 "tail -50 ~/quant-arena/logs/arena-eth-out.log"

# Re-arm halt + clear roster (already done, just for reference)
ssh root@165.232.84.91 "touch ~/quant-arena/data/live_halt.flag && echo '{}' > ~/quant-arena/data/live_engines.json"

# Check breeder cycle activity
ssh root@165.232.84.91 "ls -lt ~/quant-arena/src/engines/BredEngine_*.ts | head -5"
```
