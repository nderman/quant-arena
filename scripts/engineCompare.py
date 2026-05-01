#!/usr/bin/env python3
"""Head-to-head comparison across a filtered engine set (multi-arena).

Built for A/B parameter sweeps: pass --prefix dca- to compare the DCA
variant family side-by-side. Shows per-arena PnL, aggregate stats, and
per-arena breakdown so you can tell whether a variant wins globally or
only on one arena.

Usage:
  python3 scripts/engineCompare.py                                # all engines
  python3 scripts/engineCompare.py --prefix dca-                  # DCA family only
  python3 scripts/engineCompare.py --engines dca-extreme-v1,dca-solo-v1
  python3 scripts/engineCompare.py --source vps                   # SSH instead of local
  python3 scripts/engineCompare.py --rounds 10                    # last 10 rounds per arena
  python3 scripts/engineCompare.py --arena btc-1h                 # one arena only
"""
import argparse
from collections import defaultdict
from statistics import mean, median

from _arena_history import iter_rounds


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prefix", help="only include engines whose id starts with this")
    ap.add_argument("--engines", help="comma-separated explicit engine ids")
    ap.add_argument("--source", choices=["local", "vps", "backfill"], default="local")
    ap.add_argument("--rounds", type=int, default=0, help="last N rounds per arena")
    ap.add_argument("--arena", help="restrict to one arena id (e.g. btc-1h)")
    args = ap.parse_args()

    explicit = set(args.engines.split(",")) if args.engines else None

    def include(engine_id):
        if explicit is not None:
            return engine_id in explicit
        if args.prefix:
            return engine_id.startswith(args.prefix)
        return True

    # engine -> arena -> [(round_idx, pnl, trades)]
    per = defaultdict(lambda: defaultdict(list))
    arena_round_counts = {}

    arena_rounds = defaultdict(list)
    for arena, rd in iter_rounds(args.source):
        if args.arena and arena != args.arena:
            continue
        arena_rounds[arena].append(rd)

    for arena, rounds in arena_rounds.items():
        if args.rounds > 0:
            rounds = rounds[-args.rounds:]
        arena_round_counts[arena] = len(rounds)
        for round_idx, entry in enumerate(rounds):
            for r in entry.get("allResults", []):
                eid = r.get("engineId")
                if eid is None or not include(eid):
                    continue
                pnl = r.get("totalPnl", 0) or 0
                trades = r.get("tradeCount", 0) or 0
                per[eid][arena].append((round_idx, pnl, trades))

    if not per:
        print("No matching engines.")
        return

    print("Rounds per arena: " + " ".join(f"{a}={n}" for a, n in sorted(arena_round_counts.items())))
    print()

    print("=" * 110)
    print("HEAD-TO-HEAD — aggregate across all arenas")
    print("=" * 110)
    print(f"{'engine':<28}{'rounds':>8}{'total':>12}{'mean':>10}{'median':>10}"
          f"{'win%':>8}{'best':>10}{'worst':>10}{'trades':>10}")
    print("-" * 110)

    def flatten(eid):
        out = []
        for arena, rs in per[eid].items():
            out.extend(rs)
        return out

    rows = []
    for eid in per:
        entries = flatten(eid)
        if not entries:
            continue
        pnls = [p for _, p, _ in entries]
        trades_total = sum(t for _, _, t in entries)
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
            "trades": trades_total,
        })
    rows.sort(key=lambda r: -r["total"])
    for r in rows:
        print(f"{r['eid']:<28}{r['n']:>8}{r['total']:>+12.1f}{r['mean']:>+10.1f}"
              f"{r['median']:>+10.1f}{r['win_pct']:>7.0f}%{r['best']:>+10.1f}"
              f"{r['worst']:>+10.1f}{r['trades']:>10}")

    print()
    print("=" * 110)
    print("PER-ARENA BREAKDOWN (total / mean × rounds)")
    print("=" * 110)
    arenas_in_use = sorted({a for eid in per for a in per[eid]})
    hdr = f"{'engine':<28}"
    for arena in arenas_in_use:
        hdr += f"{arena:>22}"
    print(hdr)
    print("-" * (28 + 22 * len(arenas_in_use)))
    for r in rows:
        eid = r["eid"]
        row = f"{eid:<28}"
        for arena in arenas_in_use:
            pnls = [p for _, p, _ in per[eid].get(arena, [])]
            if not pnls:
                row += f"{'—':>22}"
            else:
                row += f" {sum(pnls):>+8.1f}/{mean(pnls):>+5.1f}×{len(pnls):<3}"
        print(row)


if __name__ == "__main__":
    main()
