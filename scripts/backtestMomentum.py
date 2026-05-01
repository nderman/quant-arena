#!/usr/bin/env python3
"""Backtest: does Binance direction at T+Xs predict 5-minute candle outcome?

For each 5-minute window over the last N hours, checks if the price
direction at T+30s, T+60s, T+90s, T+120s matches the final direction
at T+300s (settlement). This validates the hypothesis that early-candle
momentum predicts settlement — the core signal for stingo43-style
69% WR side selection.

Usage:
  python3 scripts/backtestMomentum.py          # last 24h BTC
  python3 scripts/backtestMomentum.py 72 ETH   # last 72h ETH
"""
import argparse, json, time
from urllib.request import urlopen
from collections import defaultdict

ap = argparse.ArgumentParser(description="Backtest: does Binance direction at T+Xs predict 5min candle outcome?")
ap.add_argument("hours", nargs="?", type=int, default=24, help="lookback hours (default 24)")
ap.add_argument("coin", nargs="?", default="BTC", help="BTC, ETH, SOL (default BTC)")
args = ap.parse_args()

HOURS = args.hours
SYMBOL = args.coin.upper() + "USDT"
CANDLE_SECS = 300
CHECK_POINTS = [30, 60, 90, 120, 150, 180]

print(f"Backtesting momentum prediction for {SYMBOL} over last {HOURS}h")
print(f"Question: at T+Xs, does Binance direction predict T+{CANDLE_SECS}s outcome?\n")

# Fetch 1-minute klines from Binance
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
    time.sleep(0.2)

print(f"Fetched {len(all_klines)} 1-minute klines\n")

# Build minute-level price map: timestamp_ms -> close price
prices = {}
for k in all_klines:
    open_ms = k[0]
    close_price = float(k[4])
    prices[open_ms] = close_price

# For each 5-minute window, compute direction at checkpoints vs final
# Align to 5-minute boundaries
sorted_times = sorted(prices.keys())
if not sorted_times:
    print("No data")
    sys.exit(1)

# Find 5-minute boundaries
first_ts = sorted_times[0]
candle_ms = CANDLE_SECS * 1000
# Round up to next 5-minute boundary
first_candle = first_ts - (first_ts % candle_ms) + candle_ms

results = {cp: {"correct": 0, "wrong": 0, "flat": 0} for cp in CHECK_POINTS}
candle_outcomes = []

ts = first_candle
while ts + candle_ms <= sorted_times[-1]:
    open_price = prices.get(ts)
    close_price = prices.get(ts + candle_ms - 60000)  # last 1-min kline in window

    if open_price is None or close_price is None:
        ts += candle_ms
        continue

    # Settlement direction: did price go up or down over the 5-min window?
    final_dir = "UP" if close_price > open_price else ("DOWN" if close_price < open_price else "FLAT")

    for cp in CHECK_POINTS:
        cp_ms = ts + cp * 1000
        # Find closest 1-min kline
        cp_aligned = cp_ms - (cp_ms % 60000)
        cp_price = prices.get(cp_aligned)
        if cp_price is None:
            continue

        cp_dir = "UP" if cp_price > open_price else ("DOWN" if cp_price < open_price else "FLAT")

        if final_dir == "FLAT" or cp_dir == "FLAT":
            results[cp]["flat"] += 1
        elif cp_dir == final_dir:
            results[cp]["correct"] += 1
        else:
            results[cp]["wrong"] += 1

    candle_outcomes.append(final_dir)
    ts += candle_ms

total_candles = len(candle_outcomes)
up_count = candle_outcomes.count("UP")
down_count = candle_outcomes.count("DOWN")

print(f"Total 5-minute candles: {total_candles}")
print(f"UP: {up_count} ({up_count*100/total_candles:.1f}%)  DOWN: {down_count} ({down_count*100/total_candles:.1f}%)\n")

print(f"{'Checkpoint':>12} {'Correct':>8} {'Wrong':>8} {'Flat':>6} {'WR':>8} {'Edge vs 50%':>12}")
print("-" * 60)
for cp in CHECK_POINTS:
    r = results[cp]
    total = r["correct"] + r["wrong"]
    if total == 0:
        continue
    wr = r["correct"] / total * 100
    edge = wr - 50
    bar = "█" * int(edge) if edge > 0 else ""
    print(f"  T+{cp:>3}s     {r['correct']:>6}   {r['wrong']:>6}  {r['flat']:>5}   {wr:>6.1f}%   {edge:>+.1f}% {bar}")

print(f"\nInterpretation:")
print(f"  If T+60s WR is ~65-70%, that validates the stingo43 signal.")
print(f"  If T+120s WR is ~75%+, late entry is even safer (but PM has repriced).")
print(f"  Edge vs 50% is the pure alpha above coin flip.")
