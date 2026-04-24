# Sim Honesty Overhaul Review — Apr 22-24, 2026

Three-day sprint to fix the sim-to-live gap, rebuild the engine roster on honest
mechanics, and produce the first real graduation candidates.

## The Problem

Live PM trading on Apr 20-21 lost $17.35 on $25 bankroll in a single trade. The
strategy (bred-4h85 at 5-18¢ underdog entries) showed +$4,905 lifetime in sim,
but zero fills on winning candles live. **Faster bots eat extreme-price fills
on winners; losing candles fill freely.** Classic adverse selection missed by
the sim.

The sim was generating phantom alpha at extreme prices. Every bred engine
converged on that failure mode because the reward signal pointed there.

## What We Changed (in order shipped)

1. **FIFO virtual queue** — replaced 12% instant-fill lottery with queue
   tracking. GTC orders snapshot `sharesAhead` from real L2 book depth;
   fill only when queue clears.

2. **Price-dependent hidden-HFT floor** — at extreme prices (≤15¢ or ≥85¢),
   add 200-share minimum queue floor. At mid-prices (20-80¢), floor=0.
   Models the HFT concentration at extreme-payoff zones where our WS
   snapshots can't see sub-second ghost orders.

3. **Adverse-selection gate** — taker BUYs below 15¢ rejected when Binance
   momentum favors the trade direction. Models live reality: extreme-price
   fills happen only on losing candles; HFTs eat winners.

4. **50% cancellation heuristic + price jumpers** — depth decreases credit
   only 50% as queue advancement (can't distinguish fills from cancels).
   Depth increases at better prices push us back (price jumpers bump us in
   the queue).

5. **Scaled momentum lookbacks** — engines were using fixed 60-240s momentum
   windows calibrated for 5m. On 4h candles that's noise. Added
   `arenaScaledSec()` helper; updated 5 engines (BaguetteDrift, ChopFader,
   MakerMergeArb, Stingo43, Stingo43Late). Bumped Binance buffer from 15min
   to 60min.

6. **Non-5M arena fixes** — fixed rotation discovery, settlement slug
   prefix mismatch, window duration (300s hardcoded everywhere),
   endDate precision (`endDateIso` is date-only for 1H), Gamma
   settlement endpoint (`events?tag_slug=1H&closed=true` instead of
   general markets list which drowned in sports).

7. **Live execution hardening** — `buildClobCanceller`, `onCandleRotate`
   cancels pending makers on expired tokens, reconcile polls every 1s in
   last 30s before settlement.

8. **Live sizing caps** — `MAX_POSITION_PCT` 60%→15%, `MAX_CANDLE_EXPOSURE_PCT`
   60%→45%. A $7 account losing $6.50 in one trade triggered this.

9. **Arena expansion** — added ETH 15m/1h/4h and SOL 15m/1h/4h. Previously
   only BTC had non-5m arenas. 12 arenas total = 3 coins × 4 intervals.

10. **Cron + durable history** — hourly `tagRoundRegimes.py` + `dailySummary.py`
    write regime-tagged markdown to `data/summaries/YYYY-MM-DD.md`. Survive
    sim resets.

11. **Graduation criteria script** — `graduationCandidates.py` checks
    per-arena PnL, WR, EV, blow-up risk; emits pass/fail table.

## Engine Roster Changes

Culled (confirmed losers or extreme-price specialists now correctly
filtered by honest sim): dca-ladder, pure-maker, dca-solo, bred-b2db,
dca-clean-bred, maker-extreme-v1, bred-4h85 (taker), bred-adv6, bred-ad41.

Built during overhaul:
- **bred-4h85-maker-v1** — 15-30¢ DCA maker, dual-book aware
- **maker-merge-arb-v1** — Phase 3 hard-side-first port from old repo
- **baguette-drift-v1** — mid-candle flip, hold to drift
- **bonereader-sniper-v1** — last-second confirmed-winner sniper
- **trend-confirmer-v1** — leading-side taker at 35-45¢ after 30bps move
- **adaptive-trend-v1** — self-filtering on own signal accuracy
- **event-reactor-v1** — 1h/4h spike + trend confirmation
- **second-half-decider-v1** — T+50% commit check for longer candles
- **chop-fader-v1** — fade extremes (80¢+) in CHOP regime
- **bred-znra-small-v1** — half-sized variant of bred-znra for live viability

## Key Findings

**1. bred-4h85-maker-v1 is regime-dependent, not SOL-specific.**
- Apr 22: thought it was SOL 5m specialist (+$100/round, -$50 elsewhere)
- Apr 23: won ETH 15m +$153/round after arena expansion
- Apr 24: lost -$474 over 24 overnight rounds; gave back everything
- Per regime: wins in TREND, bleeds in CHOP. Needs a regime gate to be viable.

**2. chop-fader-v1 is the first engine with clean graduation profile.**
- ETH across 8 rounds: +$110 net, 62% WR, avg win $27 vs avg loss $8, worst -$12
- Only engine so far with favorable asymmetry AND high WR AND bounded downside
- **Strongest live candidate.**

**3. Size dominates strategy in live viability.**
- stingo43-late-v1 on live dry run: 55% WR, ~breakeven because losses ($3-4) were 2× wins ($1-2.50)
- The strategy works; sizing was wrong. Taking 11-share positions at 33¢ = $3.63 loss > winning positions at 65¢ = $2.20 win.
- Fix: symmetric sizing or stop entries below 40¢.

**4. Arena specialization is real and measurable.**
- dca-settle-v1 is BTC-only (never fires ETH/SOL — entry conditions don't match)
- stingo43-late-v1 is ETH-only (+$52/5 rounds), neutral elsewhere
- bred-4h85-maker wins SOL 5m + BTC (small), loses ETH
- Graduate PER ARENA, not globally.

**5. The breeder's bias toward extreme prices was data-driven, not dumb.**
Previously reward signal pointed to extremes because sim filled them free.
With honest sim, extreme-price entries get filtered. Breeder hasn't produced
new engines yet under honest sim (marker was stuck; reset Apr 24).

**6. Live dry run is essential before real capital.**
- Tested 5 engines × $25 bankroll with mock fills
- Caught the asymmetric-sizing bug on stingo43-late BEFORE funding
- Would have lost money live despite positive sim

## What's Next

1. **Let breeder run** — expect first new engines by Apr 24 12:00 UTC
2. **Graduation candidates refresh** — run `graduationCandidates.py` daily
3. **Consider funding chop-fader-v1 ETH** — +$110/8 rounds, max loss $12,
   realistic risk at $25 bankroll. Best current candidate.
4. **Regime-gate bred-4h85-maker** when we have ≥10 rounds per regime

## Infrastructure State at End of Review

- 12 arena processes running (3 coins × 4 intervals)
- 3 breeder processes (restarted with fresh markers Apr 24)
- Live dry run roster: bred-znra, bred-znra-small-v1, stingo43-v1,
  stingo43-late-v1, adaptive-trend-v1
- Hourly cron tags regimes + emits daily summaries
- $0.45 residual on real PM account; halt flag removed; dry run enabled
- All changes committed to `live-execution` branch (commits bf478bc → 2f271ea)

## Files Created

- `docs/SIM_HONESTY_REVIEW_APR22-24.md` (this file)
- `scripts/dailySummary.py`, `scripts/graduationCandidates.py`, `scripts/liveLb.py`
- `src/engines/{BaguetteDrift,BoneReaderSniper,MakerMergeArb,TrendConfirmer,AdaptiveTrend,EventReactor,SecondHalfDecider,ChopFader,BredZnraSmall}Engine.ts`

## Memory Entries

- `feedback_quant_farm_sim_honesty_apr22.md` — full overhaul summary
- `feedback_quant_farm_live_sizing.md` — 15% cap rule
- `feedback_quant_farm_per_regime_test.md` — graduation test principle
- `project_quant_farm_where_apr22.md` — EOD state snapshot
- `project_quant_farm_4h_tuning_todo.md` — (resolved by scaling fix)
