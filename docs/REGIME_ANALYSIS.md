# Engine × Regime Analysis — April 13, 2026

First cross-tabulation of engine performance by market regime, using
`tagRoundRegimes.py` labels on all completed round_history entries.

## Method

- 60 rounds tagged: BTC=20, ETH=20, SOL=20
- Regime labels from Binance 1-min klines over each round's time window
- Thresholds match `AbstractEngine.currentRegime()`:
  - **SPIKE**: realized vol ≥ 15 bps per 1-min tick
  - **TREND**: |total return| ≥ 0.10% (10 bps) over the round
  - **CHOP**: vol 2-15 bps, not trend
  - **QUIET**: vol < 2 bps, no trend

## Regime mix

| Coin | TREND | CHOP | SPIKE | QUIET |
|---|---:|---:|---:|---:|
| BTC | 14 | 5 | 0 | 1 |
| ETH | 11 | 7 | 2 | 0 |
| SOL | 14 | 5 | 1 | 0 |
| **Total** | **39** | **17** | **3** | **1** |

**TREND is the dominant regime** across all 3 coins. The earlier
labelRegimes.py report ("all CHOP") used ledger-based per-tick data with
stricter thresholds; it was measuring micro-chop, not round-level regime.

## Top engines by total PnL

| Engine | Total | CHOP avg | TREND avg | SPIKE avg |
|---|---:|---:|---:|---:|
| **mean-revert-v2** | **+$1,582** | **+$84.2 ×17** | -$7.9 ×39 | -$1.0 ×3 |
| **bred-4h85** | **+$993** | +$23.0 ×4 | **+$81.9 ×11** | — |
| dca-settle-v1 | +$241 | -$38.0 ×4 | +$28.1 ×14 | — |
| bred-gki8 | +$144 | $0 ×9 | +$6.9 ×21 | $0 ×3 |
| fade-v3 | +$77 | +$4.7 ×17 | +$0.1 ×39 | $0 ×3 |
| disciplined-reverter-v1 | +$13 | +$19.8 ×4 | -$9.1 ×7 | — |
| stingo43-v1 | $(no tagged runs yet) | — | — | — |
| eth-mean-revert-v1 | -$156 | +$4.7 ×17 | -$5.7 ×39 | -$3.8 ×3 |
| baguette-drift-v1 | -$249 | -$4.4 ×17 | -$3.8 ×39 | -$6.8 ×3 |
| vol-regime-v1 | -$341 | -$12.9 ×13 | -$5.1 ×32 | -$3.2 ×3 |
| momentum-follower-v1 | -$1,128 | -$9.7 ×13 | -$35.2 ×25 | -$33.2 ×3 |
| edge-sniper-v1 | -$1,238 | -$26.8 ×13 | -$31.2 ×25 | -$28.6 ×3 |

## Regime specialists

### CHOP (17 rounds)

1. **mean-revert-v2** — avg **+$84.2** / round (17 rounds, $1,432 total)
2. mean-revert-v1 — avg +$76.4 / round (4 rounds) [retired]
3. bred-4h85 — avg +$23.0 / round (4 rounds)
4. disciplined-reverter-v1 — avg +$19.8 / round (4 rounds)
5. eth-mean-revert-v1 — avg +$4.7 / round (17 rounds)

**Verdict:** mean-reversion strategies win in CHOP. We thought
mean-revert-v2 was a loser; it's actually the #1 engine OVERALL. Its
recent red rounds were all TREND, where it correctly loses.

### TREND (39 rounds)

1. **bred-4h85** — avg **+$81.9** / round (11 rounds, $901 total)
2. **dca-settle-v1** — avg **+$28.1** / round (14 rounds, $393 total)
3. bred-gki8 — avg +$6.9 / round (21 rounds)
4. mean-revert-v2 — avg +$5.2 / round (39 rounds) — near zero
5. fade-v3 — avg +$0.1 / round (39 rounds)

**Verdict:** DCA-into-extreme strategies win in TREND. bred-4h85 and
dca-settle both ride the directional move via cheap-side DCA.

### SPIKE (3 rounds)

Every engine sits at exactly $0 — they either didn't trade in spike
conditions or the sim zeroed them. **Untested regime.**

### QUIET (1 round)

Only 1 data point. Insufficient.

## Per-coin specialists

**BTC (20 rounds)** — mean-revert-v2 dominates:
1. mean-revert-v2 — $1,287
2. bred-4h85 — $659 (across only 5 rounds = +$132/round avg)
3. bred-gki8 — $152

**ETH (20 rounds)** — bred-4h85 is the ONLY reliable winner:
1. bred-4h85 — $270
2. fade-v3 — $13
3. stingo43-v1 — $5 (tiny sample, 5 rounds)
Everything else is flat or negative. **ETH is the hardest coin in the arena.**

**SOL (20 rounds)** — three-way split:
1. mean-revert-v2 — $496
2. dca-settle-v1 — $336 (mostly from TREND rounds at +$103/round)
3. bred-4h85 — $64

## Action items this enables

### Immediate gates (add to engine code)

1. **mean-revert-v2**: gate `CHOP || QUIET` only. Historical: +$1,432 in
   those regimes, -$75 in others. Skipping TREND should lift its
   overall PnL substantially.

2. **dca-settle-v1**: gate `TREND` only. Historical: -$38/round CHOP,
   +$28/round TREND. Also consider SOL-only — SOL TREND is its sweet
   spot (+$103/round).

3. **dca-extreme-v1** (new clone of bred-4h85): gate `TREND` only before
   first deployment. bred-4h85's CHOP performance is weaker (+$23 vs
   +$82 TREND) — the TREND-only version should capture the sweet spot.

4. **bred-4h85** itself: leave alone. Bred engines get regenerated; don't
   edit. The parallel dca-extreme-v1 becomes the sanitized TREND version.

### Cull candidates (confirmed losers across all regimes)

- **vol-regime-v1**: -$341 total, red in every regime. The Binance fix
  didn't rescue it — the regime switcher itself is broken. Cull after
  one more round of confirmation.
- **baguette-drift-v1**: -$249 total, red in every regime.
- **momentum-follower-v1**: already culled earlier today
- **edge-sniper-v1**: already culled earlier today

### Engines to investigate

- **fade-v3**: basically flat (+$77, mostly tiny trades). Low frequency,
  low impact. Probably keep as free optionality.
- **bred-gki8**: +$144, mostly from TREND on BTC. Small positive,
  curious whether it's noise or signal.
- **eth-mean-revert-v1**: -$156, duplicate logic of mean-revert-v2 but
  only on ETH. ETH's TREND rounds kill it. Same gate as mean-revert-v2
  would save it.

## Untested engines

These are all brand new from today and haven't completed a full round yet:

- **stingo43-v1** (deployed but few trades)
- **stingo43-late-v1** (not yet deployed)
- **certainty-scalp-v1**
- **momentum-settle-v1**
- **maker-extreme-v1**
- **croissant-v2**
- **dca-extreme-v1**

No regime-specialty conclusions possible until they accumulate 3+ rounds
per regime. Most of them are momentum/directional engines, so we'd
expect them to be TREND specialists.
