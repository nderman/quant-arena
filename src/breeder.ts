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
const CODER_MODEL = process.env.CODER_MODEL || "anthropic/claude-sonnet-4-5";
const MAX_RETRIES = 3;
const PROJECT_ROOT = path.resolve(__dirname, "..");
const ENGINES_DIR = path.resolve(PROJECT_ROOT, "src", "engines"); // always read/write TypeScript source
const MAX_ENGINES = 8; // don't let the arena get too crowded
const DATA_DIR = path.resolve(PROJECT_ROOT, "data");
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
  const intelPath = path.join(DATA_DIR, "round_intel.json");
  if (!fs.existsSync(intelPath)) return null;
  return JSON.parse(fs.readFileSync(intelPath, "utf-8"));
}

function readRecentTrades(): string {
  try {
    const dbPath = path.join(DATA_DIR, "ledger.db");
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
  return fs.readFileSync(path.join(ENGINES_DIR, "EdgeSniperEngine.ts"), "utf-8");
}

function readTypes(): string {
  return fs.readFileSync(path.resolve(PROJECT_ROOT, "src", "types.ts"), "utf-8");
}

// ── Round History ──────────────────────────────────────────────────────────

function loadRoundHistory(): any[] {
  const historyPath = path.join(DATA_DIR, "round_history.json");
  try {
    const history = JSON.parse(fs.readFileSync(historyPath, "utf-8")) as any[];
    return history;
  } catch {
    return [];
  }
}

function buildCumulativePnl(history: any[]): Map<string, number> {
  const pnl = new Map<string, number>();
  for (const round of history) {
    for (const r of round.allResults || []) {
      pnl.set(r.engineId, (pnl.get(r.engineId) || 0) + r.totalPnl);
    }
  }
  return pnl;
}

function formatRoundHistory(history: any[]): string {
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

  const systemPrompt = `You are an expert TypeScript developer building trading engines for a Polymarket 5-minute binary market arena.

You MUST output ONLY valid TypeScript code — no markdown, no explanation, no code fences. Just the raw .ts file content.

The engine must:
- Import AbstractEngine from "./BaseEngine"
- Import types from "../types"
- Export a class named ${className} that extends AbstractEngine
- Set unique id, name, version properties
- Implement onTick(tick, state, signals) returning EngineAction[]
- Call this.feeAdjustedEdge() before ANY trade to check profitability after fees
- Use this.getUpTokenId() for UP bets, this.getDownTokenId() for DOWN bets
- Use this.buy(), this.sell(), this.merge() action builders
- Optionally use { orderType: "maker" } for 0% fee maker orders
- Clean up state in onRoundEnd()

Quartic fee: fee = amount × 0.25 × (P×(1-P))²
At P=0.50: 1.56% (kills most edges). At P=0.90: 0.20% (sweet spot). At P=0.99: 0.003%.
Maker orders: 0% fee but only 60% fill probability and 5bps adverse selection.
UP and DOWN tokens have independent books (UP + DOWN ≠ $1) — merge arb exists in the gap.
The arena tracks Sharpe ratio (profit/costs) and toxic flow (adverse selection hits).
Engines that avoid toxic flow and maximize Sharpe survive evolution; high-frequency P&L chasers get pruned.`;

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

function pruneEngines(intel: any): void {
  const engines = listEngines();
  const prunableEngines = engines.filter(e => e !== "BaseEngine");

  if (prunableEngines.length <= MAX_ENGINES) return;

  // How many to prune this cycle
  const toPrune = Math.min(prunableEngines.length - MAX_ENGINES, 5);

  if (!intel?.allResults) return;

  // Use multi-round cumulative P&L for pruning (not just latest round)
  const cumulativePnl = buildCumulativePnl(loadRoundHistory());

  // Rank by cumulative P&L if available, otherwise latest round
  const ranked = intel.allResults
    .map((r: any) => ({ ...r, cumulativePnl: cumulativePnl.get(r.engineId) ?? r.totalPnl }))
    .sort((a: any, b: any) => a.cumulativePnl - b.cumulativePnl);

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
      console.log(`[breeder] Pruning #${pruned + 1}: ${worstFile} (cumulative P&L: $${result.cumulativePnl.toFixed(2)})`);
      const srcPath = path.join(ENGINES_DIR, worstFile + ".ts");
      const archivePath = path.join(ARCHIVE_DIR, `${worstFile}_pruned_${Date.now()}.ts`);
      fs.copyFileSync(srcPath, archivePath);
      fs.unlinkSync(srcPath);
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

        // Rebuild dist/ so arena picks up the new engine
        try {
          execSync("npm run build", { encoding: "utf-8", timeout: 30000, cwd: PROJECT_ROOT });
          console.log("[breeder] TypeScript rebuilt");
        } catch (buildErr: any) {
          console.error("[breeder] Build failed:", buildErr.message);
        }

        // Restart arena to pick up new engine
        try {
          execSync("pm2 restart quant-arena", { encoding: "utf-8", timeout: 10000 });
          console.log("[breeder] Arena restarted with new engine");
        } catch {
          console.log("[breeder] PM2 restart failed (not running under PM2?) — restart manually");
        }

        console.log(`\n[breeder] Evolution cycle complete. New engine: ${className}\n`);
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
  // Continuous breeding loop — run after each round
  const intervalMs = 1 * 3600_000; // every 1 hour (accelerated evolution)
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
