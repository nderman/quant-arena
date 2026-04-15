#!/usr/bin/env python3
"""Head-to-head comparison of two engines across rounds.

Designed to answer questions like: "After the pyramiding fix, does
dca-extreme-v1 close the gap with bred-4h85?" Computes per-round
delta for each coin where both engines traded, plus cumulative totals.

Usage:
  python3 scripts/engineDuel.py bred-4h85 dca-extreme-v1
  python3 scripts/engineDuel.py bred-4h85 dca-extreme-v1 --local
  python3 scripts/engineDuel.py bred-4h85 dca-extreme-v1 --rounds 5

Output: per-round table with PnL for each engine + delta, per-coin
subtotals, and a one-line verdict for the head-to-head.
"""
import json, sys, os, subprocess, argparse
from collections import defaultdict

VPS = "root@165.22.29.245"
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
    ap.add_argument("engine_a", help="first engine id (the benchmark)")
    ap.add_argument("engine_b", help="second engine id (the challenger)")
    ap.add_argument("--local", action="store_true")
    ap.add_argument("--rounds", type=int, default=0, help="last N rounds per coin")
    args = ap.parse_args()

    a, b = args.engine_a, args.engine_b

    # coin -> list of (round_idx, round_id, regime, pnl_a, pnl_b)
    per_coin = defaultdict(list)

    for coin in COINS:
        history = load_history(coin, args.local)
        if history is None:
            continue
        if args.rounds > 0:
            history = history[-args.rounds:]

        for idx, entry in enumerate(history):
            round_id = entry.get("roundId", "")
            regime_label = entry.get("regime", {}).get("label", "?")
            results = {r.get("engineId"): r.get("totalPnl", 0) or 0
                       for r in entry.get("allResults", [])}
            pnl_a = results.get(a)
            pnl_b = results.get(b)
            if pnl_a is None or pnl_b is None:
                continue
            per_coin[coin].append((idx, round_id, regime_label, pnl_a, pnl_b))

    if not any(per_coin.values()):
        print(f"No rounds found where both {a} and {b} traded.")
        return

    # ── Per-round table ──
    print(f"\n{'='*100}")
    print(f"HEAD-TO-HEAD: {a} (A) vs {b} (B)")
    print(f"{'='*100}")

    grand_a = 0.0
    grand_b = 0.0
    for coin in COINS:
        rounds = per_coin.get(coin, [])
        if not rounds:
            continue
        print(f"\n[{coin.upper()}] {len(rounds)} rounds where both engines traded")
        print(f"  {'#':>3} {'round_id':<24} {'regime':<7} {'A pnl':>10} {'B pnl':>10} {'delta':>10}")
        print(f"  {'-'*3} {'-'*24} {'-'*7} {'-'*10} {'-'*10} {'-'*10}")
        sum_a = 0.0
        sum_b = 0.0
        for idx, rid, regime, pa, pb in rounds:
            delta = pb - pa
            sum_a += pa
            sum_b += pb
            rid_short = rid[:24] if rid else "—"
            print(f"  {idx:>3} {rid_short:<24} {regime:<7} "
                  f"{pa:>+10.1f} {pb:>+10.1f} {delta:>+10.1f}")
        coin_delta = sum_b - sum_a
        print(f"  {'':>3} {'SUBTOTAL':<24} {'':<7} "
              f"{sum_a:>+10.1f} {sum_b:>+10.1f} {coin_delta:>+10.1f}")
        grand_a += sum_a
        grand_b += sum_b

    # ── Verdict ──
    grand_delta = grand_b - grand_a
    print(f"\n{'='*100}")
    print("GRAND TOTAL")
    print(f"{'='*100}")
    print(f"  {a:<30} total: ${grand_a:>+10.1f}")
    print(f"  {b:<30} total: ${grand_b:>+10.1f}")
    print(f"  {'delta (B − A)':<30} total: ${grand_delta:>+10.1f}")

    # Derive the gap ratio for interpretation
    if abs(grand_a) > 1:
        gap_pct = 100 * grand_delta / abs(grand_a)
        print(f"  {'B vs A ratio':<30} {gap_pct:>+10.1f}% "
              f"(negative = B lagging, positive = B ahead)")

    # Head-to-head per-round: how often did B beat A?
    all_rounds = [(coin, r) for coin in COINS for r in per_coin.get(coin, [])]
    b_wins = sum(1 for _, (_, _, _, pa, pb) in all_rounds if pb > pa)
    a_wins = sum(1 for _, (_, _, _, pa, pb) in all_rounds if pa > pb)
    ties = sum(1 for _, (_, _, _, pa, pb) in all_rounds if pa == pb)
    total = len(all_rounds)
    if total > 0:
        print(f"\n  Head-to-head: {b} won {b_wins}/{total} ({100*b_wins/total:.0f}%), "
              f"{a} won {a_wins}/{total} ({100*a_wins/total:.0f}%), ties {ties}")
    print()


if __name__ == "__main__":
    main()
