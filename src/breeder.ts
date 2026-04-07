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
const CODER_MODEL = process.env.CODER_MODEL || "anthropic/claude-sonnet-4-5-20250514";
const MAX_RETRIES = 3;
const ENGINES_DIR = path.resolve(__dirname, "engines");
const MAX_ENGINES = 8; // don't let the arena get too crowded
const DATA_DIR = path.resolve(__dirname, "..", "data");

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
    const output = execSync(
      `sqlite3 "${dbPath}" "SELECT engine_id, action, order_type, printf('%.4f',price) as price, printf('%.0f',size) as shares, printf('%.4f',fee) as fee, printf('%.2f',pnl) as pnl, signal_source, substr(note,1,80) as note FROM trades ORDER BY id DESC LIMIT 100"`,
      { encoding: "utf-8", timeout: 5000 },
    );
    return output || "No trades yet.";
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
  return fs.readFileSync(path.resolve(__dirname, "types.ts"), "utf-8");
}

// ── Analysis (Gemini Flash) ─────────────────────────────────────────────────

async function analyzeArena(): Promise<string> {
  const intel = readRoundIntel();
  const trades = readRecentTrades();
  const engines = listEngines();

  const prompt = `You are a quantitative trading analyst reviewing a Polymarket 5-minute crypto prediction market arena.

## Arena Results
${intel ? JSON.stringify(intel, null, 2) : "No round intel available yet."}

## Recent Trades (last 100)
${trades}

## Active Engines
${engines.join(", ")}

## Market Rules
- Polymarket 5M binary markets: BTC/ETH/XRP go UP or DOWN in a 5-minute window
- Taker fee: amount × 0.018 × 4 × P × (1-P) — max 1.8% at P=0.50, near 0% at edges
- Maker fee: 0% + 20% rebate of taker fees collected (but 60% fill probability, 5bps adverse selection)
- Engines can buy UP tokens (YES) or DOWN tokens (NO) via getUpTokenId()/getDownTokenId()
- Engines can place maker orders via buy(..., { orderType: "maker" })
- Settlement: $1 per share if correct, $0 if wrong
- Merge: buy opposite side + 0.1% flat fee + $0.04 gas (on-chain)

## Your Task
Analyze what's working and what's failing. Identify:
1. Which strategies are profitable and WHY (edge vs fees vs timing)
2. Which strategies are losing and what specific flaw causes the losses
3. What UNTRIED approach could beat the current leader
4. Whether maker orders, DOWN token bets, or specific entry timing could help

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

Fee formula: fee = amount × 0.018 × 4 × P × (1-P)
At P=0.50: 1.8% (kills most edges). At P=0.90: 0.65%. At P=0.99: 0.07%.
Maker orders: 0% fee but only 60% fill probability and 5bps adverse selection.`;

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

function validateEngine(filePath: string): { valid: boolean; error?: string } {
  try {
    execSync(`npx tsc --noEmit --strict "${filePath}" 2>&1`, {
      encoding: "utf-8",
      timeout: 30000,
      cwd: path.resolve(__dirname, ".."),
    });
    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: err.stdout || err.message };
  }
}

// ── Cleanup: remove worst performers ────────────────────────────────────────

function pruneEngines(intel: any): void {
  const engines = listEngines();
  const bredEngines = engines.filter(e => e.startsWith("BredEngine_"));

  if (bredEngines.length < MAX_ENGINES - 4) return; // 4 slots reserved for built-in engines

  // Find the worst bred engine by P&L
  if (!intel?.allResults) return;

  let worstId = "";
  let worstPnl = Infinity;
  for (const result of intel.allResults) {
    if (!result.engineId.startsWith("bred-engine-")) continue;
    if (result.totalPnl < worstPnl) {
      worstPnl = result.totalPnl;
      worstId = result.engineId;
    }
  }

  if (!worstId) return;

  // Map engine ID back to filename
  const worstFile = bredEngines.find(f => {
    const content = fs.readFileSync(path.join(ENGINES_DIR, f + ".ts"), "utf-8");
    return content.includes(`id = "${worstId}"`);
  });

  if (worstFile) {
    console.log(`[breeder] Pruning worst performer: ${worstFile} (P&L: $${worstPnl.toFixed(2)})`);
    fs.unlinkSync(path.join(ENGINES_DIR, worstFile + ".ts"));
  }
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
  while (attempts < MAX_RETRIES) {
    attempts++;
    console.log(`[breeder] Generation attempt ${attempts}/${MAX_RETRIES}...`);

    try {
      const { code, className, fileName } = await generateEngine(analysis);
      const filePath = path.join(ENGINES_DIR, fileName + ".ts");

      // Write the file
      fs.writeFileSync(filePath, code);
      console.log(`[breeder] Written: ${filePath}`);

      // Validate compilation
      const result = validateEngine(filePath);
      if (result.valid) {
        console.log(`[breeder] ${className} compiles successfully`);

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

      // Compilation failed — delete and retry
      console.error(`[breeder] Compilation failed:\n${result.error}`);
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
  const intervalMs = 6 * 3600_000; // every 6 hours
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
