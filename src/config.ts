/**
 * Quant Farm — Configuration
 *
 * Environment-driven config, same pattern as polymarket-ai-bot.
 */

const num = (key: string, def: number): number => Number(process.env[key] ?? def);
const bool = (key: string, def = false): boolean =>
  process.env[key] === "1" || process.env[key] === "true" || (process.env[key] === undefined && def);
const str = (key: string, def: string): string => process.env[key] ?? def;

export const CONFIG = {
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
  MAKER_FILL_PROBABILITY: num("MAKER_FILL_PROBABILITY", 0.60),          // 60% chance maker order fills per tick (queue position)
  MAKER_REBATE_RATE:      num("MAKER_REBATE_RATE", 0.20),               // makers get 20% of taker fees collected
  MAKER_ADVERSE_BPS:      num("MAKER_ADVERSE_BPS", 5),                  // 5bps adverse selection on maker fills
  MIN_ORDER_SIZE:          num("MIN_ORDER_SIZE", 5),                     // CLOB rejects < 5 shares
  MIN_MERGE_SIZE:          num("MIN_MERGE_SIZE", 1),                     // merge is on-chain, not CLOB (1 share min)

  // ── Engine Safety ─────────────────────────────────────────────────────────
  ENGINE_TICK_TIMEOUT_MS:  num("ENGINE_TICK_TIMEOUT_MS", 50),            // kill onTick if > 50ms (OpenClaw safety)
  STALE_DATA_THRESHOLD_MS: num("STALE_DATA_THRESHOLD_MS", 30_000),      // force PM reconnect if no data for this long
  STALE_DATA_CHECK_MS:     num("STALE_DATA_CHECK_MS", 10_000),          // how often to check for stale data

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
  LEDGER_DB_PATH:         str("LEDGER_DB_PATH", "./data/ledger.db"),

  // ── Logging ────────────────────────────────────────────────────────────────
  LOG_LEVEL:              str("LOG_LEVEL", "info"),
  ROUND_INTEL_PATH:       str("ROUND_INTEL_PATH", "./data/round_intel.json"),
};
