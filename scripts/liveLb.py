#!/usr/bin/env python3
"""Live leaderboard — pull current mid-round state from all arenas on VPS.

Parses the latest tick snapshot from each arena's PM2 log output.
Shows all coins (btc/eth/sol) and all intervals (5m/15m/1h/4h).

NOTE: pnl in arena logs = cash + mtm - startingCash (already includes MTM).
We show: pnl (total), mtm (unrealized portion), realized = pnl - mtm.

Usage:
  python3 scripts/liveLb.py           # all arenas
  python3 scripts/liveLb.py btc       # BTC only
  python3 scripts/liveLb.py --top 10  # top 10 only
  python3 scripts/liveLb.py --5m      # only 5M arenas (trustworthy data)
"""
import subprocess, sys, re, argparse
from collections import defaultdict

VPS = "root@165.232.84.91"
ARENA_DIR = "/root/quant-arena/logs"

ARENAS = [
    ("btc", "5m"),
    ("eth", "5m"),
    ("sol", "5m"),
    ("btc", "15m"),
    ("btc", "1h"),
    ("btc", "4h"),
]

BROKEN_INTERVALS = {"15m", "1h", "4h"}

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("coin", nargs="?", help="Filter to one coin")
    p.add_argument("--top", type=int, default=0, help="Show only top N")
    p.add_argument("--active", action="store_true", help="Only engines with trades>0")
    p.add_argument("--5m", dest="only_5m", action="store_true", help="Only 5M arenas (trustworthy)")
    return p.parse_args()

def log_file(coin, interval):
    if interval == "5m":
        return f"{ARENA_DIR}/arena-{coin}-out.log"
    return f"{ARENA_DIR}/arena-{coin}-{interval}-out.log"

def fetch_snapshot(coin, interval):
    path = log_file(coin, interval)
    cmd = f"tail -2000 {path} 2>/dev/null | grep -E '^\\S+ \\S+ \\S+:   \\S' | tail -80"
    try:
        out = subprocess.check_output(
            ["ssh", VPS, cmd], timeout=10, stderr=subprocess.DEVNULL
        ).decode()
    except Exception:
        return {}

    engines = {}
    for line in out.strip().split("\n"):
        if not line.strip():
            continue
        m = re.search(r'(\S+): cash=\$(\S+) mtm=\$(\S+) pnl=([+$\-\d.]+) trades=(\d+) fees=\$(\S+)', line)
        if not m:
            continue
        eid = m.group(1)
        cash = float(m.group(2))
        mtm = float(m.group(3))
        pnl_str = m.group(4).replace('$', '')
        pnl = float(pnl_str)  # this is cash + mtm - starting (already includes mtm)
        trades = int(m.group(5))
        fees = float(m.group(6))
        rebate = 0.0
        rm = re.search(r'rebate=\$(\S+)', line)
        if rm:
            rebate = float(rm.group(1))
        realized = pnl - mtm  # realized = (cash - starting)
        engines[eid] = dict(pnl=pnl, mtm=mtm, realized=realized, trades=trades, fees=fees, rebate=rebate, cash=cash)
    return engines

def main():
    args = parse_args()
    arenas = ARENAS
    if args.coin:
        arenas = [(c, i) for c, i in arenas if c == args.coin.lower()]
    if args.only_5m:
        arenas = [(c, i) for c, i in arenas if i == "5m"]

    all_data = {}
    for coin, interval in arenas:
        snap = fetch_snapshot(coin, interval)
        if snap:
            all_data[(coin, interval)] = snap

    if not all_data:
        print("No data from any arena.")
        return

    for (coin, interval), engines in sorted(all_data.items()):
        tag = f"{coin.upper()} {interval}"
        broken = interval in BROKEN_INTERVALS
        active = {k: v for k, v in engines.items() if v["trades"] > 0}
        silent = len(engines) - len(active)

        rows = sorted(engines.items(), key=lambda x: x[1]["pnl"], reverse=True)
        if args.active:
            rows = [(k, v) for k, v in rows if v["trades"] > 0]
        if args.top:
            rows = rows[:args.top]

        print(f"\n{'='*90}")
        warn = "  !! BROKEN: no settlement, stale MTM !!" if broken else ""
        print(f"  {tag}  |  {len(active)} active, {silent} silent{warn}")
        print(f"{'='*90}")
        print(f"  {'engine':<28} {'pnl':>8} {'real':>8} {'mtm':>8} {'trades':>6} {'fees':>7}")
        print(f"  {'-'*28} {'-'*8} {'-'*8} {'-'*8} {'-'*6} {'-'*7}")

        for eid, d in rows:
            pnl_s = f"{d['pnl']:+.2f}"
            real_s = f"{d['realized']:+.2f}"
            mtm_s = f"{d['mtm']:.2f}" if d["mtm"] > 0 else ""
            fees_s = f"{d['fees']:.4f}" if d["fees"] > 0 else ""
            trades_s = str(d["trades"]) if d["trades"] > 0 else ""
            print(f"  {eid:<28} {pnl_s:>8} {real_s:>8} {mtm_s:>8} {trades_s:>6} {fees_s:>7}")

    # Cross-arena aggregate (5M only)
    reliable = {k: v for k, v in all_data.items() if k[1] == "5m"}
    if len(reliable) > 1:
        agg = defaultdict(lambda: dict(pnl=0, mtm=0, realized=0, trades=0, fees=0, arenas=0))
        for (coin, interval), engines in reliable.items():
            for eid, d in engines.items():
                a = agg[eid]
                a["pnl"] += d["pnl"]
                a["mtm"] += d["mtm"]
                a["realized"] += d["realized"]
                a["trades"] += d["trades"]
                a["fees"] += d["fees"]
                a["arenas"] += 1

        rows = sorted(agg.items(), key=lambda x: x[1]["pnl"], reverse=True)
        if args.active:
            rows = [(k, v) for k, v in rows if v["trades"] > 0]
        if args.top:
            rows = rows[:args.top]

        print(f"\n{'='*90}")
        print(f"  AGGREGATE (5M arenas only — trustworthy)  |  {len(reliable)} arenas")
        print(f"{'='*90}")
        print(f"  {'engine':<28} {'pnl':>8} {'real':>8} {'mtm':>8} {'trades':>6} {'arenas':>6}")
        print(f"  {'-'*28} {'-'*8} {'-'*8} {'-'*8} {'-'*6} {'-'*6}")

        for eid, d in rows:
            pnl_s = f"{d['pnl']:+.2f}"
            real_s = f"{d['realized']:+.2f}"
            mtm_s = f"{d['mtm']:.2f}" if d["mtm"] > 0 else ""
            trades_s = str(d["trades"]) if d["trades"] > 0 else ""
            print(f"  {eid:<28} {pnl_s:>8} {real_s:>8} {mtm_s:>8} {trades_s:>6} {d['arenas']:>6}")

if __name__ == "__main__":
    main()
