#!/usr/bin/env python3
"""DEPRECATED — use scripts/engineRegimeReport.py + scripts/crossArenaAnalysis.py.

Was a daily snapshot of engine × regime × coin. Hardcoded to base 5min coins
(missed *-15m/*-1h/*-4h arenas). The two replacements together give a richer
picture across all arenas.

Kept for reference but not maintained.
"""
import json, sys, os, subprocess, argparse
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from statistics import mean, median

VPS = "root@165.232.84.91"
REMOTE_DIR = "~/quant-arena/data"
LOCAL_DIR = "data"
SUMMARIES_DIR = "data/summaries"
COINS = ["btc", "eth", "sol"]


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--local", action="store_true")
    p.add_argument("--date", default=None, help="UTC date YYYY-MM-DD (default: today)")
    p.add_argument("--days", type=int, default=1, help="How many days back to include")
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
    end = datetime.now(timezone.utc) if not args.date else datetime.fromisoformat(args.date + "T23:59:59+00:00")
    start = end - timedelta(days=args.days)
    date_str = end.strftime("%Y-%m-%d")

    os.makedirs(SUMMARIES_DIR, exist_ok=True)
    out_path = os.path.join(SUMMARIES_DIR, f"{date_str}.md")

    # engine -> coin -> regime -> list of pnls
    data = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    regime_counts = defaultdict(lambda: defaultdict(int))
    total_rounds = defaultdict(int)

    for coin in COINS:
        rounds = load_history(coin, args.local)
        if not rounds:
            continue
        for r in rounds:
            ts = r.get("timestamp")
            if not ts:
                continue
            try:
                rt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            except Exception:
                continue
            if rt < start or rt > end:
                continue
            total_rounds[coin] += 1
            regime_field = r.get("regime")
            if isinstance(regime_field, dict):
                regime = regime_field.get("label", "UNKNOWN")
            elif isinstance(regime_field, str):
                regime = regime_field
            else:
                regime = "UNKNOWN"
            regime_counts[coin][regime] += 1
            for eng in r.get("allResults", []):
                eid = eng.get("engineId") or eng.get("id")
                if not eid:
                    continue
                pnl = eng.get("pnl", 0.0)
                data[eid][coin][regime].append(pnl)

    lines = []
    lines.append(f"# Daily Summary — {date_str} ({args.days}d window)")
    lines.append("")
    lines.append(f"Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    lines.append("")

    if not total_rounds:
        lines.append("_No round history in window._")
        with open(out_path, "w") as f:
            f.write("\n".join(lines))
        print(f"wrote empty summary: {out_path}")
        return

    lines.append("## Rounds by Coin × Regime")
    lines.append("")
    lines.append("| Coin | Total | CHOP | TREND | SPIKE | QUIET | UNKNOWN |")
    lines.append("|------|-------|------|-------|-------|-------|---------|")
    for coin in COINS:
        if not total_rounds[coin]:
            continue
        rc = regime_counts[coin]
        lines.append(f"| {coin.upper()} | {total_rounds[coin]} | {rc.get('CHOP',0)} | {rc.get('TREND',0)} | {rc.get('SPIKE',0)} | {rc.get('QUIET',0)} | {rc.get('UNKNOWN',0)} |")
    lines.append("")

    lines.append("## Top Engines — Total PnL Across All Coins (realized)")
    lines.append("")
    engine_totals = []
    for eid, coin_map in data.items():
        total_pnl = 0
        total_rounds_fired = 0
        for coin, regime_map in coin_map.items():
            for regime, pnls in regime_map.items():
                fired = [p for p in pnls if p != 0]
                total_pnl += sum(fired)
                total_rounds_fired += len(fired)
        if total_rounds_fired > 0:
            engine_totals.append((eid, total_pnl, total_rounds_fired))

    engine_totals.sort(key=lambda x: x[1], reverse=True)

    lines.append("| Engine | Total PnL | Firing Rounds | Avg/fire |")
    lines.append("|--------|-----------|---------------|----------|")
    for eid, total, fires in engine_totals[:15]:
        avg = total / fires if fires else 0
        lines.append(f"| {eid} | {total:+.2f} | {fires} | {avg:+.2f} |")
    lines.append("")

    lines.append("## Engine × Regime Performance (avg PnL per firing round)")
    lines.append("")
    lines.append("Only engines with ≥ 3 firing rounds shown. Across all coins.")
    lines.append("")
    lines.append("| Engine | CHOP | TREND | SPIKE | QUIET |")
    lines.append("|--------|------|-------|-------|-------|")

    for eid, total, fires in engine_totals[:20]:
        row = {"CHOP": [], "TREND": [], "SPIKE": [], "QUIET": []}
        for coin, regime_map in data[eid].items():
            for regime, pnls in regime_map.items():
                if regime in row:
                    row[regime].extend([p for p in pnls if p != 0])
        cells = []
        show = False
        for rname in ["CHOP", "TREND", "SPIKE", "QUIET"]:
            pnls = row[rname]
            if len(pnls) >= 3:
                show = True
                avg = mean(pnls)
                cells.append(f"{avg:+.1f} (n={len(pnls)})")
            elif pnls:
                cells.append(f"_{mean(pnls):+.1f}_ (n={len(pnls)})")
            else:
                cells.append("—")
        if show:
            lines.append(f"| {eid} | " + " | ".join(cells) + " |")
    lines.append("")

    lines.append("## Per-Coin Leader Per Regime")
    lines.append("")
    for coin in COINS:
        if not total_rounds[coin]:
            continue
        lines.append(f"### {coin.upper()}")
        for regime in ["CHOP", "TREND", "SPIKE", "QUIET"]:
            leaders = []
            for eid, coin_map in data.items():
                pnls = [p for p in coin_map.get(coin, {}).get(regime, []) if p != 0]
                if len(pnls) >= 2:
                    leaders.append((eid, sum(pnls), len(pnls)))
            if not leaders:
                continue
            leaders.sort(key=lambda x: x[1], reverse=True)
            top = leaders[:3]
            if top:
                lines.append(f"- **{regime}** ({regime_counts[coin][regime]} rounds): " +
                             ", ".join(f"{e} ({p:+.2f}, n={n})" for e, p, n in top))
        lines.append("")

    with open(out_path, "w") as f:
        f.write("\n".join(lines))
    print(f"wrote: {out_path}")


if __name__ == "__main__":
    main()
