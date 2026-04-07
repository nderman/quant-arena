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
  PEAK_FEE_RATE:          num("PEAK_FEE_RATE", 0.018),                  // 1.8% crypto 2026
  LATENCY_MS:             num("LATENCY_MS", 300),                        // simulated fill delay
  MERGE_FEE_RATE:         num("MERGE_FEE_RATE", 0.001),                 // 0.1% flat gas offset
  TOXIC_FLOW_ENABLED:     bool("TOXIC_FLOW_ENABLED", true),
  TOXIC_FLOW_PROBABILITY: num("TOXIC_FLOW_PROBABILITY", 0.15),          // 15% chance per fill
  TOXIC_FLOW_BPS:         num("TOXIC_FLOW_BPS", 50),                    // 50bps adverse move

  // ── Fill Decay (reactive market makers) ────────────────────────────────────
  FILL_DECAY_ENABLED:     bool("FILL_DECAY_ENABLED", true),
  FILL_DECAY_MULTIPLIER:  num("FILL_DECAY_MULTIPLIER", 1.2),           // 1.2x worse per level consumed

  // ── Network Layer (Polygon gas + MEV) ──────────────────────────────────────
  GAS_COST_USD:           num("GAS_COST_USD", 0.04),                    // $0.04 flat per tx
  MEV_THRESHOLD_USD:      num("MEV_THRESHOLD_USD", 100),                // orders > $100 get MEV'd
  MEV_SLIPPAGE_BPS:       num("MEV_SLIPPAGE_BPS", 5),                   // 5bps hidden slippage

  // ── Maker / Taker ──────────────────────────────────────────────────────────
  MAKER_FILL_PROBABILITY: num("MAKER_FILL_PROBABILITY", 0.60),          // 60% chance maker order fills per tick (queue position)
  MAKER_REBATE_RATE:      num("MAKER_REBATE_RATE", 0.20),               // makers get 20% of taker fees collected
  MIN_ORDER_SIZE:          num("MIN_ORDER_SIZE", 5),                     // CLOB rejects < 5 shares

  // ── Oracle / Settlement ────────────────────────────────────────────────────
  ORACLE_NOISE_ENABLED:   bool("ORACLE_NOISE_ENABLED", true),
  ORACLE_NOISE_BPS:       num("ORACLE_NOISE_BPS", 15),                  // ±15bps std dev vs Binance spot

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
