# bred-4h85 Mystery V2 — The Rejection Filter Discovery

## Context
This is a follow-up. We shared the bred-4h85 code with Gemini and got the "Native Tick Selection Bias" hypothesis — that bred only fires when the tick originates from the book it's buying, acting as a liquidity velocity filter.

We built `dca-native-tick-v1` to test this. It failed — 0 wins in 3 settles (-$49). But the REASON it failed led to a much bigger discovery.

## The New Discovery: bred-4h85's 94% Rejection Rate

We added rejection reason tracking (#24) to every referee fill path. Here's what bred-4h85's rejection profile looks like per round:

```
Round 20: limit_violated=81  book_not_tradeable=104  competing_taker=35  maker_not_filled=41  = 266 rejections
Round 21: limit_violated=77  book_not_tradeable=94   competing_taker=27  maker_not_filled=41  = 254 rejections
Round 22: limit_violated=82  book_not_tradeable=94   competing_taker=27  maker_not_filled=35  = 246 rejections
```

**bred-4h85 ATTEMPTS ~260 trades per round but only ~15 actually fill.** 94% rejection rate. The referee is doing the filtering.

### Rejection breakdown:

**`limit_violated` (~80/round):** The bug-driven DOWN-tick entries. When a DOWN tick arrives with midPrice 0.85, bred computes `downPrice = 0.15`, fires `extremeDown`, and tries to buy the DOWN token at `1 - tick.bestBid = 0.16`. But the DOWN token's ACTUAL ask is ~0.86. walkBook rejects (limit 0.16 < actual 0.86). **Critically: `candleEntries++` already fired before the buy action was returned.** Each phantom rejection wastes a counter slot.

**`book_not_tradeable` (~95/round):** The `isBookTradeable()` pre-check rejects when books are stale (>30s old), crossed (bid >= ask), one-sided, or spread > $0.50. This filters ~95 entry attempts per round where book state was unreliable.

**`competing_taker` (~30/round):** Our sim model of real-world takers racing for the same cheap liquidity. Rejection probability scales with how cheap the entry price is (37.5% at $0.05/50 shares).

**`maker_not_filled` (~40/round):** bred uses `Math.random() < 0.85` for taker/maker split. 15% of attempts are maker orders with only 12% fill probability. Most fail.

### How the counter-waste creates selectivity

bred has `maxEntriesPerCandle = 4`. Each candle gets 4 counter slots. The bug-driven phantom entries consume some:

```
Candle X (typical sequence):
  DOWN tick → extremeDown fires → candleEntries++ (#1) → limit_violated REJECTED
  DOWN tick → extremeDown fires → candleEntries++ (#2) → limit_violated REJECTED  
  UP tick   → extremeUp fires   → candleEntries++ (#3) → FILLS at 0.19 ✓
  DOWN tick → extremeDown fires → candleEntries++ (#4) → limit_violated REJECTED
  UP tick   → extremeUp fires   → candleEntries >= 4 → BLOCKED
  
Result: 1 fill per candle instead of 4.
```

**On candles where many DOWN ticks arrive before UP ticks, the counter fills up entirely on phantoms → ZERO fills.** This is what happened in the forensic comparison:

```
native-tick (no phantom entries):
  10:30  4× UP @ 0.18  → 108 shares → LOST -$19.52
  10:48  4× UP @ 0.18  → 108 shares → LOST -$19.47
  10:52  2× UP @ 0.17  →  58 shares → LOST  -$9.89
  BUST at -$48.88

bred-4h85 (phantom entries waste counter on candles 1-3):
  10:30-10:56  counter filled by phantom DOWN entries → 0 fills
  11:01  2× UP @ 0.16  →  62 shares → WON +$52.08
  Still has $40 bankroll
```

### Why the phantom filter produces better WR

The phantom entries don't just reduce quantity — they create a **temporal selection bias**:

1. **Candles with lots of DOWN ticks early** (cheap side is DOWN, meaning Binance is rising) → bred's counter fills up on phantoms → bred SKIPS the candle → UP entries would have lost because BTC is going UP (UP underdog loses when the trend continues up)

2. **Candles with UP ticks early** (cheap side is UP, meaning Binance is falling) → bred fires UP immediately → UP entries WIN if the fall reverses within the candle (mean reversion)

**The bug accidentally selects for candles where the UP side gets its tick FIRST** — which correlates with mean-reversion setups where the fall just happened and the UP book is actively being quoted.

### What our clean engines do wrong

Our clean engines (`dca-extreme-v1`, `dca-native-tick-v1`) have:
- 0 `limit_violated` (correct prices → all entries fill)
- 0 `book_not_tradeable` at entry time (pre-check prevents bad reads)
- 0 `maker_not_filled` (100% taker)
- Low `competing_taker` (fires less often due to price band)

**~120 fills per round vs bred's ~15.** Same mechanism, 8x more exposure, 8x more bleeding on losers.

### The core insight

**bred-4h85's edge is NOT a trading strategy. It's an accidental entry-selection mechanism created by the interaction between buggy code and the referee's rejection system.** The 94% rejection rate acts as an aggressive filter that:

1. Limits per-candle exposure to 1-2 fills (bankroll preservation)
2. Selects candles where UP ticks arrive early (temporal bias)
3. Skips candles with heavy DOWN-tick activity (trend-following avoidance)
4. Only accepts entries against fresh, tradeable, non-stale books

### The question

How do we build a clean engine that achieves a similar ~94% rejection rate through INTENTIONAL filtering rather than accidental bug+referee interaction?

Previous attempts (all failed):
- Narrow price band → wrong filter
- Direction alignment → wrong filter  
- Regime gating → wrong filter
- Warm-up period → helps bankroll but not WR
- Reduced entries per candle → helps survival but not WR
- Native tick gate → doesn't match bred's temporal selection

**What intentional filter would select the same ~15 candles per round that bred's bug+referee accidentally selects?**

### The bred-4h85 code (unchanged from V1)

```typescript
// Full source: see docs/BRED_4H85_MYSTERY.md
// Key bug lines:
const upPrice = tick.midPrice;           // wrong: uses whichever token's tick
const downPrice = 1 - upPrice;          // wrong: UP + DOWN ≠ $1
const downAsk = 1 - tick.bestBid;       // wrong: inverted price from wrong book

// Per-side position block (limits successful entries):
if (extremeUp && !(upPos && upPos.shares > 0)) { ... }
if (extremeDown && !(downPos && downPos.shares > 0)) { ... }

// Counter increments BEFORE the buy action (inside edge.profitable block):
this.candleEntries++;  // increments even on phantom entries that get rejected
```

### Rejection data from the referee (3 consecutive rounds)
```
Round 20: limit_violated=81  book_not_tradeable=104  competing_taker=35  maker_not_filled=41
Round 21: limit_violated=77  book_not_tradeable=94   competing_taker=27  maker_not_filled=41  
Round 22: limit_violated=82  book_not_tradeable=94   competing_taker=27  maker_not_filled=35
```

Approximately 15 fills per round survive from 260+ attempts.

## Appendix: Referee Rejection Code

### isBookTradeable (rejects ~95/round for bred)
```typescript
export function isBookTradeable(book: OrderBook): boolean {
  if (!book.bids.length || !book.asks.length) return false;
  const bestBid = book.bids[0].price;
  const bestAsk = book.asks[0].price;
  if (bestBid >= bestAsk) return false;  // crossed book
  if (bestAsk <= 0.005 || bestAsk >= 0.995) return false;  // PM price limits
  if (bestBid <= 0.005 || bestBid >= 0.995) return false;
  if (bestAsk - bestBid > 0.50) return false;  // excessive spread
  if (book.timestamp && Date.now() - book.timestamp > 30000) return false;  // stale >30s
  return true;
}
```

### walkBook (the limit_violated rejection path — rejects ~80/round for bred)
```typescript
export function walkBook(size, side, book, minFillSize, mutate, limitPrice) {
  if (!isBookTradeable(book)) return null;
  const levels = side === "BUY" ? book.asks : book.bids;
  // ... walks through levels, accumulates fills ...
  
  // THE KEY REJECTION: limit price enforcement
  const effectivePrice = totalCost / filledSize;
  if (limitPrice !== undefined && limitPrice > 0) {
    if (side === "BUY" && effectivePrice > limitPrice) return null;  // ← bred's DOWN entries die here
    if (side === "SELL" && effectivePrice < limitPrice) return null;
  }
  // Returns null → processAction records as "limit_violated" rejection
}
```

When bred tries `buy(downTokenId, downAsk=0.16, size)` but DOWN's actual ask is $0.86, walkBook gets `effectivePrice=0.86 > limitPrice=0.16` → returns null → rejection. The `candleEntries++` already happened in the engine.

### shouldRejectCompetingTaker (rejects ~30/round)
```typescript
export function shouldRejectCompetingTaker(price, size, isMaker) {
  if (isMaker) return false;
  if (price >= 0.20) return false;  // only fires at cheap prices
  const priceFactor = (0.20 - price) / 0.20;
  const sizeFactor = Math.min(1, size / 50);
  const prob = priceFactor * sizeFactor * 0.50;  // max 50% rejection
  return random() < prob;
  // At price=0.05, size=50: 37.5% rejection rate
  // At price=0.18, size=26: ~2.5% rejection rate
}
```

### BUY action gauntlet (the full rejection chain)
```typescript
if (action.side === "BUY") {
  const tokenBook = bookFromTick(action.tokenId, tickBooks);

  // 1. Stale-snipe guard (Binance moved, book hasn't caught up)
  if (shouldRejectStaleSnipe(tokenBook, isMaker))
    return makeRejectedFill(action, latency, "stale_snipe");

  // 2. Competing-taker guard (other humans racing for cheap liquidity)  
  if (shouldRejectCompetingTaker(refPrice, action.size, isMaker))
    return makeRejectedFill(action, latency, "competing_taker");

  // 3. Post-only enforcement (maker order would cross spread)
  if (isMaker && action.price >= bestAsk)
    return rejected("post_only_cross");

  // 4. Book tradeable pre-check
  if (!isBookTradeable(tokenBook))
    return rejected("book_not_tradeable");

  // 5. walkBook with limit price → null if limit violated or depth insufficient
  const walked = walkBook(size, "BUY", tokenBook, MIN_ORDER_SIZE, mutate, limit);
  if (!walked)
    return rejected(limit ? "limit_violated" : "size_below_min");

  // 6. Fill price range check
  if (fillPrice < 0.001 || fillPrice > 1.0)
    return rejected("fill_price_out_of_range");

  // 7. Cash balance check
  if (cashBalance < totalCost)
    return rejected("insufficient_cash");

  // If we get here: ORDER FILLS. Only ~6% of bred's attempts reach this point.
}
```

### The interaction between bred's code and the referee

```
bred-4h85 per candle:
  1. DOWN tick (mid=0.85) → extremeDown=true → candleEntries++ → buy(DOWN, $0.16) 
     → referee: walkBook limit 0.16 < actual ask 0.86 → REJECTED (limit_violated)
  2. DOWN tick (mid=0.87) → extremeDown=true → candleEntries++ → buy(DOWN, $0.13)
     → referee: walkBook REJECTED again (limit_violated)  
  3. UP tick (mid=0.17) → extremeUp=true → candleEntries++ → buy(UP, $0.18)
     → referee: walkBook limit 0.18 matches real ask → FILLED ✓
  4. DOWN tick → candleEntries++ = 4 → MAXED → no more entries this candle

bred's clean counterpart per candle:
  1. Any tick → reads both books → upAsk=0.18 → buy(UP, $0.18) → FILLED ✓
  2. Any tick → upAsk=0.17 → buy(UP, $0.17) → FILLED ✓  
  3. Any tick → upAsk=0.16 → buy(UP, $0.16) → FILLED ✓
  4. Any tick → upAsk=0.15 → buy(UP, $0.15) → FILLED ✓
  → 4 fills per candle, 4x exposure, 4x loss on losers
```
