// Multi-coin arena: one process per coin, sharing engines but separate ledgers
const COINS = ["btc", "eth", "sol"]; // adding SOL — validated PM uses Chainlink SOL/USD

const arenaApp = (coin) => ({
  name: `quant-arena-${coin}`,
  script: "./dist/arena.js",
  instances: 1,
  exec_mode: "fork",
  max_memory_restart: "1G",
  node_args: "--max-old-space-size=1024",
  env: {
    NODE_ENV: "production",
    ARENA_COIN: coin,
    STARTING_CASH: "50",
    MAX_ROUNDS: "0",
    LATENCY_MS: "50",
    ROUND_DURATION_MS: "3600000",
  },
  exp_backoff_restart_delay: 100,
  log_date_format: "YYYY-MM-DD HH:mm:ss Z",
  merge_logs: true,
  error_file: `./logs/arena-${coin}-error.log`,
  out_file: `./logs/arena-${coin}-out.log`,
});

const breederApp = (coin) => ({
  name: `quant-breeder-${coin}`,
  script: "./dist/breeder.js",
  args: "--loop",
  instances: 1,
  exec_mode: "fork",
  max_memory_restart: "512M",
  autorestart: true,
  env: {
    NODE_ENV: "production",
    ARENA_COIN: coin,
  },
  exp_backoff_restart_delay: 5000,
  log_date_format: "YYYY-MM-DD HH:mm:ss Z",
  merge_logs: true,
  error_file: `./logs/breeder-${coin}-error.log`,
  out_file: `./logs/breeder-${coin}-out.log`,
});

module.exports = {
  apps: [
    ...COINS.map(arenaApp),
    ...COINS.map(breederApp),
    {
      name: "quant-telegram",
      script: "./dist/telegram.js",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "256M",
      autorestart: true,
      env: {
        NODE_ENV: "production",
      },
      exp_backoff_restart_delay: 5000,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      error_file: "./logs/telegram-error.log",
      out_file: "./logs/telegram-out.log",
    },
  ],
};
