#!/usr/bin/env python3
"""sim:live fidelity audit, roster-aware.

Compares sim activity to live activity for each (engine, arena) pair
constrained to the windows when that engine was actually on the live
roster for that arena. Comparing without this filter is misleading —
sim runs every engine on every arena 24/7, but live only mirrors fires
from rostered slots.

Output: per-(engine, arena) windowed comparison + a "verdict" column.

Verdicts:
  match           sim and live both produced fires (or both silent) in window
  noisy           one fired but n is too small for confidence (< MIN_N rounds)
  diverge_phantom sim fired but live didn't — sim may overstate edge
  diverge_other   live fired but sim didn't — engine state diverged

Sources:
  rostering windows: data/live_engines.json + .bak files (auto_rotate writes a
                     bak before each swap; bak content = state being replaced)
  sim activity:      data/round_history_<arena>.json
  live fires:        data/live_trades.jsonl (forward-only, _source!="sync"|"backfill")
  live submits:      data/live_emit.log (every order attempt + reject reason)

Usage:
  python3 scripts/simLiveAudit.py
  python3 scripts/simLiveAudit.py --engine bred-fw8t
  python3 scripts/simLiveAudit.py --arena eth-4h
"""
from __future__ import annotations
import argparse, glob, json, os, sys, datetime as dt
from collections import defaultdict
from pathlib import Path

DATA_DIR = Path(os.environ.get("QUANT_DATA_DIR", "data"))
LEDGER_PATH = DATA_DIR / "live_trades.jsonl"
EMIT_LOG = DATA_DIR / "live_emit.log"
MIN_N_FOR_VERDICT = 3  # need at least N rounds to call divergence


def reconstruct_roster_windows() -> dict[tuple[str, str], list[tuple[float, float]]]:
    """Walk .bak files in order; each bak's content was the roster up to its mtime.

    Returns: (engine_id, arena) -> list of (start_ts, end_ts) intervals (UTC seconds).
    """
    baks = sorted(glob.glob(str(DATA_DIR / "live_engines.json.bak.*")), key=os.path.getmtime)
    windows: list[tuple[float, float, set[tuple[str, str]]]] = []
    prev_ts = 0.0
    for f in baks:
        ts = os.path.getmtime(f)
        try:
            d = json.load(open(f))
        except Exception:
            continue
        roster = set()
        for arena, engines in d.items():
            for e in engines:
                roster.add((e.get("engineId"), arena))
        windows.append((prev_ts, ts, roster))
        prev_ts = ts
    cur_path = DATA_DIR / "live_engines.json"
    if cur_path.exists():
        d = json.load(open(cur_path))
        roster = set()
        for arena, engines in d.items():
            for e in engines:
                roster.add((e.get("engineId"), arena))
        windows.append((prev_ts, dt.datetime.now(dt.timezone.utc).timestamp(), roster))

    rostered: dict[tuple[str, str], list[tuple[float, float]]] = defaultdict(list)
    for start, end, roster in windows:
        for k in roster:
            if rostered[k] and abs(rostered[k][-1][1] - start) < 1.0:
                rostered[k][-1] = (rostered[k][-1][0], end)
            else:
                rostered[k].append((start, end))
    return rostered


def load_sim_rounds(arena: str) -> list[dict]:
    path = DATA_DIR / f"round_history_{arena}.json"
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text())
    except Exception:
        return []


def round_ts(r: dict) -> float | None:
    s = r.get("timestamp")
    if not s:
        return None
    try:
        return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


def load_live_fills() -> list[dict]:
    """Forward-emitted FILL rows only — sync rows are phantom-attributed."""
    if not LEDGER_PATH.exists():
        return []
    out = []
    for line in LEDGER_PATH.read_text().splitlines():
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("_source") in ("sync", "backfill"):
            continue
        if r.get("type") == "FILL" and r.get("side") == "BUY":
            out.append(r)
    return out


def load_live_submits() -> list[dict]:
    """Parse live_emit.log SUBMITs + REJECTs into structured rows."""
    if not EMIT_LOG.exists():
        return []
    out = []
    for line in EMIT_LOG.read_text().splitlines():
        if not line.strip():
            continue
        # Format: "2026-05-04T12:20:35.257Z SUBMIT engine=X arena=Y ..."
        parts = line.split(" ", 2)
        if len(parts) < 3:
            continue
        try:
            ts = dt.datetime.fromisoformat(parts[0].replace("Z", "+00:00")).timestamp()
        except Exception:
            continue
        kind = parts[1]
        kv = {}
        for token in parts[2].split(" "):
            if "=" in token:
                k, v = token.split("=", 1)
                kv[k] = v
        kv["ts"] = ts
        kv["kind"] = kind
        out.append(kv)
    return out


def in_window(ts: float, intervals: list[tuple[float, float]]) -> bool:
    return any((s == 0 or ts >= s) and ts <= e for s, e in intervals)


def fmt_window(start: float, end: float) -> tuple[str, str, float]:
    s_iso = (
        dt.datetime.fromtimestamp(start, dt.timezone.utc).strftime("%m-%d %H:%M")
        if start > 0
        else "early"
    )
    e_iso = dt.datetime.fromtimestamp(end, dt.timezone.utc).strftime("%m-%d %H:%M")
    return s_iso, e_iso, (end - start) / 3600 if start > 0 else 0


def verdict(sim_fired: int, sim_total: int, live_fired: int) -> str:
    if sim_total < MIN_N_FOR_VERDICT:
        if sim_fired == 0 and live_fired == 0:
            return "both silent (small n)"
        return "noisy"
    if sim_fired == 0 and live_fired == 0:
        return "match (both silent)"
    if sim_fired > 0 and live_fired == 0:
        return "DIVERGE: sim fires, live silent"
    if sim_fired == 0 and live_fired > 0:
        return "DIVERGE: live fires, sim silent"
    return "match"


def main() -> int:
    global MIN_N_FOR_VERDICT
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", help="filter to a single engine_id")
    ap.add_argument("--arena", help="filter to a single arena_instance_id")
    ap.add_argument("--min-n", type=int, default=MIN_N_FOR_VERDICT,
                    help=f"min rounds in window before declaring divergence (default {MIN_N_FOR_VERDICT})")
    args = ap.parse_args()
    MIN_N_FOR_VERDICT = args.min_n

    rostered = reconstruct_roster_windows()
    fills = load_live_fills()
    submits = load_live_submits()

    keys = sorted(rostered.keys(), key=lambda k: (k[1], k[0]))
    if args.engine:
        keys = [k for k in keys if k[0] == args.engine]
    if args.arena:
        keys = [k for k in keys if k[1] == args.arena]

    if not keys:
        print("(no rostering history matches filter)")
        return 1

    print(f"=== sim:live audit (rostering-window-aware, min-n={MIN_N_FOR_VERDICT}) ===\n")
    print(f"  {'engine @ arena':<48}  {'window':<35}  {'sim_rnds':>8}  {'sim_fired':>9}  {'live_fired':>10}  verdict")
    print("  " + "-" * 130)

    for eid, arena in keys:
        intervals = rostered[(eid, arena)]
        sim_rounds = load_sim_rounds(arena)
        for start, end in intervals:
            s_iso, e_iso, dur_h = fmt_window(start, end)
            window_str = f"{s_iso} → {e_iso} ({dur_h:.1f}h)" if dur_h > 0 else f"early → {e_iso}"

            sim_in_window = []
            for r in sim_rounds:
                ts = round_ts(r)
                if ts is None or not in_window(ts, [(start, end)]):
                    continue
                for e in r.get("allResults", []):
                    if (e.get("engineId") or e.get("id")) == eid:
                        sim_in_window.append((r, e))
                        break
            sim_total = len(sim_in_window)
            sim_fired = sum(1 for _, e in sim_in_window if e.get("tradeCount", 0) > 0)

            live_fires = sum(
                1 for f in fills
                if f.get("engineId") == eid and f.get("arenaInstanceId") == arena
                and (start == 0 or f.get("ts", 0) / 1000 >= start) and f.get("ts", 0) / 1000 <= end
            )
            live_submits = sum(
                1 for s in submits
                if s.get("engine") == eid and s.get("arena") == arena
                and (start == 0 or s["ts"] >= start) and s["ts"] <= end
                and s["kind"] == "SUBMIT"
            )
            live_rejects = sum(
                1 for s in submits
                if s.get("engine") == eid and s.get("arena") == arena
                and (start == 0 or s["ts"] >= start) and s["ts"] <= end
                and s["kind"] == "REJECT"
            )

            v = verdict(sim_fired, sim_total, live_fires + live_submits)
            live_str = f"{live_fires}f"
            if live_submits or live_rejects:
                live_str += f"+{live_submits}sub-{live_rejects}rej"
            print(f"  {eid + ' @ ' + arena:<48}  {window_str:<35}  {sim_total:>8}  {sim_fired:>9}  {live_str:>10}  {v}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
