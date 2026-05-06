#!/usr/bin/env python3
"""DEPRECATED — use scripts/crossArenaAnalysis.py instead.

The SAFE candidates table in crossArenaAnalysis covers everything this script
did, with proper multi-arena support (this script only sees base 5min coins).

Kept for reference but not maintained.

Original purpose: identify (engine, arena) pairs that meet graduation bar
(min rounds fired, net positive, bounded worst loss).
"""
import json, sys, os, subprocess, argparse
from collections import defaultdict
from statistics import mean

VPS = os.environ.get("QUANT_VPS_HOST", "root@vps.example.com")
REMOTE_DIR = "~/quant-arena/data"
LOCAL_DIR = "data"
COINS = ["btc", "eth", "sol"]

MIN_ROUNDS = 5           # must fire in at least this many rounds
MIN_WR = 0.30            # alternative: ≥30% WR if payoff is asymmetric
MAX_LOSS_MULT = 2.5      # worst round ≤ 2.5× avg loss
MIN_PNL_TOTAL = 10       # must be +$10 total over firing rounds


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--local", action="store_true")
    return p.parse_args()


def load_history(coin, local):
    if local:
        path = os.path.join(LOCAL_DIR, f"round_history_{coin}.json")
        if not os.path.exists(path):
            return None
        with open(path) as f:
            return json.load(f)
    try:
        r = subprocess.run(
            ["ssh", VPS, f"cat {REMOTE_DIR}/round_history_{coin}.json"],
            capture_output=True, text=True, timeout=30,
        )
        return json.loads(r.stdout) if r.returncode == 0 else None
    except Exception:
        return None


def main():
    args = parse_args()

    # (engine, coin) -> list of (pnl, regime_label, regime_hist)
    by_pair = defaultdict(list)

    for coin in COINS:
        rounds = load_history(coin, args.local)
        if not rounds:
            continue
        for r in rounds:
            regime_field = r.get("regime") or {}
            label = regime_field.get("label", "UNKNOWN")
            hist = regime_field.get("bucketHistogram", {})
            for e in r.get("allResults", []):
                eid = e.get("engineId") or e.get("id")
                pnl = e.get("totalPnl", 0)
                if eid and pnl != 0:
                    by_pair[(eid, coin)].append((pnl, label, hist))

    print("# Graduation Candidate Report")
    print()
    print(f"Thresholds: ≥{MIN_ROUNDS} firing rounds, net > ${MIN_PNL_TOTAL}, worst_loss ≤ {MAX_LOSS_MULT}× avg_loss")
    print()
    print("## Passing candidates")
    print()
    print("| Engine | Coin | Rounds | Net PnL | WR | Avg Win | Avg Loss | Worst | Regimes seen |")
    print("|--------|------|--------|---------|-----|---------|----------|-------|--------------|")

    passers = []
    failers = []

    for (eid, coin), records in sorted(by_pair.items(), key=lambda x: -sum(p for p, _, _ in x[1])):
        pnls = [r[0] for r in records]
        regimes = [r[1] for r in records]
        n = len(pnls)
        if n < MIN_ROUNDS:
            continue
        total = sum(pnls)
        wins = [p for p in pnls if p > 0]
        losses = [p for p in pnls if p < 0]
        wr = len(wins) / n
        avg_win = mean(wins) if wins else 0
        avg_loss = mean(losses) if losses else 0
        worst = min(pnls)

        regime_counts = defaultdict(int)
        for reg in regimes:
            regime_counts[reg] += 1

        # Pass criteria
        pnl_ok = total >= MIN_PNL_TOTAL
        wr_ok = wr >= MIN_WR
        ev_ok = (avg_win > 0 and abs(avg_loss) < avg_win * 3) or wr >= 0.5
        blowup_ok = avg_loss == 0 or worst > MAX_LOSS_MULT * avg_loss

        passes = pnl_ok and (wr_ok or ev_ok) and blowup_ok

        regime_str = ",".join(f"{r}×{c}" for r, c in sorted(regime_counts.items(), key=lambda x: -x[1]))
        row = (eid, coin, n, total, wr * 100, avg_win, avg_loss, worst, regime_str, passes,
               pnl_ok, wr_ok or ev_ok, blowup_ok)
        if passes:
            passers.append(row)
            print(f"| {eid} | {coin} | {n} | ${total:+.0f} | {wr*100:.0f}% | ${avg_win:+.2f} | ${avg_loss:.2f} | ${worst:.0f} | {regime_str} |")
        else:
            failers.append(row)

    if not passers:
        print("| _none yet_ | | | | | | | | |")
    print()

    print("## Near-misses (fired enough but failed one criterion)")
    print()
    print("| Engine | Coin | Rounds | Net PnL | WR | Worst | Reason |")
    print("|--------|------|--------|---------|-----|-------|--------|")
    for row in failers[:15]:
        eid, coin, n, total, wr, aw, al, worst, reg, _, pnl_ok, ev_ok, blowup_ok = row
        reasons = []
        if not pnl_ok: reasons.append(f"net<${MIN_PNL_TOTAL}")
        if not ev_ok: reasons.append("poor EV")
        if not blowup_ok: reasons.append("blow-up risk")
        print(f"| {eid} | {coin} | {n} | ${total:+.0f} | {wr:.0f}% | ${worst:.0f} | {', '.join(reasons)} |")
    print()


if __name__ == "__main__":
    main()
