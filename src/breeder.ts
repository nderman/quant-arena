/**
 * Quant Farm — Engine Breeder
 *
 * Evolutionary loop: analyzes arena results, generates new engines via LLM.
 * - Gemini Flash: reads leaderboard + ledger, identifies what works/fails
 * - Claude Sonnet: writes new TypeScript engine based on analysis
 * - Validates compilation, deploys to arena, restarts PM2
 *
 * Run: npx ts-node src/breeder.ts
 * Cron: every 6 hours after a round completes
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import * as dotenv from "dotenv";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

// ── Config ──────────────────────────────────────────────────────────────────

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const ANALYST_MODEL = process.env.ANALYST_MODEL || "google/gemini-2.0-flash-001";
const CODER_MODEL = process.env.CODER_MODEL || "anthropic/claude-haiku-4-5";
const MAX_RETRIES = 2;
const MIN_NEW_ROUNDS_TO_BREED = Number(process.env.MIN_NEW_ROUNDS_TO_BREED ?? 3);
const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENGINES_DIR = path.resolve(PROJECT_ROOT, "src", "engines"); // always read/write TypeScript source
const MAX_ENGINES = 25; // hand-builts + space for bred experiments
const DATA_DIR = path.resolve(PROJECT_ROOT, "data");
const COIN = (process.env.ARENA_COIN || "btc").toLowerCase();
const ARCHIVE_DIR = path.resolve(DATA_DIR, "engines_archive");

// ── OpenRouter Client ───────────────────────────────────────────────────────

async function callLLM(
  model: string,
  messages: { role: string; content: string }[],
  maxTokens = 4096,
): Promise<string> {
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not set");

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "X-Title": "quant-arena-breeder",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`OpenRouter error ${resp.status} (${model}): ${err}`);
  }

  const data = await resp.json();
  const usage = data.usage;
  if (usage) {
    console.log(`[breeder] ${model}: ${usage.prompt_tokens} in / ${usage.completion_tokens} out tokens`);
  }
  return data.choices?.[0]?.message?.content || "";
}

function callAnalyst(prompt: string): Promise<string> {
  return callLLM(ANALYST_MODEL, [{ role: "user", content: prompt }]);
}

function callCoder(systemPrompt: string, userPrompt: string): Promise<string> {
  return callLLM(CODER_MODEL, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], 8192);
}

// ── Arena Intel ─────────────────────────────────────────────────────────────

function readRoundIntel(): any | null {
  const intelPath = path.join(DATA_DIR, `round_intel_${COIN}.json`);
  if (!fs.existsSync(intelPath)) return null;
  return JSON.parse(fs.readFileSync(intelPath, "utf-8"));
}

function readRecentTrades(): string {
  try {
    const dbPath = path.join(DATA_DIR, `ledger_${COIN}.db`);
    if (!fs.existsSync(dbPath)) return "No ledger found.";
    const trades = execSync(
      `sqlite3 "${dbPath}" "SELECT engine_id, action, order_type, printf('%.4f',price) as price, printf('%.0f',size) as shares, printf('%.4f',fee) as fee, printf('%.2f',pnl) as pnl, signal_source, substr(note,1,80) as note FROM trades ORDER BY id DESC LIMIT 100"`,
      { encoding: "utf-8", timeout: 5000 },
    );
    const toxicSummary = execSync(
      `sqlite3 "${dbPath}" "SELECT engine_id, COUNT(*) as trades, SUM(toxic_flow) as toxic_hits, printf('%.1f', 100.0*SUM(toxic_flow)/COUNT(*)) as toxic_pct, printf('%.2f', SUM(pnl)) as total_pnl FROM trades GROUP BY engine_id ORDER BY SUM(pnl) DESC"`,
      { encoding: "utf-8", timeout: 5000 },
    );
    return (trades || "No trades yet.") +
      "\n\n## Toxic Flow Summary by Engine\n" +
      (toxicSummary || "No data.");
  } catch {
    return "Could not read ledger.";
  }
}

function listEngines(): string[] {
  return fs.readdirSync(ENGINES_DIR)
    .filter(f => f.endsWith(".ts") && !f.startsWith("Base"))
    .map(f => f.replace(".ts", ""));
}

function readBaseEngine(): string {
  return fs.readFileSync(path.join(ENGINES_DIR, "BaseEngine.ts"), "utf-8");
}

function readExampleEngine(): string {
  // Try multiple examples in order — any might be pruned
  const candidates = ["FadeV3Engine.ts", "FadeV2Engine.ts", "MeanRevertV2Engine.ts", "EdgeSniperEngine.ts"];
  for (const name of candidates) {
    try {
      return fs.readFileSync(path.join(ENGINES_DIR, name), "utf-8");
    } catch { continue; }
  }
  return "// No example engine available — see BaseEngine.ts for interface";
}

function readTypes(): string {
  return fs.readFileSync(path.resolve(PROJECT_ROOT, "src", "types.ts"), "utf-8");
}

// ── Round History ──────────────────────────────────────────────────────────

import { loadRoundHistory as loadHistory, buildCumulativePnl as buildPnl, type RoundHistoryEntry } from "./historyStore";

function loadRoundHistory(): RoundHistoryEntry[] {
  return loadHistory(COIN);
}

function buildCumulativePnl(history: RoundHistoryEntry[]): Map<string, number> {
  return buildPnl(history);
}

function formatRoundHistory(history: RoundHistoryEntry[]): string {
  if (history.length === 0) return "No round history yet.";

  const engineStats = new Map<string, { rounds: number; wins: number; totalPnl: number; bestPnl: number; worstPnl: number }>();
  for (const round of history) {
    for (const r of round.allResults || []) {
      const stats = engineStats.get(r.engineId) || { rounds: 0, wins: 0, totalPnl: 0, bestPnl: -Infinity, worstPnl: Infinity };
      stats.rounds++;
      stats.totalPnl += r.totalPnl;
      if (r.totalPnl > 0) stats.wins++;
      stats.bestPnl = Math.max(stats.bestPnl, r.totalPnl);
      stats.worstPnl = Math.min(stats.worstPnl, r.totalPnl);
      engineStats.set(r.engineId, stats);
    }
  }

  const lines = [`${history.length} rounds recorded.\n`];
  lines.push("Engine | Rounds | Wins | Total P&L | Best | Worst");
  lines.push("-------|--------|------|-----------|------|------");
  for (const [id, s] of [...engineStats.entries()].sort((a, b) => b[1].totalPnl - a[1].totalPnl)) {
    lines.push(`${id} | ${s.rounds} | ${s.wins} | $${s.totalPnl.toFixed(2)} | $${s.bestPnl.toFixed(2)} | $${s.worstPnl.toFixed(2)}`);
  }
  return lines.join("\n");
}

// ── Analysis (Gemini Flash) ─────────────────────────────────────────────────

async function analyzeArena(): Promise<string> {
  const intel = readRoundIntel();
  const trades = readRecentTrades();
  const engines = listEngines();
  const history = formatRoundHistory(loadRoundHistory());

  const prompt = `You are a quantitative trading analyst reviewing a Polymarket 5-minute crypto prediction market arena.

## Latest Round Results
${intel ? JSON.stringify(intel, null, 2) : "No round intel available yet."}

## Multi-Round History (engine performance across rounds)
${history}

## Recent Trades (last 100)
${trades}

## Active Engines
${engines.join(", ")}

## Market Rules
- Polymarket 5M binary markets: BTC/ETH/XRP go UP or DOWN in a 5-minute window
- Quartic taker fee: 0.25 × (P×(1-P))² — max 1.56% at P=0.50, only 0.20% at P=0.90, near 0% at P=0.99
- Maker fee: 0% + 20% rebate of taker fees (but 60% fill probability, 5bps adverse selection)
- UP and DOWN tokens have independent orderbooks (UP + DOWN ≠ $1 — the gap is merge arb)
- Settlement: $1 per share if correct, $0 if wrong
- Merge: buy opposite side at real book price + dynamic gas (on-chain, 3s finality)

## Key Performance Metrics
- **sharpeRatio** (in allResults): profit-to-costs ratio. Higher = better risk-adjusted returns.
- **Toxic Flow %** (in toxic flow summary): how often Binance moved against the engine during execution. High toxic % = engine is getting picked off by HFTs.
- Winning engines have HIGH Sharpe (>2) AND LOW toxic flow (<20%). An engine with high P&L but 50% toxic hits is lucky, not skilled.
- Prioritize strategies that AVOID toxic flow (trade during quiet periods, use maker orders) over strategies that trade frequently.

## Your Task
Analyze what's working and what's failing. Identify:
1. Which strategies are profitable and WHY (edge vs fees vs timing vs toxic avoidance)
2. Which strategies are losing and what specific flaw causes the losses
3. What UNTRIED approach could beat the current leader (consider: maker-only, toxic flow avoidance, Sharpe optimization)
4. Whether maker orders, DOWN token bets, merge arb, or specific entry timing could help

IMPORTANT: Use multi-round history to distinguish HIGH-VARIANCE winners from consistent losers. An engine that wins big some rounds and loses big others has a REAL edge — it just needs risk management. Don't dismiss engines with negative latest-round P&L if their multi-round history shows big wins. Consistency matters but so does total P&L across rounds.

Be specific and quantitative. Reference actual trade data. Output your analysis in 300 words or less.`;

  console.log(`[breeder] Analyzing arena with ${ANALYST_MODEL}...`);
  return callAnalyst(prompt);
}

// ── Code Generation (Claude Sonnet) ─────────────────────────────────────────

async function generateEngine(analysis: string): Promise<{ code: string; className: string; fileName: string }> {
  const baseEngine = readBaseEngine();
  const exampleEngine = readExampleEngine();
  const types = readTypes();
  const engines = listEngines();

  // Generate a unique engine name
  const version = Date.now().toString(36).slice(-4);
  const className = `BredEngine_${version}`;
  const fileName = `BredEngine_${version}`;

  const systemPrompt = `You are an expert TypeScript developer building trading engines for a Polymarket 5-minute binary market arena. Your engines compete with other engines and the simulator faithfully models real PM constraints.

OUTPUT FORMAT
You MUST output ONLY valid TypeScript code — no markdown, no explanation, no code fences. Just the raw .ts file content. The file will be compiled with strict TypeScript and rejected if it doesn't compile.

CLASS REQUIREMENTS
- Import AbstractEngine from "./BaseEngine"
- Import types from "../types": EngineAction, EngineState, MarketTick, SignalSnapshot
- Export a class named ${className} that extends AbstractEngine
- Set unique id, name, version properties (id starts with "bred-")
- Implement onTick(tick, state, signals?) returning EngineAction[]
- Implement onRoundEnd(state) to reset per-round state

═══════════════════════════════════════════════════════════════════
THE FEE MODEL — QUARTIC (this is the great filter)
═══════════════════════════════════════════════════════════════════
fee = amount × 0.25 × (P × (1-P))²

  P=0.01: 0.0025%   P=0.10: 0.20%   P=0.30: 1.10%
  P=0.50: 1.56% ←MAX  P=0.70: 1.10%   P=0.90: 0.20%   P=0.99: 0.003%

The fee CRUSHES edges at mid-prices. Engines that trade at P=0.40-0.60
without massive raw edge will bleed. Profitable strategies live at the
EXTREMES (P<0.20 or P>0.80) where fees are negligible.

ALWAYS call this.feeAdjustedEdge(modelProb, marketPrice) before trading.
If !edge.profitable, return [].

═══════════════════════════════════════════════════════════════════
DUAL ORDERBOOKS — CRITICAL CORRECTNESS RULE
═══════════════════════════════════════════════════════════════════
UP and DOWN tokens have INDEPENDENT orderbooks. UP_ask + DOWN_ask is
NOT necessarily $1.00 — the gap is where merge arb lives.

NEVER do this (it's WRONG and will cause your engine to bleed):
  const downPrice = 1 - upPrice;        // ❌ WRONG
  const downAsk = 1 - tick.bestBid;     // ❌ WRONG

ALWAYS read both books directly:
  import { getBookForToken } from "../pulse";
  const upBook = getBookForToken(this.getUpTokenId());
  const downBook = getBookForToken(this.getDownTokenId());
  const upAsk = upBook.asks[0]?.price;
  const downAsk = downBook.asks[0]?.price;

The MarketTick passed to onTick has tokenSide ("UP" or "DOWN"). The
tick.midPrice/bestAsk/bestBid are for THAT side only — not the opposite.
Don't assume a tick is for UP unless you check tokenSide.

═══════════════════════════════════════════════════════════════════
MERGE — FLAVOR A ONLY (must hold both sides)
═══════════════════════════════════════════════════════════════════
The referee only supports MERGE when the engine ALREADY HOLDS both UP
and DOWN of the SAME conditional pair. The merge burns both legs and
credits $1 per pair (minus gas).

To do a "buy opposite + merge" arb, you must:
  1. Emit BUY for the opposite side as a normal action (one tick)
  2. Wait for the fill (next tick: check this.getPosition(tokenId))
  3. THEN emit MERGE on the next tick when both positions exist

You CANNOT call merge() while holding only one side — it will reject.
The cheaperExit() helper recommends MERGE only when holdsOpposite is
true; trust its result.

═══════════════════════════════════════════════════════════════════
MAKER ORDERS — POST-ONLY ENFORCED, 12% FILL PROB
═══════════════════════════════════════════════════════════════════
Pass { orderType: "maker" } for 0% fee + 20% rebate of taker fees.

CONSTRAINTS:
- Maker BUY: action.price MUST be < bestAsk (otherwise crosses spread, rejected)
- Maker SELL: action.price MUST be > bestBid
- Fill probability is only 12% (real HFT queue priority is brutal)
- Even when filled, expect 5bps adverse selection

action.price IS A LIMIT. The fill MUST be at or better than action.price.
If you submit BUY at $0.15 and the book has only asks at $0.20, your
order is REJECTED — it does NOT fill at $0.20.

═══════════════════════════════════════════════════════════════════
BOOK VALIDITY GUARDS (your action may silently reject)
═══════════════════════════════════════════════════════════════════
The referee rejects fills against books where:
- Best price < $0.01 or > $0.99 (extreme/stale data)
- Spread (bestAsk - bestBid) > $0.50 (half-empty book)
- Book timestamp > 30s old (stale)
- One side empty (one-sided book)

Don't try to trade on freshly-rotated markets where the new book
hasn't received PM updates yet.

═══════════════════════════════════════════════════════════════════
POSITIONS, ROTATIONS, SETTLEMENT
═══════════════════════════════════════════════════════════════════
- 5M markets ROTATE every 2 minutes. Old positions don't disappear —
  they sit until the candle resolves and settle to $1 or $0.
- this.getUpTokenId() returns the CURRENT market's UP token. After a
  rotation, it points to a NEW token. Don't store entry timestamps
  keyed by upTokenId across rotations — they become stale and cause
  bugs (a recent bred engine had "1775829203 second hold time" — that's
  an epoch timestamp masquerading as a duration).
- Detect rotation by tracking lastTokens = upTokenId+":"+downTokenId.
- Reset per-candle counters in onRoundEnd AND on rotation.
- Settlement is automatic — you don't call settle(). Holding to
  settlement is a real strategy: maker buy underdog cheap, hold for
  candle close, the SETTLE row will appear with $1/share if you won.

═══════════════════════════════════════════════════════════════════
WINNING STRATEGY PATTERNS (observed in the lab)
═══════════════════════════════════════════════════════════════════
1. **Hold to settlement**: maker BUY at extreme prices (P<0.15 or P>0.85),
   hold the position for the entire candle, let SETTLE pay you out.
   Zero fees, zero toxic flow. Highest Sharpe in the lab.
2. **Confidence drift**: BUY mid-uncertainty (mid 0.42-0.58), exit
   when one side gains conviction (price moves toward 0.70+ or 0.30-).
   Bet that the candle resolves over time.
3. **Discipline**: cap entry trades per round. Top losers all overtrade
   (80-150 trades/round) — the cap engine that does 5 trades/round
   bleeds way less in fees and toxic flow.
4. **Fee-disciplined**: only trade when feeAdjustedEdge.netEdge > 1.5%.

LOSING PATTERNS TO AVOID:
- Chasing momentum into volatile ticks (toxic flow eats you)
- Buying at mid-prices without massive edge (quartic fee dominates)
- Re-entering same position dozens of times (compounding toxic flow)
- Late-candle BUY at extreme prices without external confirmation
- Cross-market merging (referee rejects)
- Single-book inversion via 1-x (you read wrong prices)`;

  const userPrompt = `## Analysis of Current Arena
${analysis}

## Existing Engines (don't duplicate these)
${engines.join(", ")}

## Base Class
${baseEngine}

## Types
${types}

## Example Engine (for reference)
${exampleEngine}

Write a NEW engine class named ${className} that implements a strategy designed to beat the current leader based on the analysis above. Be creative but realistic — the referee simulates toxic flow, book walking, and parabolic fees. The engine that wins is the one that manages fees and timing, not the one that trades the most.`;

  console.log(`[breeder] Generating engine with ${CODER_MODEL}...`);
  const code = await callCoder(systemPrompt, userPrompt);

  // Strip markdown code fences if Claude includes them despite instructions
  const cleaned = code
    .replace(/^```typescript\n?/m, "")
    .replace(/^```ts\n?/m, "")
    .replace(/\n?```$/m, "")
    .trim();

  return { code: cleaned, className, fileName };
}

// ── Validation ──────────────────────────────────────────────────────────────

function validateEngine(_filePath: string): { valid: boolean; error?: string } {
  try {
    // Run full project compilation — checks the new engine in context of all imports
    execSync("npx tsc --noEmit 2>&1", {
      encoding: "utf-8",
      timeout: 60000,
      cwd: PROJECT_ROOT,
    });
    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: err.stdout || err.message };
  }
}

// ── Cleanup: remove worst performers ────────────────────────────────────────

// All coins the multi-coin arena runs. Used for cross-coin pruning safety —
// an engine that's catastrophic on btc but profitable on eth must not be deleted
// by the btc breeder. Keep in sync with ecosystem.config.js COINS list.
const ALL_COINS = ["btc", "eth", "sol"];

function pruneEngines(intel: any): void {
  const engines = listEngines();
  // Pruner is only allowed to delete BREDENGINE files. Hand-built engines are
  // never auto-pruned — they're irreplaceable design references and the breeder
  // doesn't have a way to recreate them. Without this filter the breeder will
  // happily delete LateSniperEngine, FadeV2Engine, MeanRevertEngine etc. and
  // break dependent engines (e.g. DisciplinedReverter imports MeanRevertEngine).
  const prunableEngines = engines.filter(e => e.startsWith("BredEngine_"));

  if (prunableEngines.length <= MAX_ENGINES) return;

  // How many to prune this cycle
  const toPrune = Math.min(prunableEngines.length - MAX_ENGINES, 5);

  if (!intel?.allResults) return;

  // Cross-coin protection: build per-engine BEST cumulative pnl across ALL coins.
  // An engine that loses on this coin but wins big on another must not be pruned —
  // engine files are shared via src/engines/, deleting them affects every arena.
  const bestCoinPnl = new Map<string, number>();
  for (const coin of ALL_COINS) {
    const coinHistory = loadHistory(coin);
    const coinCumulative = buildPnl(coinHistory);
    for (const [engineId, pnl] of coinCumulative) {
      const prev = bestCoinPnl.get(engineId) ?? -Infinity;
      if (pnl > prev) bestCoinPnl.set(engineId, pnl);
    }
  }

  // Rank by best-coin cumulative P&L (worst-best-coin first). An engine with
  // strong performance on any single coin sinks to the bottom of the prune list.
  const ranked = intel.allResults
    .map((r: any) => ({ ...r, bestCoinPnl: bestCoinPnl.get(r.engineId) ?? r.totalPnl }))
    .sort((a: any, b: any) => a.bestCoinPnl - b.bestCoinPnl);

  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  let pruned = 0;
  for (const result of ranked) {
    if (pruned >= toPrune) break;

    const worstFile = prunableEngines.find(f => {
      try {
        const content = fs.readFileSync(path.join(ENGINES_DIR, f + ".ts"), "utf-8");
        return content.includes(`id = "${result.engineId}"`);
      } catch { return false; } // file already pruned
    });

    if (worstFile) {
      console.log(`[breeder] Pruning #${pruned + 1}: ${worstFile} (best-coin P&L: $${result.bestCoinPnl.toFixed(2)})`);
      const srcPath = path.join(ENGINES_DIR, worstFile + ".ts");
      const distPath = path.join(PROJECT_ROOT, "dist", "engines", worstFile + ".js");
      const archivePath = path.join(ARCHIVE_DIR, `${worstFile}_pruned_${Date.now()}.ts`);
      fs.copyFileSync(srcPath, archivePath);
      fs.unlinkSync(srcPath);
      try { fs.unlinkSync(distPath); } catch {} // also remove compiled JS
      pruned++;
    }
  }

  if (pruned > 0) console.log(`[breeder] Pruned ${pruned} engines (${prunableEngines.length - pruned} remaining)`);
}

// ── Main Breed Loop ─────────────────────────────────────────────────────────

async function breed(): Promise<void> {
  console.log("\n" + "=".repeat(60));
  console.log("[breeder] Starting evolution cycle");
  console.log("=".repeat(60) + "\n");

  // Data gate: skip if not enough new rounds since last successful breed.
  // Avoids burning API spend on cycles that would see identical data.
  const markerPath = path.join(DATA_DIR, `last_breed_${COIN}.json`);
  const currentRounds = loadRoundHistory().length;
  let lastBreedRounds = 0;
  try {
    if (fs.existsSync(markerPath)) {
      lastBreedRounds = JSON.parse(fs.readFileSync(markerPath, "utf-8")).rounds ?? 0;
    }
  } catch { /* treat missing/corrupt marker as fresh */ }

  const newRounds = currentRounds - lastBreedRounds;
  if (newRounds < MIN_NEW_ROUNDS_TO_BREED) {
    console.log(`[breeder] Only ${newRounds} new rounds since last breed (need ${MIN_NEW_ROUNDS_TO_BREED}). Skipping cycle.`);
    return;
  }
  console.log(`[breeder] ${newRounds} new rounds since last breed — proceeding.`);

  // 1. Analyze
  const analysis = await analyzeArena();
  console.log("\n[breeder] Analysis:\n" + analysis + "\n");

  // 2. Prune if too many engines
  const intel = readRoundIntel();
  if (intel) pruneEngines(intel);

  // 3. Generate + validate (with retries)
  let attempts = 0;
  let lastError = "";
  while (attempts < MAX_RETRIES) {
    attempts++;
    console.log(`[breeder] Generation attempt ${attempts}/${MAX_RETRIES}...`);

    try {
      const errorContext = lastError
        ? `\n\n## PREVIOUS ATTEMPT FAILED TO COMPILE\nFix these TypeScript errors:\n${lastError}`
        : "";
      const { code, className, fileName } = await generateEngine(analysis + errorContext);
      const filePath = path.join(ENGINES_DIR, fileName + ".ts");

      // Write the file
      fs.writeFileSync(filePath, code);
      console.log(`[breeder] Written: ${filePath}`);

      // Validate compilation
      const result = validateEngine(filePath);
      if (result.valid) {
        console.log(`[breeder] ${className} compiles successfully`);

        // Rebuild dist/ so arena picks up the new engine on its next natural restart.
        try {
          execSync("npm run build", { encoding: "utf-8", timeout: 30000, cwd: PROJECT_ROOT });
          console.log("[breeder] TypeScript rebuilt");
        } catch (buildErr: any) {
          console.error("[breeder] Build failed:", buildErr.message);
        }

        // Mark this breed as done so the data gate skips until new rounds accumulate.
        try {
          fs.writeFileSync(markerPath, JSON.stringify({ rounds: currentRounds, at: new Date().toISOString() }));
        } catch (err: any) {
          console.warn(`[breeder] Failed to write breed marker: ${err.message}`);
        }

        console.log(`\n[breeder] Evolution cycle complete. New engine: ${className} (loads on next arena restart)\n`);
        return;
      }

      // Compilation failed — delete and retry with error context
      console.error(`[breeder] Compilation failed:\n${result.error}`);
      lastError = result.error || "";
      fs.unlinkSync(filePath);
    } catch (err: any) {
      console.error(`[breeder] Generation failed: ${err.message}`);
    }
  }

  console.error(`[breeder] Failed to generate valid engine after ${MAX_RETRIES} attempts`);
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--analyze")) {
  // Just analyze, don't generate
  analyzeArena().then(a => {
    console.log(a);
  }).catch(console.error);
} else if (args.includes("--loop")) {
  // Continuous breeding loop. 6h cadence + a per-cycle data gate keeps API spend bounded;
  // override with BREED_INTERVAL_HOURS if you want faster evolution.
  const intervalMs = Number(process.env.BREED_INTERVAL_HOURS ?? 6) * 3600_000;
  console.log(`[breeder] Starting continuous loop (every ${intervalMs / 3600_000}h)`);
  breed().catch(console.error);
  setInterval(() => breed().catch(console.error), intervalMs);
} else {
  // Single breed cycle
  breed().catch(err => {
    console.error("[breeder] Fatal:", err);
    process.exit(1);
  });
}
