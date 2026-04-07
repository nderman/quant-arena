/**
 * Quant Farm — Arena
 *
 * The main run loop. Executes engines from /engines in 6-hour rounds.
 * Maintains ledger.db with FeePaid, LatencySlippage, SignalSource.
 * Outputs round_intel.json so agents can spy on the leader's strategy.
 *
 * Borrowed patterns:
 *   - localPoller.ts (dual-interval loop, init sequence)
 *   - pipelineCommon.ts (shared orchestration)
 *   - paperTrader.ts (ledger recording pattern)
 */

import * as fs from "fs";
import * as path from "path";
import { CONFIG } from "./config";
import { pulseEvents, startSimulatedPulse, startPmChannel, startBinanceChannel, startMarketRotation, shutdown as shutdownPulse } from "./pulse";
import { processActions, markToMarket, clearFeePool } from "./referee";
import { recordFill, recordRoundStart, recordRoundEnd, getRoundSummary, closeDb } from "./ledger";
import { fetchSignalSnapshot } from "./signals";
import { discoverCryptoMarkets, discoverUpDownMarkets, discover5mMarkets } from "./discovery";
import { settleExpiredMarkets, trackMarketForSettlement, clearTrackedMarkets } from "./settlement";
import type {
  BaseEngine,
  EngineState,
  MarketTick,
  SignalSnapshot,
  RoundResult,
  EngineRoundResult,
  RoundIntel,
} from "./types";

// ── Active engine states (shared with market rotation for token ID updates) ──
let activeStates: Map<string, EngineState> | null = null;
let currentActiveTokenId = "";
let currentActiveDownTokenId = "";

// ── Engine Loading ───────────────────────────────────────────────────────────

/**
 * Load all engines from the engines directory.
 * Each engine file must export a class that implements BaseEngine.
 */
function loadEngines(): BaseEngine[] {
  const engines: BaseEngine[] = [];

  // Built-in engines
  const builtinDir = path.resolve(__dirname, "engines");
  if (fs.existsSync(builtinDir)) {
    const files = fs.readdirSync(builtinDir).filter(f =>
      (f.endsWith(".ts") || f.endsWith(".js")) && !f.startsWith("Base")
    );
    for (const file of files) {
      try {
        const mod = require(path.join(builtinDir, file));
        // Find the exported class (first export that has onTick)
        for (const key of Object.keys(mod)) {
          if (typeof mod[key] === "function") {
            const instance = new mod[key]();
            if (typeof instance.onTick === "function") {
              engines.push(instance);
              console.log(`[arena] Loaded built-in engine: ${instance.name} (${instance.id})`);
              break;
            }
          }
        }
      } catch (err: any) {
        console.error(`[arena] Failed to load engine ${file}:`, err.message);
      }
    }
  }

  // User engines from configurable directory
  const userDir = path.resolve(CONFIG.ENGINES_DIR);
  if (fs.existsSync(userDir) && userDir !== builtinDir) {
    const files = fs.readdirSync(userDir).filter(f =>
      f.endsWith(".ts") || f.endsWith(".js")
    );
    for (const file of files) {
      try {
        const mod = require(path.join(userDir, file));
        for (const key of Object.keys(mod)) {
          if (typeof mod[key] === "function") {
            const instance = new mod[key]();
            if (typeof instance.onTick === "function") {
              engines.push(instance);
              console.log(`[arena] Loaded user engine: ${instance.name} (${instance.id})`);
              break;
            }
          }
        }
      } catch (err: any) {
        console.error(`[arena] Failed to load user engine ${file}:`, err.message);
      }
    }
  }

  return engines;
}

// ── Engine State Factory ─────────────────────────────────────────────────────

function createEngineState(engineId: string): EngineState {
  return {
    engineId,
    positions: new Map(),
    cashBalance: CONFIG.STARTING_CASH,
    roundPnl: 0,
    tradeCount: 0,
    feePaid: 0,
    feeRebate: 0,
    slippageCost: 0,
    activeTokenId: currentActiveTokenId,
    activeDownTokenId: currentActiveDownTokenId,
  };
}

// ── Round Execution ──────────────────────────────────────────────────────────

async function runRound(
  roundId: string,
  engines: BaseEngine[],
): Promise<RoundResult> {
  const startedAt = new Date().toISOString();
  const roundStart = Date.now();

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[arena] Round ${roundId} starting — ${engines.length} engines competing`);
  console.log(`[arena] Duration: ${(CONFIG.ROUND_DURATION_MS / 3600_000).toFixed(1)}h, Starting cash: $${CONFIG.STARTING_CASH}`);
  console.log(`${"=".repeat(60)}\n`);

  recordRoundStart(roundId);

  // Initialize engine states
  const states = new Map<string, EngineState>();
  const statesForSettlement = new Map<string, { engineId: string; state: EngineState }>();
  for (const engine of engines) {
    const state = createEngineState(engine.id);
    states.set(engine.id, state);
    statesForSettlement.set(engine.id, { engineId: engine.id, state });
    engine.init(state);
  }
  clearTrackedMarkets();
  clearFeePool();
  activeStates = states;

  // Track last tick for mark-to-market (PM only — Binance prices are in a different range)
  let lastPmTick: MarketTick | undefined;
  let tickCount = 0;

  // ── Fetch signals periodically (every 60s) ──
  let latestSignals: SignalSnapshot | undefined;
  const signalInterval = setInterval(async () => {
    try {
      latestSignals = await fetchSignalSnapshot(CONFIG.BINANCE_SYMBOL.toUpperCase());
    } catch { /* non-critical */ }
  }, 60_000);
  // Initial fetch
  fetchSignalSnapshot(CONFIG.BINANCE_SYMBOL.toUpperCase())
    .then(s => { latestSignals = s; })
    .catch(() => {});

  // ── Tick handler: feed every tick to every engine ──
  const onTick = async (tick: MarketTick) => {
    if (tick.source === "polymarket") lastPmTick = tick;
    tickCount++;

    for (const engine of engines) {
      const state = states.get(engine.id)!;

      try {
        // Safety timeout: kill onTick if engine takes too long (OpenClaw LLM-generated code protection)
        const tickStart = Date.now();
        const actions = engine.onTick(tick, state, latestSignals);
        const tickMs = Date.now() - tickStart;
        if (tickMs > CONFIG.ENGINE_TICK_TIMEOUT_MS) {
          console.warn(`[arena] ${engine.id} onTick took ${tickMs}ms (limit: ${CONFIG.ENGINE_TICK_TIMEOUT_MS}ms) — skipping`);
          continue;
        }
        if (actions.length === 0) continue;

        // Process through referee (fees, latency, toxic flow)
        const fills = await processActions(actions, state);

        // Record to ledger
        for (const fill of fills) {
          if (fill.filled) {
            recordFill(roundId, engine.id, fill, state, fill.pnl);

            if (fill.toxicFlowHit) {
              console.log(`[arena] ${engine.id} TOXIC FLOW: ${fill.action.side} ${fill.fillSize}@${fill.fillPrice.toFixed(4)} (slippage: ${fill.slippage.toFixed(4)})`);
            }
          }
        }
      } catch (err: any) {
        console.error(`[arena] Engine ${engine.id} error on tick:`, err.message);
      }
    }

    // ── Settlement check (every 50 ticks) ──
    if (tickCount % 50 === 0) {
      settleExpiredMarkets(statesForSettlement);
    }

    // Periodic status (every 100 ticks, PM price only)
    if (tickCount % 100 === 0 && lastPmTick) {
      const price = lastPmTick.midPrice;
      console.log(`\n[arena] === Tick #${tickCount} | Price: ${price.toFixed(4)} ===`);
      for (const engine of engines) {
        const s = states.get(engine.id)!;
        const mtm = markToMarket(s, price);
        const total = s.cashBalance + mtm;
        const pnl = total - CONFIG.STARTING_CASH;
        const rebateStr = s.feeRebate > 0 ? ` rebate=$${s.feeRebate.toFixed(4)}` : "";
        console.log(`  ${engine.id}: cash=$${s.cashBalance.toFixed(2)} mtm=$${mtm.toFixed(2)} pnl=${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} trades=${s.tradeCount} fees=$${s.feePaid.toFixed(4)}${rebateStr}`);
      }
    }
  };

  pulseEvents.on("tick", onTick);

  // ── Wait for round duration ──
  try {
    await new Promise<void>(resolve => {
      setTimeout(() => resolve(), CONFIG.ROUND_DURATION_MS);
    });
  } finally {
    pulseEvents.off("tick", onTick);
    clearInterval(signalInterval);
  }

  // ── Round end: compute results ──
  const endedAt = new Date().toISOString();
  const durationMs = Date.now() - roundStart;
  const finalPrice = lastPmTick?.midPrice ?? 0.50;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`[arena] Round ${roundId} complete — ${tickCount} ticks processed`);
  console.log(`${"=".repeat(60)}`);

  const results: EngineRoundResult[] = [];

  for (const engine of engines) {
    const state = states.get(engine.id)!;
    engine.onRoundEnd(state);

    const posValue = markToMarket(state, finalPrice);
    const totalPnl = (state.cashBalance + posValue) - CONFIG.STARTING_CASH;

    const sharpe = state.tradeCount > 0 ? totalPnl / Math.max(state.feePaid + state.slippageCost, 0.01) : 0;

    // Compute win rate from ledger
    const roundTrades = getRoundSummary(roundId);
    const engineSummary = roundTrades.find(s => s.engineId === engine.id);
    const winRate = engineSummary && engineSummary.tradeCount > 0
      ? Math.max(0, engineSummary.totalPnl > 0 ? 1 : 0) // per-round — refine with trade-level later
      : 0;

    const result: EngineRoundResult = {
      engineId: engine.id,
      finalCash: state.cashBalance,
      positionValue: posValue,
      totalPnl,
      tradeCount: state.tradeCount,
      feePaid: state.feePaid,
      slippageCost: state.slippageCost,
      winRate,
      sharpeRatio: sharpe,
    };
    results.push(result);

    console.log(`\n  ${engine.name} (${engine.id}):`);
    console.log(`    Cash: $${state.cashBalance.toFixed(2)} | Positions: $${posValue.toFixed(2)}`);
    console.log(`    P&L: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} | Trades: ${state.tradeCount}`);
    console.log(`    Fees: $${state.feePaid.toFixed(4)} | Slippage: $${state.slippageCost.toFixed(4)}`);
  }

  // Sort by P&L
  results.sort((a, b) => b.totalPnl - a.totalPnl);

  const roundResult: RoundResult = { roundId, startedAt, endedAt, durationMs, results };

  // Record to DB
  recordRoundEnd(roundId, durationMs, JSON.stringify(results));

  // ── Output round_intel.json (agents spy on the leader) ──
  writeRoundIntel(roundId, results);

  return roundResult;
}

// ── Round Intel Output ───────────────────────────────────────────────────────

function writeRoundIntel(roundId: string, results: EngineRoundResult[]): void {
  const leader = results[0];
  if (!leader) return;

  const intel: RoundIntel = {
    roundId,
    leaderEngineId: leader.engineId,
    leaderPnl: leader.totalPnl,
    leaderTradeCount: leader.tradeCount,
    leaderAvgFee: leader.tradeCount > 0 ? leader.feePaid / leader.tradeCount : 0,
    leaderStrategy: `${leader.engineId}: ${leader.tradeCount} trades, ${(leader.winRate * 100).toFixed(0)}% win, $${leader.feePaid.toFixed(4)} fees`,
    allResults: results,
  };

  const dir = path.dirname(CONFIG.ROUND_INTEL_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG.ROUND_INTEL_PATH, JSON.stringify(intel, null, 2));
  console.log(`\n[arena] Round intel written to ${CONFIG.ROUND_INTEL_PATH}`);
  console.log(`[arena] Leader: ${leader.engineId} with P&L ${leader.totalPnl >= 0 ? "+" : ""}$${leader.totalPnl.toFixed(2)}`);
}

// ── Main Loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║              QUANT FARM — Evolutionary Arena          ║
║     Polymarket Strategy Bot Competition Engine        ║
╚═══════════════════════════════════════════════════════╝
`);

  // Load engines
  const engines = loadEngines();
  if (engines.length === 0) {
    console.error("[arena] No engines found. Add engines to src/engines/ or set ENGINES_DIR.");
    process.exit(1);
  }
  console.log(`[arena] ${engines.length} engines loaded\n`);

  // ── Auto-discover markets if no condition ID set ──
  if (!CONFIG.PM_CONDITION_ID && !CONFIG.DRY_RUN) {
    console.log("[arena] No PM_CONDITION_ID set — auto-discovering markets...\n");
    try {
      // Try 5M markets first (highest frequency, best for arena testing)
      const fiveMin = await discover5mMarkets({ tokens: ["btc", "eth", "xrp"] });
      const updown = await discoverUpDownMarkets({ intervals: ["1H", "4H"], limit: 5 });
      const crypto = await discoverCryptoMarkets({ limit: 5 });
      const all = [...fiveMin, ...updown, ...crypto];

      // Prefer 5M markets, then sort by liquidity
      all.sort((a, b) => {
        const a5m = a.slug?.includes("-5m-") ? 1 : 0;
        const b5m = b.slug?.includes("-5m-") ? 1 : 0;
        if (a5m !== b5m) return b5m - a5m; // 5M first
        return b.liquidity - a.liquidity;
      });

      if (all.length > 0) {
        const pick = all[0];
        CONFIG.PM_CONDITION_ID = pick.yesTokenId;
        currentActiveTokenId = pick.yesTokenId;
        currentActiveDownTokenId = pick.noTokenId;
        console.log(`\n[arena] Auto-selected: "${pick.title}"`);
        console.log(`  UP token:   ${pick.yesTokenId.slice(0, 20)}...`);
        console.log(`  DOWN token: ${pick.noTokenId.slice(0, 20)}...\n`);

        // Register initial market + all discovered 5M markets for settlement (both UP and DOWN tokens)
        for (const m of all.filter(m => m.slug?.includes("-5m-"))) {
          const tokenSlug = m.slug.split("-updown-")[0]?.toUpperCase() || "BTC";
          const windowStart = new Date(m.endDate).getTime() - 300_000;
          const windowEnd = new Date(m.endDate).getTime();
          const symbol = tokenSlug + "USDT";
          trackMarketForSettlement({
            tokenId: m.yesTokenId, side: "UP",
            windowStart, windowEnd, openPrice: 0, symbol,
          });
          trackMarketForSettlement({
            tokenId: m.noTokenId, side: "DOWN",
            windowStart, windowEnd, openPrice: 0, symbol,
          });
        }
      } else {
        console.log("[arena] No live crypto markets found — falling back to simulated pulse");
      }
    } catch (err: any) {
      console.error("[arena] Discovery failed:", err.message, "— falling back to simulated pulse");
    }
  }

  // Start data pulse
  if (CONFIG.DRY_RUN || !CONFIG.PM_CONDITION_ID) {
    console.log("[arena] DRY_RUN or no PM_CONDITION_ID — using simulated pulse");
    startSimulatedPulse({
      startPrice: 0.50 + (Math.random() - 0.5) * 0.4,
      volatility: 0.008,
      intervalMs: CONFIG.TICK_INTERVAL_MS,
    });
  } else {
    startPmChannel();
    startBinanceChannel();

    // For 5M markets: rotate subscription every 2 min as markets expire
    // Also register each market for settlement tracking
    startMarketRotation(async () => {
      const markets = await discover5mMarkets({ tokens: ["btc", "eth", "xrp"] });
      if (markets.length === 0) return null;

      // Register all discovered markets for settlement (both UP and DOWN tokens)
      for (const m of markets) {
        const tokenSlug = m.slug.split("-updown-")[0]?.toUpperCase() || "BTC";
        const binanceSymbol = tokenSlug + "USDT";
        const windowStart = new Date(m.endDate).getTime() - 300_000;
        const windowEnd = new Date(m.endDate).getTime();
        trackMarketForSettlement({
          tokenId: m.yesTokenId, side: "UP",
          windowStart, windowEnd, openPrice: 0, symbol: binanceSymbol,
        });
        trackMarketForSettlement({
          tokenId: m.noTokenId, side: "DOWN",
          windowStart, windowEnd, openPrice: 0, symbol: binanceSymbol,
        });
      }

      // Pick market with most time remaining
      markets.sort((a, b) =>
        new Date(b.endDate).getTime() - new Date(a.endDate).getTime()
      );
      const picked = markets[0];

      // Update all engine states with both UP and DOWN tokens
      currentActiveTokenId = picked.yesTokenId;
      currentActiveDownTokenId = picked.noTokenId;
      if (activeStates) {
        for (const [, state] of activeStates) {
          state.activeTokenId = picked.yesTokenId;
          state.activeDownTokenId = picked.noTokenId;
        }
      }

      return picked.yesTokenId;
    }, 120_000);
  }

  // Wait for first tick
  await new Promise<void>(resolve => {
    pulseEvents.once("tick", () => resolve());
  });
  console.log("[arena] First tick received — starting rounds\n");

  // Run rounds
  let roundNum = 0;
  const maxRounds = CONFIG.MAX_ROUNDS;

  while (true) {
    roundNum++;
    if (maxRounds > 0 && roundNum > maxRounds) {
      console.log(`[arena] Max rounds (${maxRounds}) reached. Stopping.`);
      break;
    }

    const roundId = `R${String(roundNum).padStart(4, "0")}-${Date.now()}`;

    try {
      const result = await runRound(roundId, engines);

      console.log(`\n[arena] Round ${roundNum} results:`);
      for (let i = 0; i < result.results.length; i++) {
        const r = result.results[i];
        const medal = i === 0 ? "👑" : i === 1 ? "🥈" : i === 2 ? "🥉" : "  ";
        console.log(`  ${medal} #${i + 1} ${r.engineId}: ${r.totalPnl >= 0 ? "+" : ""}$${r.totalPnl.toFixed(2)} (${r.tradeCount} trades, $${r.feePaid.toFixed(4)} fees)`);
      }
    } catch (err: any) {
      console.error(`[arena] Round ${roundNum} failed:`, err.message);
    }

    // Brief pause between rounds
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  // Cleanup
  shutdownPulse();
  closeDb();
  console.log("\n[arena] Shutdown complete.");
}

// ── Graceful shutdown ────────────────────────────────────────────────────────

function gracefulShutdown(code = 0): void {
  shutdownPulse();
  closeDb();
  process.exit(code);
}

process.on("SIGINT", () => { console.log("\n[arena] SIGINT received"); gracefulShutdown(); });
process.on("SIGTERM", () => { console.log("\n[arena] SIGTERM received"); gracefulShutdown(); });

// ── Entry Point ──────────────────────────────────────────────────────────────

main().catch(err => {
  console.error("[arena] Fatal error:", err);
  gracefulShutdown(1);
});
