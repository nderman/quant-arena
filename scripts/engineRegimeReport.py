#!/usr/bin/env python3
"""Per-engine per-regime performance report (multi-arena).

Reads the regime-tagged round_history_<arena>.json files and cross-tabulates
each engine's performance across regimes. Answers questions like:
  - Does dca-settle win in CHOP but not TREND?
  - Which engines thrive in SPIKE vs avoid it?
  - Per-arena specialization: does X only work on sol-4h?

Run tagRoundRegimes.py first to label rounds. This script is read-only.

Usage:
  python3 scripts/engineRegimeReport.py                # local (./data) — works on VPS
  python3 scripts/engineRegimeReport.py --source vps   # SSH to VPS
"""
import argparse
from collections import defaultdict

from _arena_history import iter_rounds, parse_arena_id


REGIME_ORDER = ["CHOP", "TREND", "SPIKE", "QUIET"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["local", "vps", "backfill"], default="local")
    args = ap.parse_args()

    # engine -> arena -> regime -> [pnls]
    data = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    regime_counts = defaultdict(lambda: defaultdict(int))
    arenas_seen = set()

    for arena, rd in iter_rounds(args.source):
        regime = rd.get("regime")
        if not regime:
            continue
        label = regime["label"] if isinstance(regime, dict) else regime
        regime_counts[arena][label] += 1
        arenas_seen.add(arena)

        for r in rd.get("allResults", []):
            engine_id = r.get("engineId")
            if engine_id is None:
                continue
            pnl = r.get("totalPnl", 0)
            data[engine_id][arena][label].append(pnl)

    if not data:
        print("No tagged rounds found. Run tagRoundRegimes.py first.")
        return

    for arena in sorted(arenas_seen):
        counts = regime_counts[arena]
        tagged = sum(counts.values())
        print(f"[{arena}] {tagged} tagged rounds: " +
              " ".join(f"{k}={v}" for k, v in counts.items()))
    print()

    # Engine totals across all arenas + regimes
    engine_totals = {}
    for engine_id, arena_data in data.items():
        total = 0
        for arena, regimes in arena_data.items():
            for regime, pnls in regimes.items():
                total += sum(pnls)
        engine_totals[engine_id] = total

    engines_sorted = sorted(engine_totals.keys(), key=lambda e: -engine_totals[e])

    print("=" * 100)
    print("ENGINE × REGIME PERFORMANCE (avg PnL per round × number of rounds, ALL ARENAS)")
    print("=" * 100)
    header = f"{'engine':<28}"
    for regime in REGIME_ORDER:
        header += f"{regime:>16}"
    header += f"{'TOTAL':>12}"
    print(header)
    print("-" * 100)

    for engine_id in engines_sorted:
        row = f"{engine_id:<28}"
        for regime in REGIME_ORDER:
            pnls = []
            for arena, regimes in data[engine_id].items():
                pnls.extend(regimes.get(regime, []))
            n = len(pnls)
            if n == 0:
                row += f"{'—':>16}"
            else:
                avg = sum(pnls) / n
                row += f"{avg:>+7.1f}×{n:<3}  "
        row += f"{engine_totals[engine_id]:>+11.1f}"
        print(row)

    print()
    print("=" * 100)
    print("TOP 8 ENGINES — PER-ARENA PER-REGIME (avg × count)")
    print("=" * 100)

    top_engines = [e for e in engines_sorted[:8] if engine_totals[e] != 0]
    for engine_id in top_engines:
        print(f"\n{engine_id}  (total: ${engine_totals[engine_id]:+.1f})")
        print(f"  {'arena':<10} {'CHOP':>14} {'TREND':>14} {'SPIKE':>14} {'QUIET':>14}")
        # Per-arena rows, sorted by arena id for stable output
        arena_rows = []
        for arena, regimes in data[engine_id].items():
            arena_rows.append((arena, regimes))
        arena_rows.sort(key=lambda x: x[0])
        for arena, regimes in arena_rows:
            row = f"  {arena:<10}"
            for regime in REGIME_ORDER:
                pnls = regimes.get(regime, [])
                if not pnls:
                    row += f"{'—':>14}"
                else:
                    avg = sum(pnls) / len(pnls)
                    row += f"{avg:>+7.1f}×{len(pnls):<3}  "
            print(row)

    print()
    print("=" * 100)
    print("REGIME SPECIALISTS — top 5 (engine, arena) pairs by avg PnL per round, min 3 rounds")
    print("=" * 100)

    for regime in REGIME_ORDER:
        scored = []
        for engine_id, arena_data in data.items():
            for arena, regimes in arena_data.items():
                pnls = regimes.get(regime, [])
                if len(pnls) < 3:
                    continue
                avg = sum(pnls) / len(pnls)
                scored.append((engine_id, arena, avg, len(pnls), sum(pnls)))
        scored.sort(key=lambda x: -x[2])
        print(f"\n  {regime}:")
        for engine_id, arena, avg, n, total in scored[:5]:
            label = f"{engine_id} @ {arena}"
            print(f"    {label:<48} avg ${avg:>+7.1f}  n={n:<3}  total ${total:>+8.1f}")

    print()
    print("=" * 100)
    print("PER-ARENA SPECIALISTS — top 5 engines by total PnL per arena (all regimes)")
    print("=" * 100)

    for arena in sorted(arenas_seen):
        scored = []
        for engine_id, arena_data in data.items():
            regimes = arena_data.get(arena, {})
            total = sum(sum(pnls) for pnls in regimes.values())
            n = sum(len(pnls) for pnls in regimes.values())
            if n == 0:
                continue
            scored.append((engine_id, total, n))
        scored.sort(key=lambda x: -x[1])
        print(f"\n  {arena}:")
        for engine_id, total, n in scored[:5]:
            print(f"    {engine_id:<28} total ${total:>+8.1f}  n={n:<3}")

    print()


if __name__ == "__main__":
    main()
