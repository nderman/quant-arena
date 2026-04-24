#!/usr/bin/env python3
"""Full cross-arena engine performance analysis.

Reads per-arena round_history files (data/round_history_{instance_id}.json
after the Apr 24 arena-id split; data/backfill/*.json for historical).
Emits:
  - TIER 1: profitable engines with positive expected value per round
  - Per-coin best engines
  - Per-interval profit density
  - Cross-arena winners (engines profitable in 2+ arenas)
  - Risk-sorted table separating SAFE (bounded loss) vs WILD (can bust)

Usage:
  python3 scripts/crossArenaAnalysis.py                     # VPS canonical
  python3 scripts/crossArenaAnalysis.py --source backfill   # local backfill
  python3 scripts/crossArenaAnalysis.py --source local      # data/ local
  python3 scripts/crossArenaAnalysis.py --min-rounds 5      # tighten sample
  python3 scripts/crossArenaAnalysis.py --bankroll 50       # safety threshold
"""
import json, os, subprocess, argparse
from collections import defaultdict
from statistics import mean

VPS = "root@165.232.84.91"
REMOTE_DIR = "~/quant-arena/data"
BACKFILL_DIR = "data/backfill"
LOCAL_DIR = "data"
ARENAS = [
    ("btc","5m"), ("btc","15m"), ("btc","1h"), ("btc","4h"),
    ("eth","5m"), ("eth","15m"), ("eth","1h"), ("eth","4h"),
    ("sol","5m"), ("sol","15m"), ("sol","1h"), ("sol","4h"),
]


def arena_id(coin, interval):
    return coin if interval == "5m" else f"{coin}-{interval}"


def load_history(instance_id, source):
    fname = f"round_history_{instance_id}.json"
    if source == "backfill":
        path = os.path.join(BACKFILL_DIR, fname)
    elif source == "local":
        path = os.path.join(LOCAL_DIR, fname)
    else:  # vps
        path = None
    if path:
        try:
            with open(path) as f: return json.load(f)
        except Exception: return []
    # VPS fetch
    try:
        r = subprocess.run(["ssh", VPS, f"cat {REMOTE_DIR}/{fname}"],
                          capture_output=True, text=True, timeout=15)
        return json.loads(r.stdout) if r.returncode == 0 else []
    except Exception: return []


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--source", choices=["vps", "backfill", "local"], default="vps")
    p.add_argument("--min-rounds", type=int, default=3)
    p.add_argument("--bankroll", type=float, default=50,
                   help="Bankroll for SAFE/WILD classification (worst_loss must be ≤40%% of bankroll to be SAFE)")
    p.add_argument("--top", type=int, default=20, help="Top N rows per section")
    return p.parse_args()


def main():
    args = parse_args()
    safe_threshold = -args.bankroll * 0.4

    # (engine, arena) -> list of pnls across rounds
    results = []
    for coin, interval in ARENAS:
        iid = arena_id(coin, interval)
        rounds = load_history(iid, args.source)
        if not rounds: continue

        per_eng = defaultdict(list)
        for r in rounds:
            for e in r.get("allResults", []):
                # Honest filter: tradeCount, not pnl. An engine that traded and
                # broke even (pnl == 0) is real data; an engine with tradeCount=0
                # is a silent round and must be excluded. Using `pnl != 0`
                # drops the "traded and broke even" case silently.
                if e.get("tradeCount", 0) > 0:
                    per_eng[e["engineId"]].append(e.get("totalPnl", 0))
        for eid, pnls in per_eng.items():
            if len(pnls) < 2: continue
            n = len(pnls)
            total = sum(pnls)
            wins = [p for p in pnls if p > 0]
            losses = [p for p in pnls if p < 0]
            wr = len(wins) / n
            avg_w = mean(wins) if wins else 0
            avg_l = mean(losses) if losses else 0
            worst = min(pnls)
            best = max(pnls)
            ev = wr * avg_w + (1 - wr) * avg_l
            safety = "SAFE" if worst > safe_threshold else "WILD"
            results.append({
                "eid": eid, "arena": iid, "coin": coin, "interval": interval,
                "n": n, "total": total, "wr": wr,
                "avg_w": avg_w, "avg_l": avg_l,
                "worst": worst, "best": best, "ev": ev, "safety": safety,
            })

    if not results:
        print(f"No data found (source={args.source}). Try --source backfill or --source local.")
        return

    total_rounds = sum(r["n"] for r in results)
    print(f"# Cross-Arena Engine Analysis")
    print()
    print(f"Source: `{args.source}`  |  "
          f"{len(results)} (engine, arena) pairs, {total_rounds} engine-rounds  |  "
          f"SAFE threshold: worst_loss > ${safe_threshold:.0f} ({args.bankroll} bankroll × 40%)")
    print()

    # TIER 1: positive net + positive EV
    print(f"## TIER 1 — profitable with positive EV (n ≥ {args.min_rounds})")
    print()
    print("| Engine | Arena | n | Net | WR | AvgW | AvgL | Worst | Best | EV/rd | Safety |")
    print("|--------|-------|---|-----|-----|------|------|-------|------|-------|--------|")
    tier1 = [r for r in results if r["total"] > 0 and r["n"] >= args.min_rounds and r["ev"] > 0]
    tier1.sort(key=lambda x: -x["ev"])
    for r in tier1[:args.top]:
        print(f"| {r['eid']} | {r['arena']} | {r['n']} | ${r['total']:+.0f} | {r['wr']*100:.0f}% | "
              f"${r['avg_w']:+.1f} | ${r['avg_l']:.1f} | ${r['worst']:+.0f} | ${r['best']:+.0f} | "
              f"${r['ev']:+.1f} | {r['safety']} |")
    print()

    # Safe candidates only
    print(f"## SAFE candidates (bounded worst loss, ready for live)")
    print()
    print("| Engine | Arena | n | Net | WR | Worst | EV/rd |")
    print("|--------|-------|---|-----|-----|-------|-------|")
    safe = [r for r in tier1 if r["safety"] == "SAFE"]
    safe.sort(key=lambda x: -x["ev"])
    for r in safe:
        print(f"| **{r['eid']}** | **{r['arena']}** | {r['n']} | ${r['total']:+.0f} | "
              f"{r['wr']*100:.0f}% | ${r['worst']:+.0f} | ${r['ev']:+.1f} |")
    if not safe:
        print("| _no SAFE candidates yet_ | | | | | | |")
    print()

    # Per-coin best
    print("## Per-coin top 3 (by net PnL, safety flagged)")
    by_coin = defaultdict(list)
    for r in results:
        if r["total"] > 0: by_coin[r["coin"]].append(r)
    for coin in ("btc", "eth", "sol"):
        print(f"### {coin.upper()}")
        top = sorted(by_coin[coin], key=lambda x: -x["total"])[:3]
        for r in top:
            print(f"- {r['eid']} @ {r['arena']}: ${r['total']:+.0f} / {r['n']} rounds, "
                  f"WR {r['wr']*100:.0f}%, worst ${r['worst']:+.0f} — **{r['safety']}**")
        print()

    # Per-interval profit
    print("## Per-interval profit density (positive pairs only)")
    by_int = defaultdict(lambda: {"pairs": 0, "total": 0})
    for r in results:
        if r["total"] > 0:
            by_int[r["interval"]]["pairs"] += 1
            by_int[r["interval"]]["total"] += r["total"]
    for iv in ("5m", "15m", "1h", "4h"):
        s = by_int[iv]
        print(f"- **{iv}**: {s['pairs']} positive pairs, ${s['total']:+.0f} total")
    print()

    # Cross-arena engines
    print("## Engines profitable in multiple arenas (cross-arena signal)")
    eng_arenas = defaultdict(list)
    for r in results:
        if r["total"] > 20:
            eng_arenas[r["eid"]].append((r["arena"], r["total"], r["n"], r["safety"]))
    cross = [(eid, arenas) for eid, arenas in eng_arenas.items() if len(arenas) >= 2]
    cross.sort(key=lambda x: -sum(a[1] for a in x[1]))
    for eid, arenas in cross:
        total_all = sum(a[1] for a in arenas)
        arenas_str = ", ".join(f"{a}(${t:+.0f}/{n}, {s})" for a, t, n, s in arenas)
        print(f"- **{eid}** — {arenas_str} — total ${total_all:+.0f}")
    if not cross:
        print("_no engine yet profitable in ≥2 arenas_")


if __name__ == "__main__":
    main()
