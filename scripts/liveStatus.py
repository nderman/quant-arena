#!/usr/bin/env python3
"""One-shot live state report.

Combines the four reads we keep stitching together:
  - Current roster (data/live_engines.json)
  - Active cooldowns (data/auto_rotation_cooldown.json) with hours remaining
  - Last 5 auto_rotation.log entries
  - 24h ledger PnL by engine (livePnLByEngine logic)
  - Open Polymarket positions (Activity API)

Run on VPS for the canonical view.

Usage:
  python3 scripts/liveStatus.py                # default: 24h ledger window
  python3 scripts/liveStatus.py --since 6h
"""
from __future__ import annotations
import argparse, json, os, sys, urllib.request, datetime as dt
from pathlib import Path

from _live_ledger import LEDGER_PATH, aggregate, read_rows

DATA_DIR = Path(os.environ.get("QUANT_DATA_DIR", "data"))
ROSTER_PATH = DATA_DIR / "live_engines.json"
COOLDOWN_PATH = DATA_DIR / "auto_rotation_cooldown.json"
LOG_PATH = DATA_DIR / "auto_rotation.log"
WALLET = os.environ.get("PM_FUNDER", "")
if not WALLET:
    raise SystemExit("PM_FUNDER env var required")


def section(title: str):
    print(f"\n=== {title} ===")


def show_roster():
    section("ROSTER (data/live_engines.json)")
    if not ROSTER_PATH.exists():
        print("  (no roster file)")
        return
    roster = json.loads(ROSTER_PATH.read_text())
    if not roster:
        print("  (empty)")
        return
    for arena, engines in sorted(roster.items()):
        for e in engines:
            print(f"  {arena:<10} → {e['engineId']:<30} bankroll=${e['bankrollUsd']:.0f}")


def show_cooldowns():
    section("COOLDOWNS (data/auto_rotation_cooldown.json)")
    if not COOLDOWN_PATH.exists():
        print("  (none)")
        return
    cooldowns = json.loads(COOLDOWN_PATH.read_text())
    if not cooldowns:
        print("  (none active)")
        return
    now = dt.datetime.now(dt.timezone.utc).timestamp()
    for pair, expiry in sorted(cooldowns.items(), key=lambda kv: kv[1]):
        remaining_h = (expiry - now) / 3600
        if remaining_h <= 0:
            print(f"  {pair:<48} EXPIRED ({-remaining_h:.1f}h ago)")
        else:
            until = dt.datetime.fromtimestamp(expiry, dt.timezone.utc).strftime("%H:%M UTC")
            print(f"  {pair:<48} {remaining_h:.1f}h remaining (until {until})")


def show_recent_log():
    section("RECENT AUTO_ROTATION.LOG")
    if not LOG_PATH.exists():
        print("  (no log file)")
        return
    lines = LOG_PATH.read_text().splitlines()
    # Group by run (each run starts with "current regime:")
    runs = []
    cur = []
    for line in lines:
        if "current regime:" in line and cur:
            runs.append(cur)
            cur = [line]
        else:
            cur.append(line)
    if cur:
        runs.append(cur)
    for run in runs[-3:]:
        for line in run:
            print(f"  {line}")
        print()


def show_ledger_pnl(since: str):
    section(f"LEDGER PnL since {since} (data/live_trades.jsonl)")
    if not LEDGER_PATH.exists():
        print("  (no ledger file)")
        return
    rows = read_rows(LEDGER_PATH, since=since)
    per_pair = aggregate(rows)
    if not per_pair:
        print(f"  (no rows in window — {len(rows)} total ledger rows)")
        return

    print(f"  {len(rows)} ledger rows in window\n")
    print(f"  {'Engine @ Arena':<42} {'Fires':<6} {'W/L':<6} {'WR':<5} {'Stake':<9} {'Realized':<11} {'Open':<10}")
    print("  " + "-" * 95)
    sorted_pairs = sorted(per_pair.items(), key=lambda kv: kv[1]["realized"], reverse=True)
    totals = {"stake": 0.0, "realized": 0.0, "open": 0.0, "wins": 0, "losses": 0, "fires": 0}
    for (eid, arena), s in sorted_pairs:
        settles = s["wins"] + s["losses"]
        wr = (s["wins"] / settles * 100) if settles else 0
        wl = f"{s['wins']}/{s['losses']}"
        open_str = f"{s['open_n']}/${s['open_stake']:.2f}" if s["open_n"] else "—"
        print(f"  {f'{eid} @ {arena}':<42} {s['buys']:<6} {wl:<6} {wr:<4.0f}% ${s['stake']:<8.2f} ${s['realized']:+9.2f}  {open_str:<10}")
        totals["stake"] += s["stake"]
        totals["realized"] += s["realized"]
        totals["open"] += s["open_stake"]
        totals["wins"] += s["wins"]
        totals["losses"] += s["losses"]
        totals["fires"] += s["buys"]
    print("  " + "-" * 95)
    overall_wr = totals["wins"] / max(1, totals["wins"] + totals["losses"]) * 100
    print(f"  {'TOTAL':<42} {totals['fires']:<6} {totals['wins']}/{totals['losses']:<3} "
          f"{overall_wr:<4.0f}% ${totals['stake']:<8.2f} ${totals['realized']:+9.2f}  ${totals['open']:.2f} open")


def show_open_positions():
    section("OPEN POLYMARKET POSITIONS (Activity API)")
    url = f"https://data-api.polymarket.com/positions?user={WALLET}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "quant-arena-liveStatus"})
        with urllib.request.urlopen(req, timeout=15) as r:
            positions = json.loads(r.read())
    except Exception as e:
        print(f"  (Activity API fetch failed: {e})")
        return
    open_pos = [p for p in positions if p.get("size", 0) >= 0.5]
    if not open_pos:
        print("  (no open positions)")
        return
    total_cost = total_value = 0.0
    print(f"  {'Outcome':<6} {'Shares':>7} {'Avg':>7} {'Now':>7} {'Cost':>8} {'MTM':>8} {'PnL':>8}  Market")
    print("  " + "-" * 110)
    for p in open_pos:
        size = p.get("size", 0)
        avg = p.get("avgPrice", 0)
        cur = p.get("curPrice", 0)
        cost = size * avg
        val = size * cur
        pnl = val - cost
        total_cost += cost
        total_value += val
        outcome = p.get("outcome", "")
        title = p.get("title", "")[:60]
        print(f"  {outcome:<6} {size:>7.1f} ${avg:>6.3f} ${cur:>6.3f} ${cost:>7.2f} ${val:>7.2f} ${pnl:>+7.2f}  {title}")
    print("  " + "-" * 110)
    print(f"  {'TOTAL':<6} {'':>7} {'':>7} {'':>7} ${total_cost:>7.2f} ${total_value:>7.2f} ${total_value-total_cost:>+7.2f}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="24h", help="ledger window: '24h', '7d', or ISO")
    args = ap.parse_args()

    print(f"=== LIVE STATUS — {dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')} ===")
    show_roster()
    show_cooldowns()
    show_recent_log()
    show_ledger_pnl(args.since)
    show_open_positions()
    return 0


if __name__ == "__main__":
    sys.exit(main())
