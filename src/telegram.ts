/**
 * Quant Farm — Telegram Bot
 *
 * Chat interface for checking arena status from your phone.
 * Uses Gemini Flash via OpenRouter to summarize arena data.
 *
 * Run: npx ts-node src/telegram.ts
 * PM2: included in ecosystem.config.js
 */

import * as path from "path";
import * as dotenv from "dotenv";
import { execSync } from "child_process";
import TelegramBot from "node-telegram-bot-api";

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const MODEL = process.env.TELEGRAM_MODEL || "anthropic/claude-sonnet-4-5";
const PROJECT_ROOT = path.resolve(__dirname, "..");

if (!TELEGRAM_TOKEN) { console.error("TELEGRAM_BOT_TOKEN not set"); process.exit(1); }

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log("[telegram] Bot started, waiting for messages...");

// ── Gather arena data ───────────────────────────────────────────────────────

function run(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 10000, cwd: PROJECT_ROOT });
  } catch { return "command failed"; }
}

function getArenaSnapshot(): string {
  const pm2 = run("pm2 ls --no-color");
  const recent = run(`sqlite3 data/ledger.db "SELECT engine_id, action, printf('%.4f',price) as price, printf('%.0f',size) as shares, printf('%.2f',pnl) as pnl, substr(note,1,50) as note FROM trades ORDER BY id DESC LIMIT 20"`);
  const lifetimeLb = run(`sqlite3 data/ledger.db "SELECT engine_id, COUNT(*) as trades, printf('%.4f',SUM(fee)) as fees, printf('%.2f',SUM(pnl)) as pnl FROM trades WHERE engine_id NOT LIKE 'bred-p28h' GROUP BY engine_id ORDER BY SUM(pnl) DESC"`);
  // Current round: extract from latest arena tick output (shows cash, mtm, pnl per engine)
  const currentRound = run("pm2 logs quant-arena --lines 80 --nostream --no-color 2>&1 | grep 'pnl=' | tail -30");
  const settlements = run("grep -E '(WIN|LOSS)' logs/out.log 2>/dev/null | tail -10");
  const engines = run("ls src/engines/BredEngine_* 2>/dev/null || echo 'none'");

  return `## Process Status
${pm2}

## Current Round (live state — cash, MTM, P&L from $50 start)
${currentRound || "No round data"}

## Recent Settlements
${settlements || "No settlements yet"}

## Lifetime Leaderboard (all rounds cumulative)
${lifetimeLb || "No trades yet"}

## Recent 20 Trades
${recent || "No trades yet"}

## Bred Engines on Disk
${engines}`;
}

function getEngineCode(): string {
  const files = run("ls src/engines/BredEngine_* 2>/dev/null").trim().split("\n").filter(Boolean);
  if (files.length === 0) return "No bred engines found.";

  let code = "";
  for (const file of files) {
    const name = file.replace("src/engines/", "");
    const content = run(`head -60 ${file}`);
    code += `\n### ${name}\n\`\`\`typescript\n${content}\`\`\`\n`;
  }
  return code;
}

// ── LLM summarizer ──────────────────────────────────────────────────────────

async function askLLM(userMessage: string, arenaData: string): Promise<string> {
  if (!OPENROUTER_KEY) return "OPENROUTER_API_KEY not set — can't summarize. Raw data:\n\n" + arenaData;

  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENROUTER_KEY}`,
      "X-Title": "quant-arena-telegram",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [
        { role: "system", content: `You are the manager of a Polymarket 5-minute crypto trading arena. Report concisely for Telegram.

CRITICAL RULES:
- NEVER invent, estimate, or round numbers. ONLY use exact values from the data provided below.
- If a number isn't in the data, say "not available" — do NOT guess.
- There are TWO leaderboards: "Current Round" (live state this round) and "Lifetime" (cumulative across all rounds).
- When asked for "leaderboard" or "lb", show BOTH. Label them clearly.
- Current Round data comes from arena logs: cash=X mtm=Y pnl=Z. P&L is from $50 starting cash.
- Lifetime data comes from the ledger DB: cumulative trades, fees, and P&L across all rounds.
- bred-p28h and bred-4trt were cheaters — exclude from rankings.
- Settlement results show WIN/LOSS with exact payout and P&L. Include recent settlements when relevant.

Arena context:
- 5M Polymarket binary markets (BTC up or down in 5-minute windows)
- Quartic fee: max 1.56% at P=0.50, only 0.20% at P=0.90, near 0% at P=0.99
- Makers pay 0% fee + 20% rebate
- Settlement: $1/share if correct, $0 if wrong. Candles resolve every 5 minutes.
- Breeder generates new AI engines every 1 hour` },
        { role: "user", content: `User asks: "${userMessage}"\n\nCurrent arena data (USE THESE EXACT NUMBERS):\n${arenaData}` },
      ],
    }),
  });

  if (!resp.ok) return `LLM error ${resp.status}: ${await resp.text()}`;
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "No response from LLM";
}

// ── Message handler ─────────────────────────────────────────────────────────

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim() || "";

  if (!text || text.startsWith("/start")) {
    bot.sendMessage(chatId, "Quant Arena Manager. Ask me anything about the arena — status, trades, engines, P&L.");
    return;
  }

  // Quick commands (no LLM needed)
  if (text === "/raw") {
    const snapshot = getArenaSnapshot();
    // Telegram max message is 4096 chars
    const trimmed = snapshot.slice(0, 4000);
    bot.sendMessage(chatId, `\`\`\`\n${trimmed}\n\`\`\``, { parse_mode: "Markdown" });
    return;
  }

  // Everything else goes through LLM
  bot.sendChatAction(chatId, "typing");
  const snapshot = getArenaSnapshot();
  // Include engine source code if user asks about strategies/code
  const wantsCode = /strat|code|source|engine|bred|logic|how.*(work|trade)/i.test(text);
  const context = wantsCode ? snapshot + "\n\n## Bred Engine Source Code\n" + getEngineCode() : snapshot;
  const reply = await askLLM(text, context);
  bot.sendMessage(chatId, reply, { parse_mode: "Markdown" }).catch(() => {
    // Fallback without markdown if parsing fails
    bot.sendMessage(chatId, reply);
  });
});

bot.on("polling_error", (err) => {
  console.error("[telegram] Polling error:", err.message);
});
