/**
 * Quant Farm — Configuration
 *
 * Environment-driven config, same pattern as polymarket-ai-bot.
 */

const num = (key: string, def: number): number => Number(process.env[key] ?? def);
const bool = (key: string, def = false): boolean =>
  process.env[key] === "1" || process.env[key] === "true" || (process.env[key] === undefined && def);
const str = (key: string, def: string): string => process.env[key] ?? def;

// Coin to Binance symbol mapping
const COIN_TO_BINANCE: Record<string, string> = {
  btc: "BTCUSDT",
  eth: "ETHUSDT",
  sol: "SOLUSDT",
  xrp: "XRPUSDT",
};

const _coin = str("ARENA_COIN", "btc").toLowerCase();
const _binanceSymbol = COIN_TO_BINANCE[_coin] || "BTCUSDT";

export const CONFIG = {
  // ── Multi-coin ─────────────────────────────────────────────────────────────
  ARENA_COIN:             _coin,                                         // btc/eth/sol/xrp
  ARENA_INSTANCE_ID:      str("ARENA_INSTANCE_ID", _coin),                // ledger/intel file suffix
  ARENA_BINANCE_SYMBOL:   _binanceSymbol,                                  // BTCUSDT/ETHUSDT/etc
  ARENA_SLUG_PREFIX:      `${_coin}-updown-5m`,                            // for settlement filter

  // ── Arena ──────────────────────────────────────────────────────────────────
  ROUND_DURATION_MS:      num("ROUND_DURATION_MS", 6 * 3600_000),       // 6 hours
  STARTING_CASH:          num("STARTING_CASH", 1000),                    // USDC per engine
  TICK_INTERVAL_MS:       num("TICK_INTERVAL_MS", 5000),                 // 5s between ticks
  DRY_RUN:                bool("DRY_RUN", false),
  MAX_ROUNDS:             num("MAX_ROUNDS", 0),                          // 0 = infinite
  ENGINES_DIR:            str("ENGINES_DIR", "./engines"),

  // ── Referee ────────────────────────────────────────────────────────────────
  PEAK_FEE_RATE:          num("PEAK_FEE_RATE", 0.015625),               // 1.5625% max (quartic formula, Apr 2026)
  LATENCY_MS:             num("LATENCY_MS", 50),                         // 50ms realistic API/WS lag (500ms delay removed Feb 2026)
  MERGE_FEE_RATE:         num("MERGE_FEE_RATE", 0),                     // merge contract is free (just gas + opposite buy fee)
  TOXIC_FLOW_ENABLED:     bool("TOXIC_FLOW_ENABLED", true),
  TOXIC_FLOW_PROBABILITY: num("TOXIC_FLOW_PROBABILITY", 0.15),          // 15% chance per fill
  TOXIC_FLOW_BPS:         num("TOXIC_FLOW_BPS", 50),                    // 50bps adverse move

  // ── Fill Decay (reactive market makers) ────────────────────────────────────
  FILL_DECAY_ENABLED:     bool("FILL_DECAY_ENABLED", true),
  FILL_DECAY_MULTIPLIER:  num("FILL_DECAY_MULTIPLIER", 1.2),           // 1.2x worse per level consumed

  // ── Network Layer (Polygon gas + MEV) ──────────────────────────────────────
  GAS_COST_USD:           num("GAS_COST_USD", 0.04),                    // $0.04 base per tx (scales with vol)
  GAS_VOL_MULTIPLIER:     num("GAS_VOL_MULTIPLIER", 5),                 // gas multiplier at peak vol (5x = $0.20)
  MEV_THRESHOLD_USD:      num("MEV_THRESHOLD_USD", 100),                // orders > $100 get MEV'd
  MEV_SLIPPAGE_BPS:       num("MEV_SLIPPAGE_BPS", 5),                   // 5bps hidden slippage

  // ── Maker / Taker ──────────────────────────────────────────────────────────
  MAKER_FILL_PROBABILITY: num("MAKER_FILL_PROBABILITY", 0.12),          // 12% — realistic queue priority vs HFT (was 60%, way too generous)
  MAKER_REBATE_RATE:      num("MAKER_REBATE_RATE", 0.20),               // makers get 20% of taker fees collected
  MAKER_ADVERSE_BPS:      num("MAKER_ADVERSE_BPS", 5),                  // 5bps adverse selection on maker fills
  MIN_ORDER_SIZE:          num("MIN_ORDER_SIZE", 5),                     // CLOB rejects < 5 shares
  MIN_MERGE_SIZE:          num("MIN_MERGE_SIZE", 1),                     // merge is on-chain, not CLOB (1 share min)

  // ── Engine Safety ─────────────────────────────────────────────────────────
  ENGINE_TICK_TIMEOUT_MS:  num("ENGINE_TICK_TIMEOUT_MS", 50),            // kill onTick if > 50ms (OpenClaw safety)
  STALE_DATA_THRESHOLD_MS: num("STALE_DATA_THRESHOLD_MS", 10_000),      // force PM reconnect if no data for 10s
  STALE_DATA_CHECK_MS:     num("STALE_DATA_CHECK_MS", 5_000),           // check for stale data every 5s

  // ── On-Chain ──────────────────────────────────────────────────────────────
  ON_CHAIN_LATENCY_MS:    num("ON_CHAIN_LATENCY_MS", 3000),              // 3s Polygon tx finality for MERGE

  // ── Settlement ────────────────────────────────────────────────────────────
  SETTLEMENT_DELAY_MS_MIN: num("SETTLEMENT_DELAY_MS_MIN", 30_000),      // min oracle purgatory (30s)
  SETTLEMENT_DELAY_MS_MAX: num("SETTLEMENT_DELAY_MS_MAX", 120_000),     // max oracle purgatory (2min)

  // ── Oracle / Settlement ────────────────────────────────────────────────────
  ORACLE_NOISE_ENABLED:   bool("ORACLE_NOISE_ENABLED", true),
  ORACLE_NOISE_BPS:       num("ORACLE_NOISE_BPS", 35),                  // ±35bps std dev vs Binance spot (UMA 30-min TWAP divergence)

  // ── Pulse / Data ───────────────────────────────────────────────────────────
  PM_WS_URL:              str("PM_WS_URL", "wss://ws-subscriptions-clob.polymarket.com/ws/market"),
  BINANCE_WS_URL:         str("BINANCE_WS_URL", "wss://stream.binance.com:9443/ws"),
  BINANCE_SYMBOL:         str("BINANCE_SYMBOL", "btcusdt"),             // primary symbol
  BINANCE_EXTRA_SYMBOLS:  str("BINANCE_EXTRA_SYMBOLS", "ethusdt,xrpusdt"), // additional symbols
  PM_CONDITION_ID:        str("PM_CONDITION_ID", ""),                    // polymarket market to track (mutable for auto-discovery)

  // ── Ledger ─────────────────────────────────────────────────────────────────
  LEDGER_DB_PATH:         str("LEDGER_DB_PATH", `./data/ledger_${_coin}.db`),

  // ── Logging ────────────────────────────────────────────────────────────────
  LOG_LEVEL:              str("LOG_LEVEL", "info"),
  ROUND_INTEL_PATH:       str("ROUND_INTEL_PATH", `./data/round_intel_${_coin}.json`),

  // ── Sanity / phantom alpha ────────────────────────────────────────────────
  PHANTOM_PNL_MULTIPLIER: num("PHANTOM_PNL_MULTIPLIER", 10),  // round PnL > STARTING_CASH × this is flagged as likely sim bug
  DUAL_BOOK_MIN_SUM:      num("DUAL_BOOK_MIN_SUM", 0.95),    // UP_ask + DOWN_ask must be ≥ this; lower means stale/corrupt book data. Real PM arbitrageurs keep sums > 0.97; anything below 0.95 is structurally impossible

  // ── Snipe-stale-makers cancellation model ─────────────────────────────────
  SNIPE_MOMENTUM_WINDOW_MS: num("SNIPE_MOMENTUM_WINDOW_MS", 5_000),  // window for cumulative Binance momentum
  SNIPE_MIN_MOMENTUM:       num("SNIPE_MIN_MOMENTUM", 0.0005),       // 5 bps cumulative move triggers cancellation risk
  SNIPE_BOOK_STALE_MS:      num("SNIPE_BOOK_STALE_MS", 100),         // book older than this since the move = stale snipe target
  SNIPE_CANCEL_PROB_PER_BPS: num("SNIPE_CANCEL_PROB_PER_BPS", 0.10), // each bps of momentum adds 10% cancellation probability
  SNIPE_CANCEL_PROB_MAX:    num("SNIPE_CANCEL_PROB_MAX", 0.95),      // hard cap on rejection probability

  // ── PM book validation ────────────────────────────────────────────────────
  PM_PRICE_MIN:              num("PM_PRICE_MIN", 0.005),              // floor for any tradeable PM price
  PM_PRICE_MAX:              num("PM_PRICE_MAX", 0.995),              // ceiling for any tradeable PM price
  PM_BOOK_MAX_SPREAD:        num("PM_BOOK_MAX_SPREAD", 0.50),         // wider than this = half-empty/stale book
  PM_BOOK_STALE_MS:          num("PM_BOOK_STALE_MS", 3_000),          // books older than this are not tradeable. Real PM arb bots treat >500ms as dead; 3000ms accommodates quiet-market WS gaps without allowing the "frozen side" stale-book exploits that 30s permitted.
  PM_BOOK_MAX_JUMP_FRACTION: num("PM_BOOK_MAX_JUMP_FRACTION", 0.25),  // single-update price jump > this = transient quote, reject
  PM_BOOK_PREV_STALE_MS:     num("PM_BOOK_PREV_STALE_MS", 10_000),    // prev book older than this = no comparison baseline, accept
};
