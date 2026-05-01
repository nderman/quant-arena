#!/usr/bin/env python3
"""Per-firing-round PnL — the metric that captures selectivity.

The "silent engines are good engines" principle (Apr 14 memory): an engine
that fires only when conditions favor its edge is more valuable than one
that trades constantly. Standard mean-PnL-per-round penalizes selective
engines because their many silent rounds drag the average toward 0.

Computed per (engine, arena):
  - firing rounds: rounds where tradeCount > 0
  - silence rate: % of rounds where the engine did nothing
  - mean PnL **per firing round** (excludes silent rounds)
  - firing win rate: % of firing rounds with positive PnL
  - total PnL across all firing rounds

A good selective engine looks like: high silence, high mean-per-firing,
high firing win rate. dca-settle-v1 is the anti-pattern: ~0% silence,
modest mean, low win rate.

Usage:
  python3 scripts/engineSelectivity.py                # local (./data) — works on VPS
  python3 scripts/engineSelectivity.py --source vps   # SSH to VPS
  python3 scripts/engineSelectivity.py --rounds 20    # only last N rounds per arena
  python3 scripts/engineSelectivity.py --min-firing 3 # skip engines with < N firings
  python3 scripts/engineSelectivity.py --prefix bred- # filter by engine id prefix
  python3 scripts/engineSelectivity.py --by-engine    # collapse arenas (legacy view)
"""
import argparse
from collections import defaultdict
from statistics import mean

from _arena_history import iter_rounds


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["local", "vps", "backfill"], default="local")
    ap.add_argument("--rounds", type=int, default=0, help="last N rounds per arena")
    ap.add_argument("--min-firing", type=int, default=2, help="skip rows with < N firing rounds")
    ap.add_argument("--prefix", help="filter engines by id prefix")
    ap.add_argument("--by-engine", action="store_true",
                    help="collapse arenas — one row per engine across all arenas")
    args = ap.parse_args()

    # key -> [(pnl, trades), ...]
    per_key: dict[tuple, list[tuple[float, int]]] = defaultdict(list)
    rounds_per_arena: dict[str, int] = defaultdict(int)

    # Group rounds by arena first so --rounds can take last N per arena.
    arena_rounds: dict[str, list] = defaultdict(list)
    for arena, rd in iter_rounds(args.source):
        arena_rounds[arena].append(rd)

    for arena, rounds in arena_rounds.items():
        if args.rounds > 0:
            rounds = rounds[-args.rounds:]
        rounds_per_arena[arena] = len(rounds)
        for rd in rounds:
            for r in rd.get("allResults", []):
                eid = r.get("engineId")
                if not eid:
                    continue
                if args.prefix and not eid.startswith(args.prefix):
                    continue
                pnl = r.get("totalPnl", 0) or 0
                trades = r.get("tradeCount", 0) or 0
                key = eid if args.by_engine else (eid, arena)
                per_key[key].append((pnl, trades))

    if not per_key:
        print("No matching engines.")
        return

    print("Rounds per arena: " + " ".join(f"{a}={n}" for a, n in sorted(rounds_per_arena.items())))
    print()

    rows = []
    for key, entries in per_key.items():
        total_rounds = len(entries)
        firing = [(p, t) for p, t in entries if t > 0]
        n_firing = len(firing)
        if n_firing < args.min_firing:
            continue
        firing_pnls = [p for p, _ in firing]
        firing_trades = sum(t for _, t in firing)
        wins = sum(1 for p in firing_pnls if p > 0)
        if isinstance(key, tuple):
            label = f"{key[0]} @ {key[1]}"
        else:
            label = key
        rows.append({
            "label": label,
            "total_rounds": total_rounds,
            "n_firing": n_firing,
            "silence_pct": 100 * (total_rounds - n_firing) / total_rounds if total_rounds else 0,
            "mean_per_firing": mean(firing_pnls),
            "firing_win_pct": 100 * wins / n_firing if n_firing else 0,
            "total_pnl": sum(firing_pnls),
            "trades_per_firing": firing_trades / n_firing if n_firing else 0,
            "best": max(firing_pnls),
            "worst": min(firing_pnls),
        })

    rows.sort(key=lambda r: -r["mean_per_firing"])

    print("=" * 145)
    print("SELECTIVITY-AWARE LEADERBOARD")
    print("Sorted by mean PnL per firing round. Silence% = rounds where engine didn't trade.")
    print("=" * 145)
    print(f"{'engine @ arena':<48}{'rounds':>8}{'firing':>8}{'silence%':>10}"
          f"{'mean/fire':>12}{'win%/fire':>12}{'trades/fire':>13}"
          f"{'total':>10}{'best':>10}{'worst':>10}")
    print("-" * 145)
    for r in rows:
        print(f"{r['label']:<48}{r['total_rounds']:>8}{r['n_firing']:>8}"
              f"{r['silence_pct']:>9.0f}%"
              f"{r['mean_per_firing']:>+12.2f}"
              f"{r['firing_win_pct']:>11.0f}%"
              f"{r['trades_per_firing']:>13.1f}"
              f"{r['total_pnl']:>+10.1f}"
              f"{r['best']:>+10.1f}"
              f"{r['worst']:>+10.1f}")

    print()
    print("=" * 145)
    print("PATTERNS")
    print("=" * 145)

    # Most selective AND statistically meaningful (silence ≥ 50%, n_firing ≥ 10).
    # Without the n_firing floor, a 2-sample lucky engine looks like alpha.
    selective = sorted(
        [r for r in rows if r["silence_pct"] >= 50 and r["n_firing"] >= 10],
        key=lambda r: -r["mean_per_firing"]
    )[:8]
    if selective:
        print("\nMost selective AND profitable (silence ≥ 50%, n_firing ≥ 10):")
        for r in selective:
            print(f"  {r['label']:<48} silence {r['silence_pct']:.0f}%  "
                  f"mean/fire ${r['mean_per_firing']:+.2f}  "
                  f"win% {r['firing_win_pct']:.0f}  total ${r['total_pnl']:+.0f}")

    tiny_high = [r for r in rows if r["n_firing"] < 10 and r["mean_per_firing"] > 20]
    if tiny_high:
        print("\nTiny-sample standouts (n<10, mean/fire > +$20) — likely noise, NOT alpha:")
        for r in tiny_high:
            print(f"  {r['label']:<48} n_firing={r['n_firing']:<3} "
                  f"mean/fire ${r['mean_per_firing']:+.2f}  "
                  f"best ${r['best']:+.0f}  worst ${r['worst']:+.0f}")

    constant_losers = sorted(
        [r for r in rows if r["silence_pct"] < 20 and r["mean_per_firing"] < 0],
        key=lambda r: r["mean_per_firing"]
    )[:5]
    if constant_losers:
        print("\nAnti-pattern (silence < 20%, mean/fire < 0):")
        for r in constant_losers:
            print(f"  {r['label']:<48} silence {r['silence_pct']:.0f}%  "
                  f"mean/fire ${r['mean_per_firing']:+.2f}  "
                  f"trades/fire {r['trades_per_firing']:.0f}  total ${r['total_pnl']:+.0f}")

    print()


if __name__ == "__main__":
    main()
