#!/usr/bin/env python3
"""Backtest a proposed regime gate against an engine's historical trades.

Answers the question: "If we'd had this gate yesterday, would it have
blocked wins or losses?" The Apr 15 lesson from the polymarket-ai-bot
side (shipping WEATHER_MAX_CONFIDENCE=0.75 that would've blocked 92%
of weather profit retroactively) is that every gate needs this replay
before it ships. For Quant Farm the analog is any dca-* engine that
adds a currentRegimeStable() or momentum filter.

Current implementation uses ROUND-level regime tags (CHOP/TREND/SPIKE)
from round_history files as the gate proxy. That's coarse — a round
labeled TREND overall can have CHOP subperiods and vice versa — but
it's the best signal we have without re-fetching Binance at every
trade timestamp.

Usage:
  python3 scripts/gateBacktest.py --engine dca-settle-v1 --allow TREND,SPIKE
  python3 scripts/gateBacktest.py --engine dca-extreme-v1 --allow TREND --rounds 10
  python3 scripts/gateBacktest.py --engine dca-settle-v1 --allow TREND,SPIKE --verbose
"""
import json, sys, os, subprocess, argparse
from collections import defaultdict

VPS = os.environ.get("QUANT_VPS_HOST", "root@vps.example.com")
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
    ap.add_argument("--engine", required=True, help="engine id to backtest")
    ap.add_argument("--allow", required=True,
                    help="comma-separated list of allowed regime labels (e.g. TREND,SPIKE)")
    ap.add_argument("--local", action="store_true")
    ap.add_argument("--rounds", type=int, default=0, help="last N rounds per coin")
    ap.add_argument("--verbose", action="store_true", help="show every round")
    args = ap.parse_args()

    allow = set(s.strip().upper() for s in args.allow.split(",") if s.strip())
    print(f"\nGate replay: {args.engine}")
    print(f"Allowed regimes: {', '.join(sorted(allow))}")

    # coin -> list of (round_id, regime, pnl, trade_count)
    per_coin = defaultdict(list)
    unknown_regime_rounds = 0

    for coin in COINS:
        history = load_history(coin, args.local)
        if history is None:
            continue
        if args.rounds > 0:
            history = history[-args.rounds:]

        for entry in history:
            regime_info = entry.get("regime")
            if not regime_info:
                unknown_regime_rounds += 1
                continue
            regime = regime_info.get("label", "UNKNOWN").upper()
            round_id = entry.get("roundId", "?")
            for r in entry.get("allResults", []):
                if r.get("engineId") != args.engine:
                    continue
                pnl = r.get("totalPnl", 0) or 0
                trades = r.get("tradeCount", 0) or 0
                per_coin[coin].append((round_id, regime, pnl, trades))

    if unknown_regime_rounds > 0:
        print(f"(skipped {unknown_regime_rounds} rounds without regime tags — "
              f"run scripts/tagRoundRegimes.py first for full coverage)")

    if not any(per_coin.values()):
        print(f"\nNo rounds found for engine '{args.engine}'.")
        return

    print()
    print("=" * 100)
    print("BEFORE / AFTER PER-COIN")
    print("=" * 100)
    print(f"{'coin':<6}{'rounds':>8}{'allowed':>10}{'blocked':>10}"
          f"{'actual_pnl':>14}{'kept_pnl':>14}{'blocked_pnl':>14}{'delta':>12}")
    print("-" * 100)

    grand_actual = 0.0
    grand_kept = 0.0
    grand_blocked = 0.0
    regime_mix = defaultdict(lambda: defaultdict(int))

    for coin in COINS:
        rounds = per_coin.get(coin, [])
        if not rounds:
            continue
        actual = sum(pnl for _, _, pnl, _ in rounds)
        kept = sum(pnl for _, regime, pnl, _ in rounds if regime in allow)
        blocked = actual - kept
        allowed_n = sum(1 for _, regime, _, _ in rounds if regime in allow)
        blocked_n = len(rounds) - allowed_n
        for _, regime, _, _ in rounds:
            regime_mix[coin][regime] += 1

        print(f"{coin:<6}{len(rounds):>8}{allowed_n:>10}{blocked_n:>10}"
              f"{actual:>+14.1f}{kept:>+14.1f}{blocked:>+14.1f}"
              f"{(kept - actual):>+12.1f}")
        grand_actual += actual
        grand_kept += kept
        grand_blocked += blocked

    print("-" * 100)
    print(f"{'TOTAL':<6}{'':<28}{grand_actual:>+14.1f}{grand_kept:>+14.1f}"
          f"{grand_blocked:>+14.1f}{(grand_kept - grand_actual):>+12.1f}")

    # ── Interpretation ──
    print()
    if grand_actual != 0:
        delta_pct = 100 * (grand_kept - grand_actual) / abs(grand_actual)
    else:
        delta_pct = 0

    if grand_kept > grand_actual:
        verdict = "✓ GATE IS POSITIVE — would have improved PnL by ${:+.0f} ({:+.1f}%)".format(
            grand_kept - grand_actual, delta_pct)
    elif grand_kept < grand_actual:
        verdict = "✗ GATE IS NEGATIVE — would have reduced PnL by ${:+.0f} ({:+.1f}%)".format(
            grand_kept - grand_actual, delta_pct)
    else:
        verdict = "= GATE IS NEUTRAL — no PnL impact"

    print(verdict)
    print()
    print(f"  Actual PnL (no gate):     ${grand_actual:>+10.1f}")
    print(f"  Kept PnL (gate active):   ${grand_kept:>+10.1f}  ← what you'd keep")
    print(f"  Blocked PnL:              ${grand_blocked:>+10.1f}  ← what you'd skip")
    print()

    # Regime mix — so we can see if the gate is blocking many profitable rounds
    print("Regime mix per coin:")
    for coin in COINS:
        mix = regime_mix.get(coin, {})
        if not mix:
            continue
        parts = [f"{k}={v}" for k, v in sorted(mix.items())]
        print(f"  {coin}: {' '.join(parts)}")

    # ── Verbose: per-round detail ──
    if args.verbose:
        print()
        print("=" * 100)
        print("PER-ROUND DETAIL")
        print("=" * 100)
        for coin in COINS:
            rounds = per_coin.get(coin, [])
            if not rounds:
                continue
            print(f"\n[{coin.upper()}]")
            print(f"  {'round_id':<24} {'regime':<7} {'pnl':>10} {'trades':>8} {'gate'}")
            for rid, regime, pnl, trades in rounds:
                gate = "KEEP" if regime in allow else "BLOCK"
                rid_short = rid[:24]
                print(f"  {rid_short:<24} {regime:<7} {pnl:>+10.1f} {trades:>8} {gate}")

    # ── Safety warning ──
    print()
    print("⚠ This is a coarse replay using round-level regime tags. A round")
    print("  labeled TREND can have CHOP subperiods (and vice versa), so the")
    print("  runtime gate might not see exactly the label the tagger computed.")
    print("  Use this as a sanity check, not as a precise counterfactual.")


if __name__ == "__main__":
    main()
