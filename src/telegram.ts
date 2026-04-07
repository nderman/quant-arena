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
const MODEL = process.env.TELEGRAM_MODEL || "google/gemini-2.0-flash-001";
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
  const summary = run(`sqlite3 data/ledger.db "SELECT engine_id, COUNT(*) as trades, printf('%.4f',SUM(fee)) as fees, printf('%.2f',SUM(pnl)) as pnl FROM trades WHERE engine_id NOT LIKE 'bred-p28h' GROUP BY engine_id ORDER BY SUM(pnl) DESC"`);
  const logs = run("pm2 logs quant-arena --lines 10 --nostream --no-color 2>&1 | tail -10");
  const engines = run("ls src/engines/BredEngine_* 2>/dev/null || echo 'none'");

  return `## Process Status
${pm2}

## Engine Leaderboard (lifetime, excluding cheater)
${summary || "No trades yet"}

## Recent 20 Trades
${recent || "No trades yet"}

## Latest Arena Log
${logs}

## Bred Engines on Disk
${engines}`;
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
        { role: "system", content: `You are the manager of a Polymarket 5-minute crypto trading arena. You report arena status concisely for Telegram (use short messages, emoji for status). The arena runs competing trading engines on live data, each starting with $50. A breeder generates new AI engines every 6 hours via Gemini+Claude.

Key context:
- Parabolic fee: max 1.8% at P=0.50, near 0% at edges
- Makers pay 0% fee + 20% rebate
- bred-p28h was a cheater (infinite merge exploit) — exclude from rankings
- Settlement: $1/share if correct, $0 if wrong` },
        { role: "user", content: `User asks: "${userMessage}"\n\nCurrent arena data:\n${arenaData}` },
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
  const reply = await askLLM(text, snapshot);
  bot.sendMessage(chatId, reply, { parse_mode: "Markdown" }).catch(() => {
    // Fallback without markdown if parsing fails
    bot.sendMessage(chatId, reply);
  });
});

bot.on("polling_error", (err) => {
  console.error("[telegram] Polling error:", err.message);
});
