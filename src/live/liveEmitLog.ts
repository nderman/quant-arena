/**
 * Dedicated live-emit log — answers "did our PM2 try to place this trade?"
 *
 * Persisted to disk (data/live_emit.log) on every order submission attempt,
 * regardless of success/failure. Independent of PM2's rolling stdout buffer
 * (which only keeps last N lines and rotates). Critical for diagnosing
 * "did our bot just trade or did something else?" weeks/months later.
 *
 * Format: one line per event, ISO timestamp + event tag + key fields, easy
 * to grep:
 *   2026-05-04T05:19:46.123Z SUBMIT engine=mom-set arena=sol-4h side=BUY pos=YES sz=5 px=0.59 slug=sol-updown-4h-1777867200
 *   2026-05-04T05:19:47.456Z FILLED engine=mom-set arena=sol-4h side=BUY pos=YES sz=5 px=0.5895 cliId=ord-abc
 *   2026-05-04T05:19:48.789Z REJECT engine=mom-set arena=sol-4h side=BUY pos=YES sz=5 px=0.59 reason=invalid_token
 *
 * May 4 2026: built after a single "rogue" trade (sol-updown-4h-1777867200,
 * 5 sh @ $0.59) was sync-cron picked up but had no PM2 forward-emit twin.
 * Couldn't tell if our wide variant fired and missed the log, or if a
 * separate process placed it. This file makes that question answerable.
 */
import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "../historyStore";

const EMIT_LOG_PATH = path.join(DATA_DIR, "live_emit.log");

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* exists */ }

export type EmitEvent = "SUBMIT" | "FILLED" | "REJECT" | "ERROR";

export interface EmitFields {
  engineId: string;
  arenaInstanceId?: string;
  side: string;
  positionSide?: string;
  size: number;
  price: number;
  slug?: string;
  tokenId?: string;
  clientOrderId?: string;
  reason?: string;
}

export function logEmit(event: EmitEvent, f: EmitFields): void {
  const ts = new Date().toISOString();
  const parts = [
    ts,
    event,
    `engine=${f.engineId}`,
    f.arenaInstanceId ? `arena=${f.arenaInstanceId}` : null,
    `side=${f.side}`,
    f.positionSide ? `pos=${f.positionSide}` : null,
    `sz=${f.size}`,
    `px=${f.price}`,
    f.slug ? `slug=${f.slug}` : null,
    f.tokenId ? `token=${f.tokenId.slice(0, 16)}` : null,
    f.clientOrderId ? `cliId=${f.clientOrderId}` : null,
    f.reason ? `reason=${f.reason}` : null,
  ].filter(Boolean);
  const line = parts.join(" ") + "\n";
  try {
    fs.appendFileSync(EMIT_LOG_PATH, line);
  } catch (err) {
    console.error(`[live-emit-log] write failed: ${err instanceof Error ? err.message : err}`);
  }
}
