/**
 * Dedicated live-mirror log — answers "why didn't this sim fire reach live?"
 *
 * Persisted to disk (data/live_mirror.log) for every sim fire that we
 * considered mirroring, regardless of outcome. Captures decisions the
 * old `[live] ... → accepted/rejected` console line was hiding when
 * `result === null` or `shouldMirror === false`.
 *
 * Built 2026-05-13 after the simLiveAudit surfaced two mysteries:
 *   - vol-regime-gate-gemini-v1 fires fine on btc, silent on sol live
 *   - trade-settle-pinger-v1 has 11 sim fires, only 2 live submits
 * Existing tools couldn't tell us where the mirror flow broke. This log
 * records every branch:
 *
 *   ACCEPTED       — onSimAction returned {accepted: true}; orderSubmitter fired
 *   REJECTED       — onSimAction returned {accepted: false, reason: <sizing|zone|halt|...>}
 *   SKIPPED        — shouldMirror=false (sim referee rejected for a non-maker reason)
 *   NO_HANDLE      — liveArenaHandle was null (sim-only mode or pre-init)
 *   NULL_RESULT    — onSimAction resolved to null/undefined (bug indicator)
 *   ERROR          — onSimAction threw
 *
 * Format: one line per event, ISO timestamp + decision tag + key fields:
 *   2026-05-13T17:30:01.123Z ACCEPTED engine=stingo43-v1 arena=eth side=BUY ...
 *   2026-05-13T17:30:05.456Z SKIPPED engine=bred-fw8t arena=btc-4h reason=dual_book_inconsistent
 *   2026-05-13T17:30:09.789Z NULL_RESULT engine=foo arena=bar (bug — investigate)
 */
import * as fs from "fs";
import * as path from "path";
import { DATA_DIR } from "../historyStore";

const MIRROR_LOG_PATH = path.join(DATA_DIR, "live_mirror.log");

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* exists */ }

export type MirrorDecision = "ACCEPTED" | "REJECTED" | "SKIPPED" | "NO_HANDLE" | "NULL_RESULT" | "ERROR";

export interface MirrorFields {
  engineId: string;
  arenaInstanceId?: string;
  side: string;
  positionSide?: "YES" | "NO";
  size: number;
  price: number;
  tokenId?: string;
  reason?: string;
}

export function logMirror(decision: MirrorDecision, f: MirrorFields): void {
  const ts = new Date().toISOString();
  const parts = [
    ts,
    decision,
    `engine=${f.engineId}`,
    f.arenaInstanceId ? `arena=${f.arenaInstanceId}` : null,
    `side=${f.side}`,
    f.positionSide ? `pos=${f.positionSide}` : null,
    `sz=${f.size}`,
    `px=${f.price.toFixed(3)}`,
    f.tokenId ? `token=${f.tokenId.slice(0, 16)}` : null,
    f.reason ? `reason=${f.reason}` : null,
  ].filter(Boolean);
  try {
    fs.appendFileSync(MIRROR_LOG_PATH, parts.join(" ") + "\n");
  } catch (err) {
    console.error(`[live-mirror-log] write failed: ${err instanceof Error ? err.message : err}`);
  }
}
