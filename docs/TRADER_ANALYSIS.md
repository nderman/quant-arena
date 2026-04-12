# Polymarket Crypto Leaderboard Analysis — April 12 2026

Source: Polymarket daily crypto leaderboard (top 40) + analyzeTrader.py deep dives.
All traders are on 5-minute BTC/ETH candles unless noted.

## Trader Profiles

### Tier 1 — High-signal, actionable strategies

**#5 ohanism** `0x89b5cdaaa4866c1e738406712012a630b4078beb`
- P&L: +$5,418/day | 139 positions | 53% WR | Avg win $128 / Avg loss $62 (2:1 payoff)
- Entry: avg $0.51, spread across 20-80¢ (both sides)
- Hold: 96% < 30min, median 12min
- DCA: 91% multi-buy (~18 buys per position)
- Hours: 02-04 UTC only
- **Pattern: Momentum DCA trader. Ladder entries, 2:1 payoff from position management.**

**#3 weidan1C2C** `0xb9beab3afbd72688df513e45f873c937a2dc987f`
- P&L: +$14,316/day | 19 positions | 47% WR | Avg win $2,287 / Avg loss $627 (3.6:1 payoff)
- Entry: avg $0.30, 68% below 40¢
- Hold: 63% < 30min, median 24min | **x=0.00 on all exits — holds to settlement, never sells**
- DCA: 100% multi-buy
- Hours: 23:00-04:00 UTC
- Sizing: $3,122 avg, max $6,443
- **Pattern: Cheap-side DCA hold-to-settle. Pure asymmetric payoff. Best signal/noise in the cohort.**

**#4 0xb434** `0x1fc82e096da1f53ee32ed407c264fb76ae2305cf`
- P&L: +$10,127/day | 125 positions | 44% WR
- Entry: avg $0.41, 37% at 20-40¢
- Hold: 100% < 30min | **x=0.00 — holds to settlement**
- DCA: 93% multi-buy
- Hours: 00:00-04:00 + 15:00-23:00 UTC (two sessions)
- Sizing: $360 avg, max $2,584
- **Pattern: Same as weidan but smaller stakes, more positions, slightly higher entry.**

**#22 durrrrrrrr** `0xdeca32428d5cf4b1c4d7266a950e20791676ddd5`
- P&L: +$2,345/day | 439 positions | 95% WR | $190k volume
- Entry: avg $0.81, **68% at 90¢+**
- Hold: 95% < 30min
- DCA: 50%
- Hours: 18:00-05:00 UTC (two sessions)
- Sizing: $1,051 avg, max $40k
- **Pattern: Late-candle certainty scalper. Buys near-certain winners at 90-99¢, pockets 1-5¢/share × huge size. 95% WR but small per-trade edge.**

### Tier 2 — Interesting but different market / less actionable

**#1 4zzzz** `0xf7a19aad8bd78c2e5e50a0729f6342775a909dce`
- P&L: +$42,247 | 11 positions | Only 1 loss (-$105)
- Entry: avg $0.23, holds for days/weeks
- **NOT a 5M trader.** Long-term BTC dip/reach directional bets. $15k avg position.

**#28 deltasniper** `0x0826042fb1f3f5ff4325ed7237ebc87468070b32`
- P&L: +$2,090 | IPL cricket + long-term BTC. $6.5k avg position.
- **NOT a 5M trader.** Sports + macro.

### Tier 3 — Anti-signals (losing strategies to avoid)

**#25 PBot-10** `0x5d634050ad89f172afb340437ed3170eaa2c9075`
- P&L: **-$5,851/day** | 33 positions | **6% WR**
- Entry: avg $0.11, **94% below 20¢**
- Hours: 02:00-05:00 UTC
- **Anti-pattern: Blind extreme-price entries without momentum confirmation. Validates that buying at <20¢ without a signal is -EV. The 85% of the time the extreme price was correct and the underdog loses.**

**mmmlllaqq122** `0xe2b255b1887f10711a91c932ba0919d4a61c55bb`
- P&L: **-$5,228** | 5 positions | 80% WR but one -$10,252 loss
- **Anti-pattern: Concentrated bets without Kelly sizing. 4 wins wiped by 1 catastrophic loss.**

## Key Findings

### 1. The dominant winning strategy is cheap-side DCA hold-to-settle
weidan ($14k), 0xb434 ($10k), and ohanism ($5.4k) all do the same thing:
- Buy the underdog (20-40¢) with Binance momentum confirmation
- DCA aggressively (10-20 buys per position)
- Hold to settlement, never sell early
- Accept 44-53% WR because the payoff ratio (2:1 to 3.6:1) is the edge

### 2. Late-candle certainty scalping is a distinct viable strategy
durrrrrrrr ($2.3k) buys at 90-99¢ with 95% WR. Tiny per-trade margin but massive volume. Nobody in our arena does this.

### 3. Timing matters — most winners active 00:00-04:00 UTC
This is 8PM-12AM ET — US evening session overlap with Asian morning. BTC volatility peaks = more directional moves = more Binance-to-PM repricing lag = more edge. Our arena runs 24/7 but edge is probably concentrated here.

### 4. Blind extreme entry is -EV (PBot-10 proves it)
Buying at <20¢ without any signal (no Binance momentum, no timing gate) is a losing strategy. PBot-10 has 6% WR. Our bred engines succeed because they HAPPEN to enter during momentum-driven dislocations — but the entry gate needs to be explicit (like croissant-v2's momentum threshold), not just price-based.

### 5. Nobody sells early — hold to settlement dominates
weidan: x=0.00 on all exits. 0xb434: x=0.00. Even durrrrrrrr holds to settle. The common wisdom that "mid-candle exits are better" is not supported by the leaderboard. Settlement is the payout mechanism that matters.

### 6. DCA is universal among winners
ohanism: 91%. weidan: 100%. 0xb434: 93%. Single-entry engines are leaving edge on the table.

## Arena Implications

| Gap | Description | Priority |
|-----|-------------|----------|
| **DCA mechanism** | Our engines enter once per candle. Winners enter 10-20 times. | High |
| **Late-candle certainty engine** | Buy 90¢+ in final 60s. durrrrrrrr's pattern. | High |
| **Momentum confirmation for extremes** | PBot-10 proves blind <20¢ entry is -EV. Gate extreme entries on Binance signal. | Medium |
| **Time-of-day filter** | Optionally gate entries to high-vol hours (00:00-04:00 UTC). | Low |
| **Limit orders in sim** | Needed to simulate realistic maker entries and DCA. | High (infrastructure) |
