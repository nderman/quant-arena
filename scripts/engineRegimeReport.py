#!/usr/bin/env python3
"""Per-engine per-regime performance report.

Reads the regime-tagged round_history_<coin>.json files and cross-tabulates
each engine's performance across regimes. Answers questions like:
  - Does dca-settle win in CHOP but not TREND?
  - Which engines thrive in SPIKE vs avoid it?
  - Per-coin specialization: does X only work on SOL?

Run tagRoundRegimes.py first to label rounds. This script is read-only.

Usage:
  python3 scripts/engineRegimeReport.py          # fetch from VPS
  python3 scripts/engineRegimeReport.py --local  # use local files
"""
import json, sys, subprocess
from collections import defaultdict

LOCAL = "--local" in sys.argv
VPS = "root@165.22.29.245"
REMOTE_DIR = "~/quant-arena/data"
LOCAL_DIR = "data"
COINS = ["btc", "eth", "sol"]


def load_history(coin):
    if LOCAL:
        import os
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
        print(f"  fetch error: {e}")
        return None


def main():
    # Collect: engine → coin → regime → list of pnls
    data = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    regime_counts = defaultdict(lambda: defaultdict(int))

    for coin in COINS:
        history = load_history(coin)
        if history is None:
            print(f"[{coin}] no history")
            continue

        tagged = 0
        for entry in history:
            regime = entry.get("regime")
            if not regime:
                continue
            label = regime["label"]
            regime_counts[coin][label] += 1
            tagged += 1

            for r in entry.get("allResults", []):
                engine_id = r.get("engineId")
                pnl = r.get("totalPnl", 0)
                if engine_id is None:
                    continue
                data[engine_id][coin][label].append(pnl)

        print(f"[{coin}] {tagged} tagged rounds, regime mix: " +
              " ".join(f"{k}={v}" for k, v in regime_counts[coin].items()))

    print()

    # Build a single table: engine × (coin, regime) with count / avg / total
    # Sort engines by total PnL across everything
    engine_totals = {}
    for engine_id, coin_data in data.items():
        total = 0
        for coin, regimes in coin_data.items():
            for regime, pnls in regimes.items():
                total += sum(pnls)
        engine_totals[engine_id] = total

    engines_sorted = sorted(engine_totals.keys(), key=lambda e: -engine_totals[e])

    # ── Big matrix ──
    print("=" * 100)
    print("ENGINE × REGIME PERFORMANCE (avg PnL per round × number of rounds)")
    print("=" * 100)

    # Header row: regime buckets
    regime_order = ["CHOP", "TREND", "SPIKE", "QUIET"]
    header = f"{'engine':<28}"
    for regime in regime_order:
        header += f"{regime:>16}"
    header += f"{'TOTAL':>12}"
    print(header)
    print("-" * 100)

    for engine_id in engines_sorted:
        row = f"{engine_id:<28}"
        for regime in regime_order:
            pnls = []
            for coin in COINS:
                pnls.extend(data[engine_id][coin].get(regime, []))
            n = len(pnls)
            if n == 0:
                row += f"{'—':>16}"
            else:
                avg = sum(pnls) / n
                row += f"{avg:>+7.1f}×{n:<3}  "
        row += f"{engine_totals[engine_id]:>+11.1f}"
        print(row)

    print()

    # ── Per-coin breakdown for the top engines ──
    print("=" * 100)
    print("TOP 8 ENGINES — PER-COIN PER-REGIME (avg × count)")
    print("=" * 100)

    top_engines = [e for e in engines_sorted[:8] if engine_totals[e] != 0]

    for engine_id in top_engines:
        print(f"\n{engine_id}  (total: ${engine_totals[engine_id]:+.1f})")
        print(f"  {'':>4} {'CHOP':>14} {'TREND':>14} {'SPIKE':>14} {'QUIET':>14}")
        for coin in COINS:
            row = f"  {coin:>4}"
            for regime in regime_order:
                pnls = data[engine_id][coin].get(regime, [])
                if not pnls:
                    row += f"{'—':>14}"
                else:
                    avg = sum(pnls) / len(pnls)
                    row += f"{avg:>+7.1f}×{len(pnls):<3}  "
            print(row)

    # ── Winners per regime ──
    print()
    print("=" * 100)
    print("REGIME SPECIALISTS — top 3 engines by avg PnL per round, min 3 rounds")
    print("=" * 100)

    for regime in regime_order:
        scored = []
        for engine_id in data:
            pnls = []
            for coin in COINS:
                pnls.extend(data[engine_id][coin].get(regime, []))
            if len(pnls) < 3:
                continue
            avg = sum(pnls) / len(pnls)
            scored.append((engine_id, avg, len(pnls), sum(pnls)))
        scored.sort(key=lambda x: -x[1])
        print(f"\n  {regime}:")
        for engine_id, avg, n, total in scored[:5]:
            print(f"    {engine_id:<28} avg ${avg:>+7.1f}  n={n:<3}  total ${total:>+8.1f}")

    # ── Per-coin specialists ──
    print()
    print("=" * 100)
    print("PER-COIN SPECIALISTS — top 3 by total PnL per coin (all regimes)")
    print("=" * 100)

    for coin in COINS:
        scored = []
        for engine_id in data:
            regimes = data[engine_id].get(coin, {})
            total = sum(sum(pnls) for pnls in regimes.values())
            n = sum(len(pnls) for pnls in regimes.values())
            if n == 0:
                continue
            scored.append((engine_id, total, n))
        scored.sort(key=lambda x: -x[1])
        print(f"\n  {coin.upper()}:")
        for engine_id, total, n in scored[:5]:
            print(f"    {engine_id:<28} total ${total:>+8.1f}  n={n:<3}")

    print()


if __name__ == "__main__":
    main()
