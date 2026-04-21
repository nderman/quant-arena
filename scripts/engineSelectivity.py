#!/usr/bin/env python3
"""Per-firing-round PnL — the metric that captures selectivity.

The "silent engines are good engines" principle (Apr 14 memory): an engine
that fires only when conditions favor its edge is more valuable than one
that trades constantly. Standard mean-PnL-per-round penalizes selective
engines because their many silent rounds drag the average toward 0.

This script computes:
  - firing rounds: rounds where tradeCount > 0
  - silence rate: % of rounds where the engine did nothing
  - mean PnL **per firing round** (excludes silent rounds)
  - firing win rate: % of firing rounds with positive PnL
  - total PnL across all firing rounds

A good selective engine looks like: high silence, high mean-per-firing,
high firing win rate. dca-settle-v1 is the anti-pattern: ~0% silence,
modest mean, low win rate.

Usage:
  python3 scripts/engineSelectivity.py                # VPS fetch
  python3 scripts/engineSelectivity.py --local        # ./data instead
  python3 scripts/engineSelectivity.py --rounds 20    # only last N
  python3 scripts/engineSelectivity.py --min-firing 3 # skip engines with < N firings
"""
import json, sys, os, subprocess, argparse
from collections import defaultdict
from statistics import mean

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
    ap.add_argument("--local", action="store_true")
    ap.add_argument("--rounds", type=int, default=0, help="last N rounds per coin")
    ap.add_argument("--min-firing", type=int, default=2, help="skip engines with < N firing rounds")
    ap.add_argument("--prefix", help="filter engines by id prefix")
    args = ap.parse_args()

    # engine -> list of (coin, totalPnl, tradeCount, isFiring)
    per_engine: dict[str, list[tuple[str, float, int, bool]]] = defaultdict(list)
    rounds_seen = {c: 0 for c in COINS}

    for coin in COINS:
        history = load_history(coin, args.local)
        if history is None:
            continue
        if args.rounds > 0:
            history = history[-args.rounds:]
        rounds_seen[coin] = len(history)

        for entry in history:
            for r in entry.get("allResults", []):
                eid = r.get("engineId")
                if eid is None:
                    continue
                if args.prefix and not eid.startswith(args.prefix):
                    continue
                pnl = r.get("totalPnl", 0) or 0
                trades = r.get("tradeCount", 0) or 0
                per_engine[eid].append((coin, pnl, trades, trades > 0))

    if not per_engine:
        print("No matching engines.")
        return

    coin_hdr = " ".join(f"{c}={rounds_seen[c]}" for c in COINS)
    print(f"Rounds per coin: {coin_hdr}")
    print()

    # Build the selectivity table
    rows = []
    for eid, entries in per_engine.items():
        total_rounds = len(entries)
        firing = [(c, p, t) for c, p, t, f in entries if f]
        n_firing = len(firing)
        if n_firing < args.min_firing:
            continue

        firing_pnls = [p for _, p, _ in firing]
        firing_trades = sum(t for _, _, t in firing)
        wins = sum(1 for p in firing_pnls if p > 0)

        rows.append({
            "eid": eid,
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

    # Sort by mean-per-firing descending — the headline metric
    rows.sort(key=lambda r: -r["mean_per_firing"])

    print("=" * 130)
    print("SELECTIVITY-AWARE LEADERBOARD")
    print("Sorted by mean PnL per firing round. Silence% = rounds where engine didn't trade.")
    print("=" * 130)
    print(f"{'engine':<28}{'rounds':>8}{'firing':>8}{'silence%':>10}"
          f"{'mean/fire':>12}{'win%/fire':>12}{'trades/fire':>12}"
          f"{'total':>10}{'best':>10}{'worst':>10}")
    print("-" * 130)

    for r in rows:
        print(f"{r['eid']:<28}{r['total_rounds']:>8}{r['n_firing']:>8}"
              f"{r['silence_pct']:>9.0f}%"
              f"{r['mean_per_firing']:>+12.2f}"
              f"{r['firing_win_pct']:>11.0f}%"
              f"{r['trades_per_firing']:>12.1f}"
              f"{r['total_pnl']:>+10.1f}"
              f"{r['best']:>+10.1f}"
              f"{r['worst']:>+10.1f}")

    # ── Highlight the patterns ──
    print()
    print("=" * 130)
    print("THE TWO ENDS OF THE SELECTIVITY SPECTRUM")
    print("=" * 130)

    # Most selective AND statistically meaningful (silence ≥ 50%, n_firing ≥ 10)
    # Without the n_firing floor, a 2-sample lucky engine looks like alpha.
    # bred-gki8 (Apr 14): 2 firings, 1 win 1 loss → +$72/fire mean is noise.
    selective = sorted(
        [r for r in rows if r["silence_pct"] >= 50 and r["n_firing"] >= 10],
        key=lambda r: -r["mean_per_firing"]
    )[:5]
    if selective:
        print("\nMost selective AND profitable (silence ≥ 50%, n_firing ≥ 10):")
        for r in selective:
            print(f"  {r['eid']:<28} silence {r['silence_pct']:.0f}%  "
                  f"mean/fire ${r['mean_per_firing']:+.2f}  "
                  f"win% {r['firing_win_pct']:.0f}  total ${r['total_pnl']:+.0f}")
    else:
        print("\nNo selective engines yet (need silence ≥ 50% AND n_firing ≥ 10)")

    # Also flag tiny-sample standouts as suspicious-not-alpha
    tiny_high = [r for r in rows if r["n_firing"] < 10 and r["mean_per_firing"] > 20]
    if tiny_high:
        print("\nTiny-sample standouts (n<10, mean/fire > +$20) — likely noise, NOT alpha:")
        for r in tiny_high:
            print(f"  {r['eid']:<28} n_firing={r['n_firing']:<3} "
                  f"mean/fire ${r['mean_per_firing']:+.2f}  "
                  f"best ${r['best']:+.0f}  worst ${r['worst']:+.0f}")

    # Anti-pattern: trades constantly, loses
    constant_losers = sorted(
        [r for r in rows if r["silence_pct"] < 20 and r["mean_per_firing"] < 0],
        key=lambda r: r["mean_per_firing"]
    )[:5]
    if constant_losers:
        print("\nAnti-pattern (silence < 20%, mean/fire < 0):")
        for r in constant_losers:
            print(f"  {r['eid']:<28} silence {r['silence_pct']:.0f}%  "
                  f"mean/fire ${r['mean_per_firing']:+.2f}  "
                  f"trades/fire {r['trades_per_firing']:.0f}  total ${r['total_pnl']:+.0f}")

    print()


if __name__ == "__main__":
    main()
