# Polymarket Crypto Whale Analysis — 2026-05-13

Deep-profile of the top 20 monthly profit-leaders on Polymarket's crypto leaderboard, focused on answering: **what's the minimum bankroll where each whale's strategy is viable, and which patterns can quant-farm replicate?**

Data pulled from Polymarket's Activity API (last ~500 events per wallet). Volumes/profits as displayed on the leaderboard at time of collection.

## TL;DR

- **$36 absolute floor** to mechanically operate the most efficient strategy (ozpreezy).
- **$200 inflection** — most top-margin whale strategies become viable here.
- **$500 comfortable** — covers all top-margin strategies with variance headroom.
- Three distinct archetypes: event-driven scaler, mid-price high-frequency taker, tail-bet hold-to-settle.
- One actionable insight: the alpha-zone gate we shipped (0.55-0.70 taker only) is **too restrictive** — Marketing101 makes 13% margin on tail bets at $0.05-$0.40.

## Top 20 by margin (profit ÷ volume)

| Whale | Margin | Min BR | Strategy hint |
|---|---|---|---|
| ozpreezy | **24.8%** | $36 | event-driven, multi-day holds |
| Bonereaper1 | 21.6% | $199 | mid-price 5m taker, high-frequency |
| Bonereaper3 | 17.8% | $602 | high-concurrency |
| SamGTree | 17.5% | $11 | small sample (n=94) |
| Marketing101 | 13.1% | $162 | **tail bets, hold-to-settle** |
| wkknndoqmz | 12.9% | $276 | — |
| anon-6 | 11.2% | $110 | — |
| nsh91qaz | 7.8% | $176 | — |
| collabbsucks | 5.8% | $115 | — |
| CramSchoolClub | 5.7% | $298 | micro-arb |

Lowest 10 by margin are mostly the multi-million-dollar volume wallets (anon-1 with $9.5M vol / 2.4% margin) — high-turnover market-makers that don't translate to small bankrolls.

## Archetype 1 — ozpreezy (event-driven scaler)

**Numbers:**
- +$59,352 profit on $238,864 volume (35-day window)
- 7.4 buys/day, 5.1 sells/day
- **94% WR on settled** (15 wins / 1 loss across 16 redeems)
- Stakes range $0.65 → $19,980 (huge variance)
- Markets: 152 BTC events + 85 other crypto + 19 ETH + 2 politics
- **Not** Up/Down 5-min markets

**Strategy hypothesis:** picks high-probability outcomes in 1-7 day event markets (e.g. "BTC closes above $X by Date Y"), scales in with small probes ($1-50) then escalates ($1k-20k) when conviction high. Half the entries are >$0.85 (high-confidence "obvious winner") and half are $0.20-$0.55 (cheap upside). Sells before settle 56% of the time (median hold 18h), holds to settle the rest (median 3 days).

**Replicability for quant-farm:** ❌ **Not directly.** Different market type — quant-farm is built for crypto Up/Down 5-min markets, not multi-day event markets. The strategy also relies on judgment ("is this an obvious winner?") rather than mechanical signals.

**Min bankroll: $36** (mechanical floor). Realistic to evaluate edge: $500+ given the stake variance.

## Archetype 2 — Bonereaper1 (mid-price 5m taker)

**Numbers:**
- +$54,317 profit on $251,328 volume
- 473 buys / 7 sells / 19 redeems — pure entry-then-settle
- 100% crypto Up/Down 5-min markets
- **Entry distribution dead-center:** median $0.50, p10 $0.38, p90 $0.65
- 40% of entries in $0.40-$0.55, 36% in alpha zone $0.55-$0.70
- Stakes: median $4, p90 $28
- **63% WR** on settled
- 473 buys in ~1 day — high-frequency
- Concentrated UTC 10-13 (4-7 AM ET, before US market open)

**Strategy hypothesis:** continuously fires on Up/Down 5-min markets at mid-prices, picking the side it thinks will resolve. 5-minute candle settles in 4 minutes after entry. With 63% WR × $4 avg stake × symmetric payout = ~$0.50 expected per trade × 473 trades/day = ~$240/day theoretical.

**Replicability for quant-farm:** ✅ **YES, this is exactly our target market.** Same Up/Down 5-min markets, mid-price entries fall within our alpha zone, high-frequency taker style fits our infrastructure.

**Key questions to answer before building:**
1. What's the entry signal? Bonereaper1 fires 473×/day — that's almost continuous. Either a very weak signal that's just slightly biased, or simple heuristics (e.g. recent Binance momentum + book imbalance).
2. Why concentrated UTC 10-13? Pre-US-open low-volatility window? Less informed flow at those hours?
3. How do they avoid the chop-fader / informed-flow pattern that's been killing our engines?

**Min bankroll: $199.** Realistic to evaluate edge with 50+ settles for stat sig: $500-1000.

## Archetype 3 — Marketing101 (tail-bet hold-to-settle)

**Numbers:**
- +$48,641 profit on $371,052 volume
- 446 buys / **0 sells** / 49 redeems — pure hold strategy
- 100% crypto Up/Down 5-min markets
- **Entry distribution skewed low:** median $0.33, p10 $0.05, p90 $0.57
- 53% of entries in $0.20-$0.40 (the "losing tail" by our calibration!)
- 11% at $0.05-$0.20 (deep tails)
- Stakes: median $2.85, p90 $34
- **41% WR** on settled — low but tails pay 2.5-20x
- 168 buys/day — high-frequency
- Concentrated UTC 13 + 23 (US open + close)

**Strategy hypothesis:** systematically buys cheap losing-side tokens when the price is too low relative to actual probability. 41% WR × $0.33 entry × $1 payout = $0.41/win × 168 trades × 41% = $28/day theoretical (matches realized).

**Replicability for quant-farm:** ⚠️ **Yes, but DIRECTLY CONTRADICTS our current price-zone gate** which rejects taker BUYs below 0.55. Marketing101's 64% of trades are below 0.55 and they're profitable.

**This is a real finding:** our calibration assumed all sub-0.55 entries are losers because that's what OUR (poorly-selective) engines found. Marketing101 demonstrates the alpha exists at lower prices but requires:
- Specific entry timing (likely US session boundaries)
- Selection edge (knowing WHICH tails are mispriced)
- Discipline to hold to settle (no panic exit)

**Min bankroll: $162.** Comfortable: $300+ to ride out variance with 41% WR.

## Cross-archetype synthesis

**Common patterns across all three:**
- Polymarket Activity API is rich enough to reverse-engineer strategies. Worth keeping monthly snapshots.
- All three are TAKERS — no whales in top-margin tier are makers. Maker engines may be a dead end for our use case.
- Hold-to-settle is more common than trade-to-trade. Sim's "exit early" patterns may be over-engineered.

**Bankroll thresholds (final answer):**

| Threshold | Strategies that work | Notes |
|---|---|---|
| $0-50 | ozpreezy-like only | High variance, hard to evaluate edge |
| $50-200 | Marketing101 tail + Bonereaper1 mid | Mechanical floor; thin variance buffer |
| **$200-500** | **All efficient takers (13%+ margin)** | Sweet spot for $4-30 stakes |
| $500-1000 | Comfortable evaluation in 1-2 weeks | Recommended for serious edge detection |
| $1000+ | Market-maker / multi-strategy | Diminishing returns past $1000 for single strat |

## Implications for quant-farm

1. **Our $9 wallet is genuinely below the floor** for ANY whale strategy except ozpreezy-style — and we don't trade ozpreezy's markets.

2. **The price-zone gate (0.55-0.70) is too restrictive.** Marketing101's existence proves taker BUYs below 0.55 can be profitable with the right signal. The calibration was correct for OUR engines but not absolute — a smarter engine fires tails selectively.

3. **Bonereaper1 is the directly-portable target.** Same market, same time horizon, same alpha zone. If we can identify ONE signal that gives ~60% WR at mid-price, we have a template. Worth analyzing their trade timing relative to Binance price action.

4. **Marketing101 suggests a "selective tail" engine.** Not all sub-0.55 entries are equal; some windows are profitable. A time-of-day-aware tail engine fires only during US-session-boundary windows could capture this.

5. **Bankroll: top up to $200+ to test even one strategy seriously.** At $9 we burn capital before any signal emerges.

## Recommended next steps

A. **Top up wallet to $200-300** if continuing live experimentation.

B. **Drop or loosen the price-zone gate** — make it a sim-only filter (engines are still scored honestly) but allow lower-price taker fires in live if an engine claims selective edge.

C. **Build a Bonereaper1-style engine:** mid-price 5m taker, fire only UTC 10-13, hold to settle. ~150 lines of TS. Sim it first; if sim shows 60%+ WR at mid-price during the time window, ship it.

D. **Build a Marketing101-style engine:** tail-bet hold-to-settle. Fire only at US session boundaries (UTC 13 + 23). Hold-to-settle, no exit. ~100 lines.

E. **Save the leaderboard snapshot script:** `scripts/whaleScan.py` (TBD) — re-run weekly, track top-margin wallets over time, see whose edge persists.

## Caveats

- Activity API returns the LAST 500 events. ozpreezy's window was 35 days (low frequency), Bonereaper1's was 1 day (very high frequency). Different window lengths affect comparability.
- "Win rate" from REDEEMs only catches trades held to settlement. Many positions are sold before settle (especially ozpreezy at 56% pre-settle sells).
- Top whales may have edge from off-chain info (Discord groups, custom signals, insider sources). Copying the trade pattern ≠ copying the alpha.
- Polymarket has a long-tail of whales with much smaller volumes. The top 20 here is the visible head; the body may have different patterns.

---

# Bonereaper1 Deep-Dive (2026-05-13)

After cross-referencing entry timestamps with Binance 1m klines, the strategy is much clearer.

## Per-slug breakdown (19 markets, full settle history)

```
slug         buys  price_progression       outcome  pnl
420400       112   $0.53 → $0.65 (rose)    WIN      +$1,316
418900        74   $0.50 flat              WIN        +$485
420400        61   $0.53 → $0.65           WIN        +$483
412300        58   $0.60 → $0.52           WIN        +$436
414100        28   $0.60 flat              WIN        +$786
413500        27   $0.43 → $0.50           WIN        +$258
419800        26   $0.35 flat              WIN        +$521
410200        35   $0.50 flat              LOSS       -$441
415600         9   $0.26 → $0.55 (jump)    LOSS       -$152
411400         7   $0.47 flat              LOSS       -$343
414700         2   $0.24 → $0.21 (drop)    LOSS        -$93
418300         2   $0.36 (bail)            LOSS       -$105
410800         1   $0.44 (one-shot)        LOSS        -$29
```

**12 wins / 7 losses (63% slug WR). Net +$4,221 on $6,916 stake = 61% ROI** in this 19-market window.

## Strategy decoded

1. **DCA into confirmed winners.** When the entry price stays flat or moves favorably, they keep adding. Top winners got 60-112 entries.

2. **Bail fast on losers.** When price moves against them (or whipsaws like 415600's $0.26→$0.55 jump), they exit with minimal exposure (1-7 entries).

3. **Entry prices clustered $0.20-$0.65** — covers our alpha zone AND lower band (which would be rejected by our current price-zone gate).

4. **Binance correlation: 93% of fires in FLAT 1m windows.** They DCA during price stability, NOT during volatile candles. The signal is "the price is holding, conviction is rising" — not "Binance moved, predict same direction."

5. **Side preference: 189 Up / 284 Down** — slight bearish lean during their UTC 10-13 trading window (pre-US-open).

## What this means

**The alpha is position management, not entry prediction.**

- Our entire engine base assumes "predict candle outcome, single shot, hold to settle." Bonereaper1 doesn't predict — they ENTER MANY and let position management sort winners from losers.
- This is a fundamentally different engine class than anything in our codebase.

## What it'd take to replicate

| Requirement | Have? | Cost to add |
|---|---|---|
| Multi-market position tracking | ❌ per-engine only | Cross-arena state needed |
| DCA-on-stability logic | ❌ | New engine ~200 lines |
| Bail-on-collapse logic | ❌ | New exit subsystem ~100 lines |
| Capital for 5-10 concurrent positions | ❌ ($9 wallet) | Top up to $200-500 |
| 5min market real-time price tracking per slug | ✅ pulse.ts has it | reuse |

## Decision tree

**Option A — Build the DCA-discipline engine.**
- Need: top up wallet to $200+; ~2-3 days of engineering
- Expected outcome: if signal is real, 50%+ ROI on the engaged capital
- Risk: capital is allocated to whatever engines are running; can't run other strats in parallel

**Option B — Profile Marketing101 next.**
- Different shape (tail bets, single-shot, hold-to-settle)
- May be simpler to replicate (no DCA logic needed)
- Lower expected ROI per $

**Option C — Don't replicate, build aware-of-whales infrastructure.**
- Mirror their open positions in real-time via Activity API polling
- Free-ride on their entries (we know the slug, price, side)
- Risks: latency, no edge if other copycats do same, no understanding of when they exit

**Option D — Accept current state.**
- Current roster (stingo43-v1 + trade-settle-pinger) is mediocre but not bleeding
- Wait for current engines to accumulate samples
- Re-evaluate in a week

---

## 2026-05-14 — METHODOLOGY CORRECTION + LB top-20 screen

**Two critical bugs in the May 13 analysis:**

1. **REDEEM-only exit tracking missed MERGE and SELL events.** Realized P&L
   should be `sum(buy.cost) - sum(sell.proceeds + merge.value + redeem.payout)`
   for any slug with ANY exit. Counting only REDEEM systematically over-reports
   losses because wallets like gobblewobble exit primarily via MERGE (buying
   YES + NO sides of arbed pairs, then merging for guaranteed $1/pair).

2. **500-event windows are ~0.6 days for high-frequency wallets.** Bonereaper1,
   Marketing101, ozpreezy were all analyzed on slices of less than one day.
   For HF traders deploying $5K-$300K/day, that's a single trading session —
   completely unreliable as a signal of edge.

The activity API supports `end=<unix_ts>` cursor pagination (1000 events max
per page). To get a real 30-day view of an HF whale, expect 30-50 page pulls.
The lowercase address rejects but checksum case works. See `whale_month.py`.

### LB top-20 screen (May 14, 30d-or-cap windows, full SELL+MERGE+REDEEM exits)

**16 of 20 wallets show positive realized P&L** once MERGE is counted. The
"everyone is losing" finding from May 14 morning was a methodology artifact.

**The four archetypes that emerged from the screen:**

| Archetype | Top examples | Mechanism |
|---|---|---|
| **Exit-discipline** | ExitLiquidty (77% sell), SchrodingerBet (57%), Adam888 (46%) | Active sells into strength, cut losers |
| **High-selection hold** | BadTattoo (100% WR), JanAMEX (96% WR), splaym (90%) | Few entries, high WR, hold to settle |
| **DCA + MERGE** | gobblewobble (+$321K), justdance (+$59K), Bonereaper3 (+$55K) | Heavy buys, merge YES+NO pairs for $1/pair |
| **Tail-bet sniper** | 0xd293F90 (1 trade +$83K), liudapao1 (1 trade), NeverYES | Few entries, single big payoffs |

**The 4 losers had clear pathology:** HandsomeLi (-$191K, 234% sell ratio
liquidating pre-window inventory), WangXingYu (49% WR but asymmetric losses),
JaneStTrader (1% sells, big single losses), avenger (35% sells but exit
timing wrong).

### Top 5 candidates for further investigation

1. **ExitLiquidty** — 77% sell:buy, +$319K, +63% ROI on $514K deployed, 79% WR
   over 95 closed positions. The dream find: active exit management with real
   edge. Best portability candidate.

2. **gobblewobble** — +$321K via 88 MERGE events + 137 redeems on $2M deployed.
   If the MERGE pattern is "buy both sides when YES+NO ask sum < $0.95 then
   merge for $1," this is pure arb and we already have MERGE plumbing in
   referee.ts.

3. **JanAMEX** — 96% WR over 167 closed positions, +$400K, 111-day window,
   $3.8M deployed. Pure selection — figure out what gates 96% WR.

4. **SchrodingerBet** — 57% sell ratio, 85% WR, +$45K. Mid-conviction
   exit-discipline trader with high signal-to-noise.

5. **BadTattoo** — 100% WR over 12 closed positions, +$102K. Extreme
   selectivity. Either edge or selection bias on small sample.

### What this means for the May 13 archetypes

The May 13 doc identified Bonereaper1 (DCA-discipline, +22% margin),
Marketing101 (tail-bet, +13% margin), ozpreezy (event-driven, +25% margin)
based on 1-day slices with REDEEM-only exits. **None of those numbers should
be trusted.** A re-run on 30d windows with proper exit accounting is required
to know if those archetypes are real or were lucky-slice artifacts.

The new candidates above are 30-day-validated with proper exit accounting and
should be the priority targets going forward.

---

## 2026-05-14 (PM) — WangXingYu: the candle-market whale we can replicate

**The candle-market screen (10-page activity per wallet, 30d window, full
SELL+MERGE+REDEEM exit accounting) surfaced one wallet trading our exact
market universe with a $1.88M realized edge.** The headline LB shows them
at only +$31K (their largest single-event row); the real edge is invisible
on the standard biggest-winners ranking.

**Wallet:** `0x4c353dd347c2e7d8bcdc5cd6ee569de7baf23e2f` — userName
"WangXingYu"

### 82-day stats (2026-02-10 → 2026-05-03)

- 14,025 events: 11,857 buys / 136 sells / 2,027 redeems / 0 merges
- **1% sell ratio** — pure hold-to-settle
- 1,848 unique slugs, median 5 buys/slug (DCA but moderate)
- 143 buys/day, 24 redeems/day
- Total deployed: **$5,589,045**

### Market mix — they ARE quant-farm

```
Coin:        97.6% BTC, 2.3% ETH, 0% SOL
Resolution:  91% timed (5m/15m/hourly/4hr), 9% daily
```

Sample titles (all from a single recent day):
- `"Bitcoin Up or Down - May 3, 10:10PM-10:15PM ET"`  ← 5min
- `"Bitcoin Up or Down - May 3, 10:00PM-10:15PM ET"`  ← 15min
- `"Bitcoin Up or Down - May 3, 11PM ET"`              ← 1-hour
- `"Bitcoin Up or Down - May 3, 4:00PM-8:00PM ET"`     ← 4-hour

They trade all four resolutions our arena was built for, on the coin our
arena was tuned on. Different time scales of the same call — sometimes
multiple resolutions of the same hour on the same day.

### Entry-price distribution — moderate discount, never confirmed

```
<$0.20       10%
$0.20-$0.40  30%
$0.40-$0.55  38%   ← peak
$0.55-$0.70  18%
$0.70-$0.85   1%
$0.85+        0%
```

**Median entry: $0.44.** They peak at $0.40-$0.55 (38% of all buys).
**They essentially never buy above $0.70.** That's the signature: they
fade confirmed sides and take the cheap-and-likely side.

### Realized P&L

- **837W / 28L → 96% WR** on 865 closed positions
- Cost $2.67M → payout $5.47M
- **Net +$2,797,871 (+105% ROI)**
- 28 losers concentrated on regime-fail days (5 of top-8 worst losses are
  March 6, 2026 — one bad day stacked multiple wrong calls)

### Loser anatomy (28 of 865)

| Metric | Winners (837) | Losers (28) |
|---|---|---|
| Avg entry | $0.463 | $0.396 |
| Median buys/slug | 4 | 11 |
| Median cost | $2,486 | $4,743 |

**Losers are over-DCA'd cheaper entries.** When wrong, they double-down
harder at lower prices — exactly the failure mode we've seen in our own
chop-fader engines. The 96% WR is signal selection; the 4% losses are
DCA-into-broken-thesis.

### Stakes

- median $500 per buy
- p90 $1,000
- max $6,499

Way bigger than our current $8 cap, but the price+resolution structure
matches our arena exactly.

### Implications for quant-farm

1. **They confirm our universe is profitable** with the right signal.
   The 96% WR + 105% ROI says edge exists in BTC candles 5m through 4h.
   Our problem isn't the universe — it's the signal.

2. **Entry zone should widen.** Our current `[0.55, 0.70]` gate misses
   the 0.40-0.55 band where 38% of WangXingYu's volume lives. Don't
   widen until we have a signal to gate on, or we'll just bleed money in
   the wider zone.

3. **DCA discipline matters.** Their winners average 4 buys/slug, losers
   11. Our breeder should be selecting against engines that pile on losers.

4. **They never trade > $0.70.** Confirmation bias is a loser's game on
   candle markets. The premium-priced side is dominated by informed flow.

### Forward paths

**Path A — Copy-trade engine (1 day eng):** Poll their Activity API
every 2-5 min. Mirror each new BUY at $5-10 size to the same outcome
token. Exit when they REDEEM. Latency risk + dependency on a single
wallet's continued activity. **Cheapest, fastest alpha capture.**

**Path B — Signal reverse-engineering (~1 week eng):** Pull all 11,857
buy timestamps + entry prices + outcome. Pull Binance BTCUSDT OHLCV at
each buy time (and the candle their bet resolved on). Train a classifier
to predict "WangXingYu buys YES vs NO" from market state at decision
time. Even partial signal recovery (80% of their accuracy) gives us an
independent edge engine that doesn't depend on them staying active.

**Path C — Cross-validation (also part of Path B):** Once we hypothesize
a signal, validate it against the 28 losers — do they all fail the same
classifier check? That would confirm the signal model.

**Do both.** Path A captures alpha while Path B is being built. If Path
B yields a real signal, retire the copytrader and run our own; if not,
the copytrader remains the bridge.

---

## 2026-05-14 (LATER) — UNWIND: WangXingYu is not actually profitable

After the WangXingYu engine shipped (`e946f3f`) and we pivoted to Path B
signal RE, the descriptive feature split revealed a clean mean-rev signal
in their decisions. But the rule's measured candle-WR was only 47% — the
inverse of their reported 96%. Debugging this exposed **a third methodology
bug**, bigger than the first two.

### Bug #3: redeem-based exit accounting silently hides 100% of total losses

Polymarket binary markets resolve such that:
- Winning shares are worth $1 each → wallet calls REDEEM → on-chain event
- Losing shares are worth $0 → no need to call REDEEM → no event, just
  zero-value tokens sitting in the wallet

The May 13 + May 14 morning methodology computed "settled WR" by joining
buys → redeems and counting slugs where `redeem > cost`. **Every slug they
lost on was invisible to that join** — no redeem event to find.

Recomputing WangXingYu's 82d picture with `total_proceeds - total_deployed`
across all slugs:

```
1848 unique slugs:  837 won / 1011 lost  → 45% WR
Total deployed:   $5,605,130
Total redeemed:   $5,486,732
Net realized:    -$  118,398   ← break-even / slight underwater

983 slugs had zero proceeds. At 10+ days past their last activity, virtually
all are settled losses (5m–4h candles all resolved by now).
Hidden cost in those "invisible" slugs: $2,927,351.
```

**WangXingYu is a 45%-WR break-even trader.** Not a 96%-WR superstar.

The "+$2.8M / 96% WR" from earlier sections of this doc was the
**winning-side slice only** — by definition, every slug we measured had
already produced a positive REDEEM. The losing-side slice (almost identical
in size — $2.93M of bought-and-died positions) was completely absent.

### What this invalidates

| Earlier section | Status |
|---|---|
| **May 13 archetypes** (Bonereaper1 +22%, Marketing101 +13%, ozpreezy +25%) | Likely overstated — same methodology bug |
| **May 14 AM LB-top-20 screen** (16/20 wallets "profitable") | All numbers suspect — many "winners" may be break-even like WangXingYu |
| **ExitLiquidty +$319K, gobblewobble +$321K, JanAMEX +$400K** | Need re-validation with deployed-vs-proceeds |
| **WangXingYu +$2.8M / 96% WR** | UNWOUND. -$118K / 45% WR. Engine code shipped but not enabled. |

The **mean-rev signal in WangXingYu's decisions is still real** (descriptive
split shows -25 bps separation between YES/NO buys at 60min lookback). But
copying their decisions = copying a break-even trader. Mean rev × 45% WR =
~+$0.01/share at median $0.44 entry. Not alpha.

### The honest methodology going forward

For every wallet:

```python
deployed = sum(b.usdcSize for b in buys)
proceeds = sum(e.usdcSize for e in sells + merges + redeems)
realized = proceeds - deployed
```

Then for `slug_win_rate`, count won-slugs / total-slugs (where "won" means
`per_slug_proceeds > per_slug_cost`), not won-slugs / redeemed-slugs.

### Status of Path A and Path B

- **Path A (copy-trade engine)** — code shipped at `e946f3f`. Targeting
  WangXingYu yields a break-even strategy at best. Engine remains parked,
  retargetable via env var if a truly profitable wallet emerges.
- **Path B (signal RE)** — the mean-rev signal is in the data but is not
  alpha by itself. Path B yields a feature classifier of "what WangXingYu
  would have done", and WangXingYu loses money. Reframe: train a classifier
  on actual candle outcomes (not their decisions), use Binance OHLCV for
  prediction. The 82d Binance cache is already built.

### Open question

Are there ANY profitable candle-market whales when measured honestly?
Re-screen top-20 LB with `proceeds - deployed`. If yes, redirect Path A.
If no, abandon whale-replication entirely and pivot to first-principles
signal engineering using BTC features.

---

## 2026-05-14 (END) — Merge-arb negative result + session conclusion

After concluding the whale-replication branch as a dead end, ran one more
structural-alpha test: **merge-arb on dual-book sum < $1.00**.

Result: **infeasible at our latency tier.**

- `MergeArbSniperEngine.ts` already exists (parallel-taker variant, fires when
  ask_sum < 0.94). Sim history across 52 rounds: **0 fires.** Sim doesn't
  generate the gap.
- Live PM crypto book snapshot at peak hours: 0 of 42 readable markets had
  ask_sum < $1.00. Sampled sums were 1.01-1.02 (wide spreads, no arb).
- The merge-arb opportunity at sum < 0.94 is either (a) saturated by faster
  MEV bots, or (b) too transient for our 2-min poll cadence.
- gobblewobble's 88 merges weren't sniper-style — they were maker-side
  inventory accumulation over time, with directional exposure during the
  wait. That's a fundamentally different (and harder) engine to build, and
  the directional risk during accumulation is the same prediction problem
  we've failed to solve.

### Three-test summary

| Branch | Outcome |
|---|---|
| Copy-trade (Path A) | Engine shipped at `e946f3f`. Target wallet inactive 10d. No viable alternate target — all "candle whales" are either selection-biased non-winners or confirmation-buyers we can't catch at our latency. |
| Signal reverse-engineering (Path B) | Mean-rev signal IS in WangXingYu's decisions. But WangXingYu loses money. Mean-rev rule alone wins ~52% of candles, below break-even after quartic fee. |
| Merge-arb (structural) | Engine sound, gap doesn't open. 0/52 sim fires, 0/42 live book observations. |

### What we definitively learned

1. **Redeem-based exit accounting hides 100% of losses.** Always
   `proceeds - deployed` across all slugs. Three different bugs in this
   methodology cost us a full day before we found the third.

2. **The leaderboard reports per-event WINS, not realized P&L.** Top wallets
   can be net-losing on full accounting (JanAMEX, WangXingYu, gobblewobble
   candles all flipped negative with honest math).

3. **The viable candle-market winners are structurally protected by speed.**
   jhz1122 and 0xea687b343 fire at $0.85+ where margin is 1-5% per trade —
   our poll-and-fire latency makes those uncopyable. Their alpha is
   "I can react in 100ms," not "I have a signal."

4. **Merge-arb gaps don't open in live PM at our cadence.** The strategy is
   mathematically clean but operationally infeasible without WS-level
   monitoring across hundreds of markets simultaneously.

5. **Three independent failure paths suggest the candle ecosystem at our
   latency tier is saturated.** Time to either change market class
   (event/dated markets where ExitLiquidty operates) or change role
   (maker-side liquidity provision).

The sim leaderboard is full of engines that look strong but most of them are
chop-fader-pattern (sim says +$50-107, live says -$25). The few that have
survived live trial (momentum-settle, vol-regime) are the only ones we trust.
Further alpha is going to require a methodology shift, not another engine.

---

## 2026-05-14 (END OF DAY) — live ledger reality + halt

Pulled actual live P&L from VPS:

```
30d realized: -$37.23  (225 fires, 56W/57L = 50% WR, $703 staked)
7d realized:  -$ 8.95  (vol-regime engines lost this week)
24h:           $ 0.00  (no fires)
```

**Only profitable engine: `momentum-settle-v1 @ sol-4h`** (+$6.28, 18 fires,
69% WR). Everything else (17 other engine-arena cells) at break-even or
losing. The "validated" vol-regime gates lost money in the past 7 days.

**Live halted 2026-05-14 ~15:02 UTC** via `data/live_halt.flag`. Auto-rotation
was already disabled May 7 (manual experiment). The experiment has run its
course; the verdict is bleed.

**Reverse chop-fader finding.** The one live winner (sol-4h) is NOT in the
sim 4h leaderboard. Sim is too pessimistic about this cell. Class haircut
in auto_rotate may be wrongly suppressing it. Worth a future investigation.

**Plan when re-engaging:**
- Curated roster around 4h arenas
- Keep `momentum-settle-v1 @ sol-4h` (the proven cell)
- Trial: `maker-momentum-v1 @ btc-4h` (+$2.42 sim, 56% WR, n=43),
  `vol-regime-gate-v1 @ eth-4h` (+$1.38, 61% WR, n=23),
  `book-imbalance-v1 @ sol-4h` (+$1.04, 61% WR, n=23)
- Cull: chop-fader-v1, spread-compression-v1, maker-momentum-v1 @ eth-15m
- `rm data/live_halt.flag` to re-enable

End of session. Live trading stopped, sim continues, the alpha question
remains open but the search has been honest.
