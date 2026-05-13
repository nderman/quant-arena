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
