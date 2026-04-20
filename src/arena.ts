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
import * as dotenv from "dotenv";
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });
import { CONFIG } from "./config";
import { pulseEvents, startSimulatedPulse, startPmChannel, startBinanceChannel, startMarketRotation, setPmSubscriptionTokens, shutdown as shutdownPulse } from "./pulse";
import { processActions, processMergeActions, markToMarket, clearFeePool, clearFeePoolForMarket, snapshotTickBooks } from "./referee";
import { recordFill, recordRoundStart, recordRoundEnd, getRoundSummary, closeDb, flushLedger } from "./ledger";
import { fetchSignalSnapshot } from "./signals";
import { discoverCryptoMarkets, discoverUpDownMarkets, discover5mMarkets } from "./discovery";
import { pollAndSettle } from "./settlement";
import { startChainlinkPoller } from "./chainlink";
import { seedRng, random } from "./rng";
import { startLiveArena, type LiveArenaHandle } from "./live/liveArena";
import { buildDryRunAdapter } from "./live/dryRunAdapter";
import type {
  BaseEngine,
  EngineAction,
  EngineState,
  MarketTick,
  SignalSnapshot,
  RoundResult,
  EngineRoundResult,
  RoundIntel,
} from "./types";

// ── Active engine states (shared with market rotation for token ID updates) ──
let activeStates: Map<string, EngineState> | null = null;
let liveArenaHandle: LiveArenaHandle | null = null;
let currentActiveTokenId = "";
let currentActiveDownTokenId = "";
let currentMarketSymbol = "";
let currentWindowEnd = 0;
let currentWindowStart = 0;

// ── Engine Loading ───────────────────────────────────────────────────────────

/**
 * Scan the engines directory for files not yet in the provided list and
 * append new engine instances to it. Used at round-start to pick up
 * freshly-bred engines without requiring a full arena restart.
 *
 * Returns the count of newly loaded engines.
 */
function reloadNewEngines(existing: BaseEngine[]): number {
  const existingIds = new Set(existing.map(e => e.id));
  const builtinDir = path.resolve(__dirname, "engines");
  if (!fs.existsSync(builtinDir)) return 0;

  const files = fs.readdirSync(builtinDir).filter(f =>
    (f.endsWith(".ts") || f.endsWith(".js")) && !f.startsWith("Base")
  );

  let added = 0;
  for (const file of files) {
    const fullPath = path.join(builtinDir, file);
    try {
      // Clear require cache for this file so we pick up the fresh version
      // (in case of dist rebuilds). Safe because engine files are self-
      // contained — they don't mutate shared module state.
      delete require.cache[require.resolve(fullPath)];
      const mod = require(fullPath);
      for (const key of Object.keys(mod)) {
        if (typeof mod[key] === "function") {
          const instance = new mod[key]();
          if (typeof instance.onTick === "function" && !existingIds.has(instance.id)) {
            existing.push(instance);
            existingIds.add(instance.id);
            added++;
            console.log(`[arena] Hot-loaded bred engine: ${instance.name} (${instance.id})`);
            break;
          }
        }
      }
    } catch (err: any) {
      // MODULE_NOT_FOUND is the expected case for a freshly-bred .ts engine
      // whose .js hasn't been compiled yet — skip quietly. Other failures
      // (syntax errors, constructor throws) are real bugs worth surfacing.
      if (err?.code !== "MODULE_NOT_FOUND") {
        console.error(`[arena] Failed to hot-load ${file}:`, err.message);
      }
    }
  }
  return added;
}

function loadEngines(): BaseEngine[] {
  const engines: BaseEngine[] = [];

  // Per-coin allow/disable filters. ENGINE_ALLOW is a whitelist (only these
  // load); ENGINE_DISABLE is a blacklist. ENGINE_ALLOW wins when both are set.
  // Set per PM2 process via ecosystem.config.js so you can, e.g., run
  // dca-deep on SOL only without editing code.
  const allowCsv = CONFIG.ENGINE_ALLOW.trim();
  const disableCsv = CONFIG.ENGINE_DISABLE.trim();
  const allow = allowCsv ? new Set(allowCsv.split(",").map(s => s.trim()).filter(Boolean)) : null;
  const disable = new Set(disableCsv.split(",").map(s => s.trim()).filter(Boolean));

  const shouldLoad = (engineId: string): boolean => {
    if (allow) return allow.has(engineId);
    return !disable.has(engineId);
  };

  const loadFromDir = (dir: string, kind: "built-in" | "user") => {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir).filter(f =>
      (f.endsWith(".ts") || f.endsWith(".js")) &&
      (kind === "user" || !f.startsWith("Base"))
    );
    for (const file of files) {
      try {
        const mod = require(path.join(dir, file));
        for (const key of Object.keys(mod)) {
          if (typeof mod[key] === "function") {
            const instance = new mod[key]();
            if (typeof instance.onTick === "function") {
              if (!shouldLoad(instance.id)) {
                console.log(`[arena] Skipped ${kind} engine: ${instance.id} (env filter)`);
              } else {
                engines.push(instance);
                console.log(`[arena] Loaded ${kind} engine: ${instance.name} (${instance.id})`);
              }
              break;
            }
          }
        }
      } catch (err: any) {
        console.error(`[arena] Failed to load engine ${file}:`, err.message);
      }
    }
  };

  const builtinDir = path.resolve(__dirname, "engines");
  loadFromDir(builtinDir, "built-in");

  const userDir = path.resolve(CONFIG.ENGINES_DIR);
  if (userDir !== builtinDir) loadFromDir(userDir, "user");

  return engines;
}

/**
 * Purge Node's require cache for every engine file so the next loadEngines()
 * picks up fresh code. Called by the reload-flag handler in the main loop —
 * lets the surgical engine-only deploy script ship new engines without a
 * full pm2 restart (which would wipe in-flight positions).
 */
function clearEngineRequireCache(): void {
  const builtinDir = path.resolve(__dirname, "engines");
  const userDir = path.resolve(CONFIG.ENGINES_DIR);
  for (const cachedKey of Object.keys(require.cache)) {
    if (cachedKey.startsWith(builtinDir) || cachedKey.startsWith(userDir)) {
      delete require.cache[cachedKey];
    }
  }
}

/**
 * Path to the engine-reload flag for this coin. Touched by deploy-engines.sh
 * after a successful rsync; checked at every round boundary. Per-coin so a
 * BTC-only engine deploy doesn't disrupt the ETH/SOL arenas.
 *
 * Exported for unit tests.
 */
export function reloadFlagPath(): string {
  return path.resolve("data", `reload_engines_${CONFIG.ARENA_COIN}.flag`);
}

/**
 * Check the reload flag and rebuild the engine roster if present. Returns
 * the (possibly new) engines array. Safe to call between rounds — it
 * doesn't touch in-flight position state because positions live in
 * EngineState (held by the round loop), not on the engine instances.
 *
 * Exported for unit tests.
 */
export function maybeReloadEngines(current: BaseEngine[]): BaseEngine[] {
  const flag = reloadFlagPath();
  if (!fs.existsSync(flag)) return current;
  console.log(`[arena] Engine reload flag detected at ${flag} — rebuilding roster`);
  try {
    clearEngineRequireCache();
    const fresh = loadEngines();
    fs.unlinkSync(flag);
    if (fresh.length === 0) {
      console.error("[arena] Reload produced 0 engines — keeping previous roster");
      return current;
    }
    console.log(`[arena] Reload complete: ${fresh.length} engines (was ${current.length})`);
    return fresh;
  } catch (err: any) {
    console.error("[arena] Engine reload failed, keeping previous roster:", err.message);
    return current;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function slugToBinanceSymbol(slug: string): string {
  return (slug.split("-updown-")[0]?.toUpperCase() || "BTC") + "USDT";
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
    marketSymbol: currentMarketSymbol,
    marketWindowEnd: currentWindowEnd,
    marketWindowStart: currentWindowStart,
    rejectionCounts: {},
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

  // Hot-load any newly bred engines that appeared since last round
  const newCount = reloadNewEngines(engines);
  if (newCount > 0) {
    console.log(`[arena] Hot-loaded ${newCount} new engine(s) at round start`);
  }

  // Initialize engine states
  const states = new Map<string, EngineState>();
  const statesForSettlement = new Map<string, { engineId: string; state: EngineState }>();
  for (const engine of engines) {
    const state = createEngineState(engine.id);
    states.set(engine.id, state);
    statesForSettlement.set(engine.id, { engineId: engine.id, state });
    engine.init(state);
  }
  clearFeePool();
  activeStates = states;

  // Track last tick for mark-to-market (PM only — Binance prices are in a different range)
  let lastPmTick: MarketTick | undefined;
  let tickCount = 0;
  const allPendingMerges: { engineId: string; state: EngineState; merges: EngineAction[] }[] = [];

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

  // ── Settlement: poll Gamma API every 30s for closed markets ──
  const settlementInterval = setInterval(() => {
    pollAndSettle(statesForSettlement, { tokenSlugPrefix: CONFIG.ARENA_SLUG_PREFIX, roundId }).catch(err =>
      console.error("[arena] settlement error:", err.message)
    );
  }, 30_000);

  // ── Tick handler: feed every tick to every engine ──
  const onTick = async (tick: MarketTick) => {
    // Binance WS delivers all symbols; only pass the configured coin to engines
    if (tick.source === "binance" && tick.symbol !== CONFIG.ARENA_BINANCE_SYMBOL) return;

    if (tick.source === "polymarket") lastPmTick = tick;
    tickCount++;

    // Snapshot books once per tick — engines share depletion (no ghost liquidity)
    const tickBooks = currentActiveTokenId
      ? snapshotTickBooks(currentActiveTokenId, currentActiveDownTokenId)
      : undefined;

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

        // Process CLOB actions — share tickBooks across engines so liquidity depletes
        const { results: fills, pendingMerges } = await processActions(actions, state, tickBooks);

        // Record CLOB fills to ledger; rejection counts are tallied by referee.
        for (const fill of fills) {
          if (fill.filled) {
            recordFill(roundId, engine.id, fill, state, fill.pnl);
            if (fill.toxicFlowHit) {
              console.log(`[arena] ${engine.id} TOXIC FLOW: ${fill.action.side} ${fill.fillSize}@${fill.fillPrice.toFixed(4)} (slippage: ${fill.slippage.toFixed(4)})`);
            }
            // Mirror filled sim actions to live arena (if enabled + engine graduated)
            if (liveArenaHandle) {
              const positionSide = state.activeDownTokenId === fill.action.tokenId ? "NO" as const : "YES" as const;
              liveArenaHandle.onSimAction(engine.id, fill.action, positionSide).then(result => {
                if (result) {
                  if (result.accepted) {
                    console.log(`[live] ${engine.id} ${fill.action.side} ${result.sizedAction?.size ?? 0}@${(result.sizedAction?.price ?? 0).toFixed(3)} → accepted`);
                  } else {
                    console.log(`[live] ${engine.id} ${fill.action.side} rejected: ${result.reason}`);
                  }
                }
              }).catch(err => {
                console.warn(`[live-arena] ${engine.id} action failed: ${err.message}`);
              });
            }
          }
        }

        // Queue merges for global delay
        if (pendingMerges.length > 0) {
          allPendingMerges.push({ engineId: engine.id, state, merges: pendingMerges });
        }
      } catch (err: any) {
        console.error(`[arena] Engine ${engine.id} error on tick:`, err.message);
      }
    }

    // ── Process all pending MERGEs with single on-chain delay ──
    if (allPendingMerges.length > 0) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.ON_CHAIN_LATENCY_MS));
      // Re-snapshot books after the delay (the live PM book may have moved during 3s)
      const mergeTickBooks = currentActiveTokenId
        ? snapshotTickBooks(currentActiveTokenId, currentActiveDownTokenId)
        : undefined;
      for (const { engineId, state, merges } of allPendingMerges) {
        const mergeFills = await processMergeActions(merges, state, mergeTickBooks);
        for (const fill of mergeFills) {
          if (fill.filled) recordFill(roundId, engineId, fill, state, fill.pnl);
        }
      }
      allPendingMerges.length = 0;
    }


    // Flush ledger buffer to disk every 50 ticks (not every tick — defeats buffering)
    if (tickCount % 50 === 0) flushLedger();

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
    clearInterval(settlementInterval);
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
      rejectionCounts: { ...state.rejectionCounts },
    };
    results.push(result);

    console.log(`\n  ${engine.name} (${engine.id}):`);
    console.log(`    Cash: $${state.cashBalance.toFixed(2)} | Positions: $${posValue.toFixed(2)}`);
    console.log(`    P&L: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} | Trades: ${state.tradeCount}`);
    console.log(`    Fees: $${state.feePaid.toFixed(4)} | Slippage: $${state.slippageCost.toFixed(4)}`);
    const rejEntries = Object.entries(state.rejectionCounts);
    if (rejEntries.length > 0) {
      const totalRej = rejEntries.reduce((s, [, n]) => s + n, 0);
      const topReasons = rejEntries.sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([r, n]) => `${r}=${n}`).join(" ");
      console.log(`    Rejections: ${totalRej} total (${topReasons})`);
    }
  }

  // Sort by P&L
  results.sort((a, b) => b.totalPnl - a.totalPnl);

  // Phantom alpha detector: STARTING_CASH × multiplier (default 10x = $500)
  // is the absolute most a legitimate strategy could produce in one round.
  // Anything beyond is almost certainly a sim bug — flag loudly so we catch
  // it before it contaminates round_history and the breeder learns fake signal.
  const phantomThreshold = CONFIG.STARTING_CASH * CONFIG.PHANTOM_PNL_MULTIPLIER;
  for (const r of results) {
    if (r.totalPnl > phantomThreshold) {
      console.error(
        `\n🚨 [PHANTOM ALPHA] ${r.engineId} produced +$${r.totalPnl.toFixed(2)} ` +
        `in round ${roundId} (threshold $${phantomThreshold.toFixed(0)}). ` +
        `Likely sim bug — audit trades immediately.`
      );
    }
  }

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

  // Append to round history (breeder uses last N rounds for multi-round analysis)
  const historyPath = path.join(path.dirname(CONFIG.ROUND_INTEL_PATH), `round_history_${CONFIG.ARENA_COIN}.json`);
  let history: any[] = [];
  try { history = JSON.parse(fs.readFileSync(historyPath, "utf-8")); } catch {}
  history.push({ ...intel, timestamp: new Date().toISOString() });
  // Keep last 100 rounds (~200KB). Was 20, which caused the breeder to
  // never breed again: the marker said "20 rounds at last breed" and the
  // file always had exactly 20, so new-rounds count was permanently 0.
  if (history.length > 100) history = history.slice(-100);
  fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));

  // Flag graduation candidates AFTER history is updated. Read-only on
  // live_engines.json; only writes new candidates to live_candidates.json
  // for manual review. No auto-promote.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { flagGraduationCandidates } = require("./live/graduation");
    flagGraduationCandidates(CONFIG.ARENA_COIN, roundId);
  } catch (err) {
    console.warn(`[arena] graduation hook error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Main Loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║              QUANT FARM — Evolutionary Arena          ║
║     Polymarket Strategy Bot Competition Engine        ║
╚═══════════════════════════════════════════════════════╝
`);

  // Determinism: seed referee + sim-pulse RNG if RNG_SEED is set. 0 keeps
  // production non-determinism; non-zero replays exactly. Engines that use
  // their own Math.random aren't affected.
  if (CONFIG.RNG_SEED !== 0) {
    seedRng(CONFIG.RNG_SEED);
    console.log(`[arena] RNG seeded with ${CONFIG.RNG_SEED} — run is deterministic`);
  }

  // Load engines (mutable — surgical deploy can swap the roster between
  // rounds via the reload flag, see maybeReloadEngines)
  let engines = loadEngines();
  if (engines.length === 0) {
    console.error("[arena] No engines found. Add engines to src/engines/ or set ENGINES_DIR.");
    process.exit(1);
  }
  console.log(`[arena] ${engines.length} engines loaded\n`);

  // ── Auto-discover markets if no condition ID set ──
  if (!CONFIG.PM_CONDITION_ID && !CONFIG.DRY_RUN) {
    console.log("[arena] No PM_CONDITION_ID set — auto-discovering markets...\n");

    // Retry with backoff. We REQUIRE at least one 5M market for the configured coin —
    // never fall back to simulated pulse when running live (the whole point is real data).
    const maxAttempts = 10;
    let pick: { title?: string; slug?: string; endDate?: string; yesTokenId: string; noTokenId: string; liquidity: number } | null = null;
    for (let attempt = 1; attempt <= maxAttempts && !pick; attempt++) {
      // Each call is independent — one timeout shouldn't kill the others.
      const [fiveMinR, updownR, cryptoR] = await Promise.allSettled([
        discover5mMarkets({ tokens: [CONFIG.ARENA_COIN] }),
        discoverUpDownMarkets({ intervals: ["1H", "4H"], limit: 5 }),
        discoverCryptoMarkets({ limit: 5 }),
      ]);
      const fiveMin = fiveMinR.status === "fulfilled" ? fiveMinR.value : [];
      const updown = updownR.status === "fulfilled" ? updownR.value : [];
      const crypto = cryptoR.status === "fulfilled" ? cryptoR.value : [];
      const failed = [fiveMinR, updownR, cryptoR].filter(r => r.status === "rejected") as PromiseRejectedResult[];
      for (const f of failed) console.warn(`[arena] discovery sub-call failed: ${f.reason?.message ?? f.reason}`);

      // CRITICAL: filter all results by ARENA_COIN before merging. Without
      // this, SOL arena could pick a BTC market from the updown/crypto
      // fallback when no SOL 5M markets are available, which causes the
      // wrong subscription. Slug check matches the per-coin discovery
      // output format: "{coin}-updown-5m-..." or "{coin}-up-down-...".
      const coinPrefix = `${CONFIG.ARENA_COIN}-`;
      const coinFilter = (m: { slug?: string }) =>
        !!m.slug && m.slug.toLowerCase().startsWith(coinPrefix);

      const filteredUpdown = updown.filter(coinFilter);
      const filteredCrypto = crypto.filter(coinFilter);
      const all = [...fiveMin, ...filteredUpdown, ...filteredCrypto];
      all.sort((a, b) => {
        const a5m = a.slug?.includes("-5m-") ? 1 : 0;
        const b5m = b.slug?.includes("-5m-") ? 1 : 0;
        if (a5m !== b5m) return b5m - a5m; // 5M first
        return b.liquidity - a.liquidity;
      });

      if (all.length > 0) {
        pick = all[0];
        break;
      }
      const backoffMs = Math.min(30_000, 2_000 * attempt);
      console.warn(`[arena] Discovery attempt ${attempt}/${maxAttempts} returned no markets — retrying in ${backoffMs}ms`);
      await new Promise(r => setTimeout(r, backoffMs));
    }

    if (!pick) {
      console.error("[arena] Discovery failed after all retries — refusing to start with simulated data. Exiting.");
      process.exit(1);
    }

    CONFIG.PM_CONDITION_ID = pick.yesTokenId;
    currentActiveTokenId = pick.yesTokenId;
    currentActiveDownTokenId = pick.noTokenId;
    // Set window times immediately so engines using getSecondsRemaining()
    // work from the very first candle (not just after first rotation).
    if (pick.endDate) {
      currentWindowEnd = new Date(pick.endDate).getTime();
    } else if (pick.slug) {
      // Extract epoch from slug like "btc-updown-5m-1775964108"
      const epochMatch = pick.slug.match(/(\d{10,})$/);
      if (epochMatch) currentWindowEnd = parseInt(epochMatch[1]) * 1000 + 300_000;
    }
    currentWindowStart = currentWindowEnd - 300_000;
    currentMarketSymbol = slugToBinanceSymbol(pick.slug ?? "");
    setPmSubscriptionTokens([pick.yesTokenId, pick.noTokenId]);
    console.log(`\n[arena] Auto-selected: "${pick.title}"`);
    console.log(`  UP token:   ${pick.yesTokenId.slice(0, 20)}...`);
    console.log(`  DOWN token: ${pick.noTokenId.slice(0, 20)}...`);
    console.log(`  Window:     ${new Date(currentWindowStart).toISOString()} → ${new Date(currentWindowEnd).toISOString()}\n`);
  }

  // Start data pulse
  if (CONFIG.DRY_RUN) {
    console.log("[arena] DRY_RUN — using simulated pulse");
    startSimulatedPulse({
      startPrice: 0.50 + (random() - 0.5) * 0.4,
      volatility: 0.008,
      intervalMs: CONFIG.TICK_INTERVAL_MS,
    });
  } else {
    startPmChannel();
    startBinanceChannel();
    // Chainlink poller disabled: free-tier Polygon RPC (polygon-rpc.com)
    // now requires an API key (403). The poller blocks the event loop for
    // seconds per failed call, slowing ALL engine ticks. No winning engine
    // (bred-4h85, stingo43-late-v1) uses Chainlink prices. Re-enable with
    // a paid RPC if chainlink-based engines are ever needed again.
    // startChainlinkPoller([CONFIG.ARENA_BINANCE_SYMBOL], 2000);

    // For 5M markets: rotate subscription every 2 min as markets expire
    startMarketRotation(async () => {
      const markets = await discover5mMarkets({ tokens: [CONFIG.ARENA_COIN] });
      if (markets.length === 0) return null;

      // Pick the ACTIVE candle: soonest endDate that's still in the future
      // (Not the latest — that's a future candle whose book is empty/stale)
      const now = Date.now();
      const active = markets
        .filter(m => new Date(m.endDate).getTime() > now)
        .sort((a, b) => new Date(a.endDate).getTime() - new Date(b.endDate).getTime());
      const picked = active[0] || markets[0];

      // Clean up fee pool for rotated-out markets
      if (currentActiveTokenId) clearFeePoolForMarket(currentActiveTokenId);
      if (currentActiveDownTokenId) clearFeePoolForMarket(currentActiveDownTokenId);

      // Update to new market — old positions settle via settlement.ts ($1 or $0)
      currentActiveTokenId = picked.yesTokenId;
      currentActiveDownTokenId = picked.noTokenId;
      currentMarketSymbol = slugToBinanceSymbol(picked.slug);
      currentWindowEnd = new Date(picked.endDate).getTime();
      currentWindowStart = currentWindowEnd - 300_000;
      if (activeStates) {
        for (const [, state] of activeStates) {
          state.activeTokenId = picked.yesTokenId;
          state.activeDownTokenId = picked.noTokenId;
          state.marketSymbol = currentMarketSymbol;
          state.marketWindowEnd = currentWindowEnd;
          state.marketWindowStart = currentWindowStart;
        }
      }

      return { yesTokenId: picked.yesTokenId, noTokenId: picked.noTokenId };
    }, 120_000);
  }

  // ── Live Trading ───────────────────────────────────────────────────────
  if (CONFIG.LIVE_ENABLED) {
    try {
      let submit: any;
      let getOrder: any;
      if (CONFIG.LIVE_DRY_RUN) {
        console.log("[arena] LIVE_DRY_RUN — using mock fills (no real CLOB)");
        const adapter = buildDryRunAdapter();
        submit = adapter.submit;
        getOrder = adapter.getOrder;
      } else {
        const privateKey = process.env.PRIVATE_KEY;
        const funder = process.env.FUNDER;
        if (!privateKey || !funder) {
          console.error("[arena] LIVE_ENABLED but PRIVATE_KEY or FUNDER not set. Disabling live.");
          CONFIG.LIVE_ENABLED = false;
        } else {
          console.log("[arena] LIVE mode — real CLOB orders enabled");
          const { buildClobSubmitter, buildClobLookup } = require("./live/clobSubmitter");
          submit = buildClobSubmitter({ privateKey, funder });
          getOrder = buildClobLookup({ privateKey, funder });
        }
      }
      if (CONFIG.LIVE_ENABLED) {
        liveArenaHandle = startLiveArena({
          coin: CONFIG.ARENA_COIN as "btc" | "eth" | "sol" | "xrp",
          simBankrollUsd: CONFIG.STARTING_CASH,
          submit,
          getOrder,
        });
        const engineCount = liveArenaHandle.states.size;
        console.log(`[arena] Live arena started: ${engineCount} graduated engine(s)\n`);
      }
    } catch (err: any) {
      console.error("[arena] Live arena init failed:", err.message);
      console.error("[arena] Continuing with sim-only mode");
      liveArenaHandle = null;
    }
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

    // Surgical engine-only deploy: check the reload flag at every round
    // boundary and rebuild the roster if a new engine was just rsynced in.
    // Position state lives in EngineState (per-round), not on engine
    // instances, so rebuilding here is safe — no in-flight positions lost.
    engines = maybeReloadEngines(engines);

    const roundId = `R${String(roundNum).padStart(4, "0")}-${Date.now()}`;

    try {
      const result = await runRound(roundId, engines);

      console.log(`\n[arena] Round ${roundNum} results:`);
      for (let i = 0; i < result.results.length; i++) {
        const r = result.results[i];
        const medal = i === 0 ? "👑" : i === 1 ? "🥈" : i === 2 ? "🥉" : "  ";
        console.log(`  ${medal} #${i + 1} ${r.engineId}: ${r.totalPnl >= 0 ? "+" : ""}$${r.totalPnl.toFixed(2)} (${r.tradeCount} trades, $${r.feePaid.toFixed(4)} fees)`);
      }

      // Live arena round-end snapshot
      if (liveArenaHandle) {
        const snap = liveArenaHandle.snapshot();
        if (snap.engines.length > 0) {
          console.log(`\n[live-arena] Round ${roundNum} live snapshot:`);
          for (const e of snap.engines) {
            console.log(`  ${e.engineId}: cash=$${e.cashBalance.toFixed(2)} positions=${e.positionCount} pending=${e.pendingCount} dailyLoss=$${e.dailyLossUsd.toFixed(2)}${e.paused ? " PAUSED" : ""}`);
          }
        }
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
  if (liveArenaHandle) {
    console.log("[arena] Stopping live arena...");
    liveArenaHandle.stop();
  }
  flushLedger(); // commit buffered trades before closing
  shutdownPulse();
  closeDb();
  process.exit(code);
}

process.on("SIGINT", () => { console.log("\n[arena] SIGINT received"); gracefulShutdown(); });
process.on("SIGTERM", () => { console.log("\n[arena] SIGTERM received"); gracefulShutdown(); });

// ── Entry Point ──────────────────────────────────────────────────────────────
// Guard against accidental auto-start when arena.ts is imported by something
// other than the CLI (e.g. unit tests importing reloadFlagPath / maybeReloadEngines).
// Only run main() when this module IS the entry point.

if (require.main === module) {
  main().catch(err => {
    console.error("[arena] Fatal error:", err);
    gracefulShutdown(1);
  });
}
