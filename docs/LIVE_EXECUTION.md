# Live Execution

How an engine graduates from simulation to real-money trading on Polymarket.

## Graduation Criteria

An engine must pass ALL of these to be eligible for live trading:

### Performance gates
- **Min 10 rounds played** — at 6h/round = ~2.5 days. Catches enough market conditions.
- **Cumulative P&L > +$500** — proves it actually makes money, not just survives
- **Win rate ≥ 50%** — at least half the rounds are profitable
- **Worst round ≥ -$30** — max single-round loss capped at 60% of starting cash. No engines that nuke from orbit.
- **Sharpe-like > 1.0** — `mean_pnl / stddev_pnl` across rounds. Rewards consistency over flukes.
- **Cross-coin viable** — profitable on at least 2 of 3 coins. Single-coin specialists are too narrow.

### Sanity gates
- **No exploit signatures** — engine doesn't depend on simulation bugs (negative fees, infinite merges, etc.)
- **Action validity ≥ 99%** — actions get accepted by referee, not rejected for validation
- **Settlement validation passed** — historical WIN/LOSS calls match PM resolution (use validate_settlements.py)
- **Code review** — eyeballed by human for obvious sim-only assumptions

### Risk gates (live-only, on top of above)
- **Position size ≤ 2% of bankroll** — never bet the farm even if logic says to
- **Daily loss limit: -$50** — auto-pause for the day
- **Max open positions: 5** — limit concurrent exposure
- **Kill switch on disconnection** — cancel all open orders if PM WS dies > 60s

## Live Architecture

### New components

**`src/live/clobClient.ts`** — Polymarket CLOB client
- Wallet/proxy connection (reuse pattern from polymarket-ai-bot)
- placeOrder(tokenId, side, price, size, orderType)
- cancelOrder(orderId)
- cancelAllOrders()
- getPositions() — read on-chain balances
- getOpenOrders()
- recordFill(orderId, callback) — WS subscribe for own fills

**`src/live/executor.ts`** — Live action processor
- Replaces `referee.ts processActions()` for live engines
- Engine emits `EngineAction[]`, executor calls real CLOB
- Tracks order IDs, reconciles fills back into engine state
- Enforces risk gates before placing each order

**`src/live/positionReconciler.ts`** — Truth source
- Periodically reads on-chain positions
- Compares to engine's local state
- Alerts on divergence
- Engine state must match reality (no phantom positions)

**`src/live/riskManager.ts`** — Hard limits
- Per-action: size cap, sanity check
- Per-day: loss limit, trade count limit
- Global: kill switch, pause flag
- Logs every rejection with reason

**`src/live/liveArena.ts`** — Live mode arena
- Loads ONLY graduated engines (from a `live_engines.json` whitelist)
- Calls executor instead of referee
- Subscribes to PM fills WS
- Single coin per process (like sim arena)
- Smaller polling cadence than sim (real RPC costs)

### Reuse from polymarket-ai-bot

The sister repo has battle-tested:
- ethers v5 wallet/provider with failover (already imported via @ethersproject)
- CLOB API client (`src/services/clob/`)
- Order placement, signing, polling
- Position queries via Data API
- Fill webhooks

Plan: import these as utilities, don't rewrite. Extract the CLOB client into a small shared module if needed.

### Engine interface changes

Engines need to know if they're running live or paper:

```ts
interface EngineState {
  // ... existing fields
  isLive: boolean;        // true if real money
  liveBankroll?: number;  // separate from sim cashBalance
  livePositions?: Map<string, RealPosition>;
}
```

A live-graduated engine runs in BOTH modes simultaneously:
- Sim mode: accumulates round_history for ongoing evaluation
- Live mode: executes real trades on its own bankroll

If sim performance degrades below criteria, live mode auto-pauses.

## Workflow

1. **Sim runs continuously** on `main` branch (current setup)
2. **Graduation check** runs after each round:
   - For each engine, evaluate criteria above
   - Add passing engines to `data/live_engines.json`
   - Remove failing engines (with grace period for transient dips)
3. **Live arena** is a separate process (`quant-live-btc`, `quant-live-eth`, etc.)
   - Loads only whitelisted engines
   - Trades real money with strict caps
   - Logs every fill to a separate `live_ledger.db`
4. **Monitoring** via Telegram:
   - Live P&L per engine
   - Active orders
   - Recent fills
   - Risk events / paused engines

## Initial Bankroll

Start with $50 per live engine, mirroring sim. If 3 engines graduate × 3 coins = 9 instances × $50 = **$450 total at risk**. Acceptable to lose if everything blows up.

Scale up only after:
- 1 week live data with no incidents
- Live P&L within ±50% of sim P&L (proves sim is accurate)
- No unresolved bugs in reconciler

## Killswitch

Manual kill via Telegram command `/kill`:
1. Cancels all open orders across all engines
2. Sets all engines to paused
3. Sends summary of open positions
4. Optionally: market sells all positions (`/kill --liquidate`)

Auto-kill triggers:
- Cumulative live loss > $200 in a day
- Position count > 20 (something's wrong)
- PM WS disconnected > 5 min
- Reconciler detects > $20 divergence between local and on-chain
