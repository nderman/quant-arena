module.exports = {
  apps: [
    {
      name: "quant-arena",
      script: "./dist/arena.js",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "3G",
      node_args: "--max-old-space-size=3072",
      env: {
        NODE_ENV: "production",
        STARTING_CASH: "50",
        MAX_ROUNDS: "0",
        LATENCY_MS: "300",
        ROUND_DURATION_MS: "21600000",
      },
      exp_backoff_restart_delay: 100,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
    },
    {
      name: "quant-breeder",
      script: "./dist/breeder.js",
      args: "--loop",
      instances: 1,
      exec_mode: "fork",
      max_memory_restart: "512M",
      autorestart: true,
      env: {
        NODE_ENV: "production",
        // Set on the VPS: pm2 env quant-breeder OPENROUTER_API_KEY=sk-or-...
        // OPENROUTER_API_KEY: "",
      },
      exp_backoff_restart_delay: 5000,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      error_file: "./logs/breeder-error.log",
      out_file: "./logs/breeder-out.log",
    },
  ],
};
