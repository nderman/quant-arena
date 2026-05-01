#!/usr/bin/env python3
"""Sweep momentum threshold × lookback window to find optimal stingo43 config.

For each combination of (lookback_sec, min_abs_momentum_bps):
  - Take Binance 1-min klines
  - For every 5-min candle, measure momentum at T+lookback seconds
  - Entry signal: |momentum| >= threshold
  - Outcome: did the direction at entry match the direction at T+300s?
  - Compute: WR, edge vs 50%, signal rate (% of candles where gate triggered),
    implied PnL assuming hold-to-settle at fixed $10/trade entries.

Usage:
  python3 scripts/backtestMomentumSweep.py          # 168h BTC, default sweep
  python3 scripts/backtestMomentumSweep.py 72 ETH   # 72h ETH
"""
import argparse, json, time
from urllib.request import urlopen

ap = argparse.ArgumentParser(description="Sweep momentum threshold × lookback window for stingo43 config.")
ap.add_argument("hours", nargs="?", type=int, default=168, help="lookback hours (default 168)")
ap.add_argument("coin", nargs="?", default="BTC", help="BTC, ETH, SOL (default BTC)")
args = ap.parse_args()

HOURS = args.hours
SYMBOL = args.coin.upper() + "USDT"
CANDLE_SECS = 300

# Sweep grid
LOOKBACKS = [30, 60, 90, 120, 150, 180]  # seconds into candle
THRESHOLDS_BPS = [2, 5, 10, 15, 20, 30, 50]  # min abs momentum in bps

print(f"Sweep: {SYMBOL} last {HOURS}h, grid={len(LOOKBACKS)}×{len(THRESHOLDS_BPS)}\n")

# ── Fetch klines ───────────────────────────────────────────────────────────
end_ms = int(time.time() * 1000)
start_ms = end_ms - HOURS * 3600 * 1000

all_klines = []
cursor = start_ms
while cursor < end_ms:
    url = f"https://api.binance.com/api/v3/klines?symbol={SYMBOL}&interval=1m&startTime={cursor}&limit=1000"
    try:
        data = json.loads(urlopen(url).read())
    except Exception as e:
        print(f"  fetch error: {e}")
        break
    if not data:
        break
    all_klines.extend(data)
    cursor = data[-1][0] + 60001
    if len(data) < 1000:
        break
    time.sleep(0.15)

print(f"Fetched {len(all_klines)} klines\n")

# ── Build price map ────────────────────────────────────────────────────────
prices = {}
for k in all_klines:
    prices[k[0]] = float(k[4])  # close price

sorted_times = sorted(prices.keys())
if not sorted_times:
    print("No data")
    sys.exit(1)

# ── Sweep ──────────────────────────────────────────────────────────────────
# Result key: (lookback_sec, threshold_bps)
# Value: dict of { correct, wrong, triggered, total_candles, pnl_usd }
#
# PnL model: for each triggered candle, assume engine buys the signal side
# with $10 at the real PM price (approximated as 1 - |momentum|*20 to reflect
# that PM reprices with the move — bigger moves mean the winning side gets
# more expensive). Settlement pays $1 per share if correct, $0 if wrong.
#
# This is a first-order estimate — real PM book depth and repricing speed
# differ, but the ranking across configs is informative.

sweep = {}
for lb in LOOKBACKS:
    for th in THRESHOLDS_BPS:
        sweep[(lb, th)] = {
            "correct": 0, "wrong": 0, "triggered": 0,
            "total": 0, "pnl": 0.0,
        }

candle_ms = CANDLE_SECS * 1000
first_ts = sorted_times[0]
first_candle = first_ts - (first_ts % candle_ms) + candle_ms

ts = first_candle
total_candles = 0
while ts + candle_ms <= sorted_times[-1]:
    open_price = prices.get(ts)
    close_price = prices.get(ts + candle_ms - 60000)
    if open_price is None or close_price is None:
        ts += candle_ms
        continue
    total_candles += 1
    final_dir = 1 if close_price > open_price else (-1 if close_price < open_price else 0)

    for lb in LOOKBACKS:
        cp_ms = ts + lb * 1000
        cp_aligned = cp_ms - (cp_ms % 60000)
        cp_price = prices.get(cp_aligned)
        if cp_price is None:
            continue
        mom = (cp_price - open_price) / open_price if open_price > 0 else 0
        abs_mom_bps = abs(mom) * 10000
        mom_dir = 1 if mom > 0 else (-1 if mom < 0 else 0)
        if mom_dir == 0 or final_dir == 0:
            continue

        for th in THRESHOLDS_BPS:
            r = sweep[(lb, th)]
            r["total"] += 1
            if abs_mom_bps < th:
                continue
            r["triggered"] += 1

            # Approximate PM price at entry: the winner's ask scales with momentum.
            # At 10 bps move, winner is ~55¢. At 30 bps, ~65¢. At 100 bps, ~85¢.
            # Crude but monotone.
            pm_price_winner = 0.50 + min(0.40, abs_mom_bps / 200)
            pm_price_entry = pm_price_winner  # we buy the winner

            # $10 stake → shares = 10 / entry_price
            shares = 10.0 / pm_price_entry
            if mom_dir == final_dir:
                r["correct"] += 1
                r["pnl"] += shares * (1.0 - pm_price_entry)
            else:
                r["wrong"] += 1
                r["pnl"] += shares * (0.0 - pm_price_entry)

    ts += candle_ms

# ── Output ─────────────────────────────────────────────────────────────────
print(f"Total 5-min candles: {total_candles}\n")

# Best by total PnL
best_pnl = sorted(sweep.items(), key=lambda kv: -kv[1]["pnl"])[:10]
print("── Top 10 configs by total PnL ──")
print(f"{'Lookback':>10} {'Thresh':>8} {'Trig%':>8} {'WR':>8} {'Edge':>8} {'PnL':>10} {'Count':>8}")
print("-" * 70)
for (lb, th), r in best_pnl:
    if r["triggered"] == 0:
        continue
    trig_pct = r["triggered"] * 100.0 / r["total"] if r["total"] > 0 else 0
    wr = r["correct"] * 100.0 / r["triggered"]
    edge = wr - 50
    print(f"T+{lb:>4}s    {th:>4}bps   {trig_pct:>6.1f}%   {wr:>6.2f}%   {edge:>+6.1f}%   ${r['pnl']:>8.2f}   {r['triggered']:>5}")

# Best by WR (minimum sample size 30)
best_wr = sorted(
    [kv for kv in sweep.items() if kv[1]["triggered"] >= 30],
    key=lambda kv: -(kv[1]["correct"] / max(1, kv[1]["triggered"]))
)[:10]
print("\n── Top 10 configs by WR (min 30 triggers) ──")
print(f"{'Lookback':>10} {'Thresh':>8} {'Trig%':>8} {'WR':>8} {'Edge':>8} {'PnL':>10} {'Count':>8}")
print("-" * 70)
for (lb, th), r in best_wr:
    trig_pct = r["triggered"] * 100.0 / r["total"]
    wr = r["correct"] * 100.0 / r["triggered"]
    edge = wr - 50
    print(f"T+{lb:>4}s    {th:>4}bps   {trig_pct:>6.1f}%   {wr:>6.2f}%   {edge:>+6.1f}%   ${r['pnl']:>8.2f}   {r['triggered']:>5}")

# Full matrix
print("\n── Full sweep matrix: WR% (edge in parens) ──")
print(f"{'threshold':>12} " + " ".join(f"{f'T+{lb}s':>12}" for lb in LOOKBACKS))
for th in THRESHOLDS_BPS:
    row = [f"{th:>5}bps     "]
    for lb in LOOKBACKS:
        r = sweep[(lb, th)]
        if r["triggered"] < 10:
            row.append(f"{'—':>12}")
        else:
            wr = r["correct"] * 100.0 / r["triggered"]
            edge = wr - 50
            row.append(f"{wr:>5.1f}% ({edge:>+4.1f})")
    print(" ".join(row))

print(f"\n── Current stingo43-v1 config for reference ──")
print(f"  entryWindow: T+60-120s")
print(f"  momentum threshold: 5 bps")
print(f"  Compare to the rows at T+60s / T+90s / T+120s with threshold=5bps above.")
