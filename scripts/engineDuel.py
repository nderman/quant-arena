#!/usr/bin/env python3
"""Head-to-head comparison of two engines across rounds (multi-arena).

Designed to answer questions like: "After the pyramiding fix, does
dca-extreme-v1 close the gap with bred-4h85?" Computes per-round
delta for each arena where both engines traded, plus cumulative totals.

Usage:
  python3 scripts/engineDuel.py bred-4h85 dca-extreme-v1
  python3 scripts/engineDuel.py bred-4h85 dca-extreme-v1 --source vps
  python3 scripts/engineDuel.py bred-4h85 dca-extreme-v1 --rounds 5
  python3 scripts/engineDuel.py bred-4h85 dca-extreme-v1 --arena btc-1h
"""
import argparse
from collections import defaultdict

from _arena_history import iter_rounds


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("engine_a", help="first engine id (the benchmark)")
    ap.add_argument("engine_b", help="second engine id (the challenger)")
    ap.add_argument("--source", choices=["local", "vps", "backfill"], default="local")
    ap.add_argument("--rounds", type=int, default=0, help="last N rounds per arena")
    ap.add_argument("--arena", help="restrict to a single arena id (e.g. btc-1h)")
    args = ap.parse_args()

    a, b = args.engine_a, args.engine_b

    # arena -> [(round_id, regime, pnl_a, pnl_b)]
    per_arena = defaultdict(list)
    arena_rounds = defaultdict(list)
    for arena, rd in iter_rounds(args.source):
        if args.arena and arena != args.arena:
            continue
        arena_rounds[arena].append(rd)

    for arena, rounds in arena_rounds.items():
        if args.rounds > 0:
            rounds = rounds[-args.rounds:]
        for idx, entry in enumerate(rounds):
            round_id = entry.get("roundId", "")
            regime = entry.get("regime") or {}
            regime_label = regime.get("label", "?") if isinstance(regime, dict) else str(regime)
            results = {r.get("engineId"): r.get("totalPnl", 0) or 0
                       for r in entry.get("allResults", [])}
            pnl_a = results.get(a)
            pnl_b = results.get(b)
            if pnl_a is None or pnl_b is None:
                continue
            per_arena[arena].append((idx, round_id, regime_label, pnl_a, pnl_b))

    if not any(per_arena.values()):
        print(f"No rounds found where both {a} and {b} traded.")
        return

    print(f"\n{'='*100}")
    print(f"HEAD-TO-HEAD: {a} (A) vs {b} (B)")
    print(f"{'='*100}")

    grand_a = 0.0
    grand_b = 0.0
    for arena in sorted(per_arena.keys()):
        rounds = per_arena[arena]
        print(f"\n[{arena}] {len(rounds)} rounds where both engines traded")
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
        arena_delta = sum_b - sum_a
        print(f"  {'':>3} {'SUBTOTAL':<24} {'':<7} "
              f"{sum_a:>+10.1f} {sum_b:>+10.1f} {arena_delta:>+10.1f}")
        grand_a += sum_a
        grand_b += sum_b

    grand_delta = grand_b - grand_a
    print(f"\n{'='*100}")
    print("GRAND TOTAL")
    print(f"{'='*100}")
    print(f"  {a:<30} total: ${grand_a:>+10.1f}")
    print(f"  {b:<30} total: ${grand_b:>+10.1f}")
    print(f"  {'delta (B − A)':<30} total: ${grand_delta:>+10.1f}")

    if abs(grand_a) > 1:
        gap_pct = 100 * grand_delta / abs(grand_a)
        print(f"  {'B vs A ratio':<30} {gap_pct:>+10.1f}% "
              f"(negative = B lagging, positive = B ahead)")

    all_rounds = [r for arena in per_arena for r in per_arena[arena]]
    b_wins = sum(1 for _, _, _, pa, pb in all_rounds if pb > pa)
    a_wins = sum(1 for _, _, _, pa, pb in all_rounds if pa > pb)
    ties = sum(1 for _, _, _, pa, pb in all_rounds if pa == pb)
    total = len(all_rounds)
    if total > 0:
        print(f"\n  Head-to-head: {b} won {b_wins}/{total} ({100*b_wins/total:.0f}%), "
              f"{a} won {a_wins}/{total} ({100*a_wins/total:.0f}%), ties {ties}")
    print()


if __name__ == "__main__":
    main()
