#!/usr/bin/env python3
"""Head-to-head comparison across a filtered engine set.

Built for A/B parameter sweeps: pass --prefix dca- to compare the DCA
variant family side-by-side. Shows per-round PnL, aggregate stats, and
per-coin breakdown so you can tell whether a variant wins globally or
only on one coin.

Usage:
  python3 scripts/engineCompare.py                    # all engines, VPS fetch
  python3 scripts/engineCompare.py --prefix dca-      # DCA family only
  python3 scripts/engineCompare.py --engines dca-extreme-v1,dca-solo-v1
  python3 scripts/engineCompare.py --local            # local data dir
  python3 scripts/engineCompare.py --rounds 10        # last 10 rounds only
"""
import json, sys, os, subprocess, argparse
from collections import defaultdict
from statistics import mean, median

VPS = "root@165.232.84.91"
REMOTE_DIR = "~/quant-arena/data"
LOCAL_DIR = "data"
COINS = ["btc", "eth", "sol"]


def load_history(coin, local):
    if local:
        path = os.path.join(LOCAL_DIR, f"round_history_{coin}.json")
        if not os.path.exists(path):
            return None
        with open(path) as f:
            return json.load(f)
    try:
        result = subprocess.run(
            ["ssh", VPS, f"cat {REMOTE_DIR}/round_history_{coin}.json"],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            return None
        return json.loads(result.stdout)
    except Exception as e:
        print(f"  [{coin}] fetch error: {e}", file=sys.stderr)
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prefix", help="only include engines whose id starts with this")
    ap.add_argument("--engines", help="comma-separated explicit engine ids")
    ap.add_argument("--local", action="store_true", help="use ./data instead of VPS")
    ap.add_argument("--rounds", type=int, default=0, help="only last N rounds per coin")
    args = ap.parse_args()

    explicit = set(args.engines.split(",")) if args.engines else None

    def include(engine_id):
        if explicit is not None:
            return engine_id in explicit
        if args.prefix:
            return engine_id.startswith(args.prefix)
        return True

    # engine -> coin -> list of (round_idx, pnl, trades)
    per = defaultdict(lambda: defaultdict(list))
    round_counts = {}

    for coin in COINS:
        history = load_history(coin, args.local)
        if history is None:
            print(f"[{coin}] no history")
            continue
        if args.rounds > 0:
            history = history[-args.rounds:]
        round_counts[coin] = len(history)

        for round_idx, entry in enumerate(history):
            for r in entry.get("allResults", []):
                eid = r.get("engineId")
                if eid is None or not include(eid):
                    continue
                pnl = r.get("totalPnl", 0) or 0
                trades = r.get("tradeCount", 0) or 0
                per[eid][coin].append((round_idx, pnl, trades))

    if not per:
        print("No matching engines.")
        return

    coin_hdr = " ".join(f"{c}={round_counts.get(c, 0)}" for c in COINS)
    print(f"Rounds per coin: {coin_hdr}")
    print()

    # ── Aggregate table ──
    print("=" * 110)
    print("HEAD-TO-HEAD — aggregate across all coins")
    print("=" * 110)
    print(f"{'engine':<28}{'rounds':>8}{'total':>12}{'mean':>10}{'median':>10}"
          f"{'win%':>8}{'best':>10}{'worst':>10}{'trades':>10}")
    print("-" * 110)

    def flatten(eid):
        out = []
        for coin in COINS:
            out.extend(per[eid][coin])
        return out

    rows = []
    for eid in per:
        entries = flatten(eid)
        if not entries:
            continue
        pnls = [p for _, p, _ in entries]
        trades = sum(t for _, _, t in entries)
        wins = sum(1 for p in pnls if p > 0)
        rows.append({
            "eid": eid,
            "n": len(pnls),
            "total": sum(pnls),
            "mean": mean(pnls),
            "median": median(pnls),
            "win_pct": 100 * wins / len(pnls),
            "best": max(pnls),
            "worst": min(pnls),
            "trades": trades,
        })

    rows.sort(key=lambda r: -r["total"])
    for r in rows:
        print(f"{r['eid']:<28}{r['n']:>8}{r['total']:>+12.1f}{r['mean']:>+10.1f}"
              f"{r['median']:>+10.1f}{r['win_pct']:>7.0f}%{r['best']:>+10.1f}"
              f"{r['worst']:>+10.1f}{r['trades']:>10}")

    # ── Per-coin breakdown ──
    print()
    print("=" * 110)
    print("PER-COIN BREAKDOWN (total / mean × rounds)")
    print("=" * 110)
    hdr = f"{'engine':<28}"
    for coin in COINS:
        hdr += f"{coin.upper():>24}"
    print(hdr)
    print("-" * 110)

    for r in rows:
        eid = r["eid"]
        row = f"{eid:<28}"
        for coin in COINS:
            pnls = [p for _, p, _ in per[eid][coin]]
            if not pnls:
                row += f"{'—':>24}"
            else:
                row += f" {sum(pnls):>+8.1f} / {mean(pnls):>+6.1f}×{len(pnls):<3}"
        print(row)

    # ── Side-by-side round grid (if manageable) ──
    if len(rows) <= 8 and max(round_counts.values(), default=0) <= 25:
        print()
        print("=" * 110)
        print("PER-ROUND PnL (columns = engines, rows = rounds, one section per coin)")
        print("=" * 110)
        for coin in COINS:
            n_rounds = round_counts.get(coin, 0)
            if n_rounds == 0:
                continue
            print(f"\n[{coin.upper()}]")
            hdr = f"{'round':<8}"
            for r in rows:
                hdr += f"{r['eid'][:14]:>16}"
            print(hdr)
            for round_idx in range(n_rounds):
                line = f"{round_idx:<8}"
                for r in rows:
                    match = [p for i, p, _ in per[r['eid']][coin] if i == round_idx]
                    line += f"{match[0]:>+16.1f}" if match else f"{'—':>16}"
                print(line)


if __name__ == "__main__":
    main()
