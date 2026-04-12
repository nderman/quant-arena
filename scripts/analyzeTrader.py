#!/usr/bin/env python3
"""Analyze any Polymarket wallet's trading patterns.

Pulls trade history from the Activity API and computes:
  - Volume, frequency, active days
  - Entry/exit price distributions
  - Win rate + P&L by market category
  - Hold duration distribution
  - Position sizing patterns
  - Time-of-day activity

Usage:
  python3 scripts/analyzeTrader.py 0xWALLET_ADDRESS
  python3 scripts/analyzeTrader.py 0xWALLET_ADDRESS 500    # limit to 500 records
  python3 scripts/analyzeTrader.py 0xWALLET_ADDRESS 0 weather  # filter to weather only
"""
import json, sys, time, re
from datetime import datetime, timezone, timedelta
from collections import defaultdict, Counter
from urllib.request import urlopen, Request

if len(sys.argv) < 2:
    print("Usage: python3 scripts/analyzeTrader.py 0xWALLET_ADDRESS [max_records] [filter]")
    sys.exit(1)

ADDR = sys.argv[1]
MAX_RECORDS = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 5000
FILTER = sys.argv[3].lower() if len(sys.argv) > 3 else None

def fj(url):
    req = Request(url, headers={"User-Agent": "pm-bot/1.0"})
    return json.loads(urlopen(req, timeout=15).read())

# ── Fetch all activity ───────────────────────────────────────────────────────

print(f"Fetching activity for {ADDR[:10]}...{ADDR[-6:]}  (max {MAX_RECORDS})")
acts = []
for off in range(0, MAX_RECORDS, 100):
    try:
        d = fj(f"https://data-api.polymarket.com/activity?user={ADDR}&limit=100&offset={off}")
        if not d: break
        acts.extend(d)
        if len(d) < 100: break
        time.sleep(0.3)
    except Exception as e:
        print(f"  fetch error at offset {off}: {e}")
        break

print(f"Fetched {len(acts)} activity records\n")
if not acts:
    sys.exit(0)

# ── Classify markets ─────────────────────────────────────────────────────────

def classify(title):
    t = (title or "").lower()
    if "temperature" in t or "precipitation" in t or "snowfall" in t: return "weather"
    if "up or down" in t: return "crypto_updown"
    if any(x in t for x in ["counter-strike", "cs2", "league of legends", "dota", "valorant"]): return "esports"
    if " vs " in title:
        if any(x in t for x in ["atp", "wta", "tennis", "open", "masters", "grand prix"]): return "tennis"
        if any(x in t for x in ["ufc", "mma", "fight"]): return "mma"
        return "sports_match"
    if any(x in t for x in ["bitcoin", "ethereum", "solana", "xrp", "crypto", "bnb", "doge"]): return "crypto"
    if any(x in t for x in ["trump", "biden", "election", "president", "congress", "senate"]): return "politics"
    return "other"

# Apply filter if specified
if FILTER:
    acts = [a for a in acts if classify(a.get("title", "")) == FILTER]
    print(f"Filtered to '{FILTER}': {len(acts)} records\n")

# ── Group by conditionId ─────────────────────────────────────────────────────

by_cid = defaultdict(list)
for a in acts:
    cid = a.get("conditionId", "")
    if cid: by_cid[cid].append(a)

# ── Compute per-position stats ───────────────────────────────────────────────

positions = []
for cid, trs in by_cid.items():
    bs = [t for t in trs if t.get("type") == "TRADE" and t.get("side") == "BUY"]
    ss = [t for t in trs if t.get("type") == "TRADE" and t.get("side") == "SELL"]
    rd = [t for t in trs if t.get("type") == "REDEEM"]
    if not bs: continue

    cost = sum(float(b.get("usdcSize", 0)) for b in bs)
    recv = sum(float(s.get("usdcSize", 0)) for s in ss) + sum(float(r.get("usdcSize", 0)) for r in rd)
    bsh = sum(float(b.get("size", 0)) for b in bs)
    ssh = sum(float(s.get("size", 0)) for s in ss)
    avg_entry = cost / bsh if bsh else 0
    avg_exit = recv / ssh if ssh else 0
    first_buy = min(b.get("timestamp", 0) for b in bs)
    last_exit = max(s.get("timestamp", 0) for s in ss) if ss else (max(r.get("timestamp", 0) for r in rd) if rd else 0)
    hold_hours = (last_exit - first_buy) / 3600 if last_exit > first_buy else 0

    closed = (ssh >= bsh * 0.9) or len(rd) > 0
    pnl = recv - cost if closed else 0
    category = classify(bs[0].get("title", ""))

    positions.append({
        "title": bs[0].get("title", "")[:60],
        "category": category,
        "cost": cost, "recv": recv, "pnl": pnl,
        "shares": bsh, "avg_entry": avg_entry, "avg_exit": avg_exit,
        "hold_hours": hold_hours,
        "closed": closed,
        "num_buys": len(bs), "num_sells": len(ss), "num_redeems": len(rd),
        "first_buy_ts": first_buy, "last_exit_ts": last_exit,
        "outcome": bs[0].get("outcome", ""),
    })

closed_pos = [p for p in positions if p["closed"]]
open_pos = [p for p in positions if not p["closed"]]

# ── Time range ───────────────────────────────────────────────────────────────

all_ts = [a.get("timestamp", 0) for a in acts]
first_ts = min(all_ts)
last_ts = max(all_ts)
first_dt = datetime.fromtimestamp(first_ts, tz=timezone.utc)
last_dt = datetime.fromtimestamp(last_ts, tz=timezone.utc)
span_days = max(1, (last_ts - first_ts) / 86400)

# ══════════════════════════════════════════════════════════════════════════════
# OUTPUT
# ══════════════════════════════════════════════════════════════════════════════

print("=" * 75)
print(f"TRADER ANALYSIS: {ADDR[:10]}...{ADDR[-6:]}")
print("=" * 75)

# ── Overview ─────────────────────────────────────────────────────────────────

total_buys = sum(1 for a in acts if a.get("type") == "TRADE" and a.get("side") == "BUY")
total_sells = sum(1 for a in acts if a.get("type") == "TRADE" and a.get("side") == "SELL")
total_redeems = sum(1 for a in acts if a.get("type") == "REDEEM")
total_volume = sum(float(a.get("usdcSize", 0)) for a in acts if a.get("type") == "TRADE")

print(f"\n  Period:        {first_dt.strftime('%Y-%m-%d')} → {last_dt.strftime('%Y-%m-%d')} ({span_days:.0f} days)")
print(f"  Records:       {len(acts)} ({total_buys} buys, {total_sells} sells, {total_redeems} redeems)")
print(f"  Volume:        ${total_volume:,.2f} total  (${total_volume/span_days:,.2f}/day)")
print(f"  Unique mkts:   {len(by_cid)}")
print(f"  Positions:     {len(closed_pos)} closed, {len(open_pos)} open")

# ── P&L ──────────────────────────────────────────────────────────────────────

if closed_pos:
    wins = [p for p in closed_pos if p["pnl"] > 0]
    losses = [p for p in closed_pos if p["pnl"] <= 0]
    total_pnl = sum(p["pnl"] for p in closed_pos)
    wr = len(wins) / len(closed_pos) * 100

    print(f"\n── P&L ──")
    print(f"  Net P&L:       ${total_pnl:+,.2f}")
    print(f"  Win rate:      {wr:.0f}%  ({len(wins)}W / {len(losses)}L)")
    if wins: print(f"  Avg win:       ${sum(p['pnl'] for p in wins)/len(wins):+.2f}")
    if losses: print(f"  Avg loss:      ${sum(p['pnl'] for p in losses)/len(losses):+.2f}")
    print(f"  Daily P&L:     ${total_pnl/span_days:+.2f}/day")

# ── By category ──────────────────────────────────────────────────────────────

cats = defaultdict(lambda: {"n": 0, "wins": 0, "pnl": 0, "volume": 0})
for p in closed_pos:
    c = cats[p["category"]]
    c["n"] += 1
    c["pnl"] += p["pnl"]
    c["volume"] += p["cost"]
    if p["pnl"] > 0: c["wins"] += 1

if cats:
    print(f"\n── By Category ──")
    print(f"  {'Category':<18} {'N':>4} {'WR':>5} {'P&L':>10} {'Volume':>10}")
    print(f"  {'-'*52}")
    for cat, c in sorted(cats.items(), key=lambda x: -x[1]["pnl"]):
        wr = c["wins"]/c["n"]*100 if c["n"] else 0
        print(f"  {cat:<18} {c['n']:>4} {wr:>4.0f}% ${c['pnl']:>+8.2f} ${c['volume']:>8.2f}")

# ── Entry/Exit Prices ────────────────────────────────────────────────────────

if closed_pos:
    entries = [p["avg_entry"] for p in closed_pos if p["avg_entry"] > 0]
    exits = [p["avg_exit"] for p in closed_pos if p["avg_exit"] > 0]

    print(f"\n── Entry Prices ──")
    entry_buckets = Counter()
    for e in entries:
        if e < 0.20: entry_buckets["< 20¢"] += 1
        elif e < 0.40: entry_buckets["20-40¢"] += 1
        elif e < 0.50: entry_buckets["40-50¢"] += 1
        elif e < 0.60: entry_buckets["50-60¢"] += 1
        elif e < 0.70: entry_buckets["60-70¢"] += 1
        elif e < 0.80: entry_buckets["70-80¢"] += 1
        elif e < 0.90: entry_buckets["80-90¢"] += 1
        else: entry_buckets["90¢+"] += 1
    for bucket, count in sorted(entry_buckets.items()):
        pct = count / len(entries) * 100
        bar = "█" * int(pct / 2)
        print(f"  {bucket:<10} {count:>4} ({pct:>4.0f}%)  {bar}")

# ── Hold Duration ────────────────────────────────────────────────────────────

    holds = [p["hold_hours"] for p in closed_pos if p["hold_hours"] > 0]
    if holds:
        print(f"\n── Hold Duration ──")
        dur_buckets = Counter()
        for h in holds:
            if h < 0.5: dur_buckets["< 30min"] += 1
            elif h < 1: dur_buckets["30m-1h"] += 1
            elif h < 4: dur_buckets["1-4h"] += 1
            elif h < 12: dur_buckets["4-12h"] += 1
            elif h < 24: dur_buckets["12-24h"] += 1
            elif h < 72: dur_buckets["1-3 days"] += 1
            else: dur_buckets["3+ days"] += 1
        for bucket, count in sorted(dur_buckets.items()):
            pct = count / len(holds) * 100
            bar = "█" * int(pct / 2)
            print(f"  {bucket:<12} {count:>4} ({pct:>4.0f}%)  {bar}")
        print(f"  Median: {sorted(holds)[len(holds)//2]:.1f}h  Mean: {sum(holds)/len(holds):.1f}h")

# ── Position Sizing ──────────────────────────────────────────────────────────

    costs = [p["cost"] for p in closed_pos]
    print(f"\n── Position Sizing ──")
    print(f"  Min:     ${min(costs):>8.2f}")
    print(f"  Median:  ${sorted(costs)[len(costs)//2]:>8.2f}")
    print(f"  Mean:    ${sum(costs)/len(costs):>8.2f}")
    print(f"  Max:     ${max(costs):>8.2f}")

# ── Time of Day ──────────────────────────────────────────────────────────────

buy_hours = Counter()
for a in acts:
    if a.get("type") == "TRADE" and a.get("side") == "BUY":
        h = datetime.fromtimestamp(a.get("timestamp", 0), tz=timezone.utc).hour
        buy_hours[h] += 1

if buy_hours:
    print(f"\n── Buy Activity by Hour (UTC) ──")
    max_count = max(buy_hours.values())
    for h in range(24):
        count = buy_hours.get(h, 0)
        bar = "█" * int(count / max(1, max_count) * 30) if count else ""
        if count: print(f"  {h:02d}:00  {count:>4}  {bar}")

# ── Top positions ────────────────────────────────────────────────────────────

if closed_pos:
    print(f"\n── Top 5 Wins ──")
    for p in sorted(closed_pos, key=lambda x: -x["pnl"])[:5]:
        print(f"  ${p['pnl']:>+7.2f}  e={p['avg_entry']:.2f} x={p['avg_exit']:.2f}  {p['hold_hours']:.1f}h  {p['title']}")

    print(f"\n── Top 5 Losses ──")
    for p in sorted(closed_pos, key=lambda x: x["pnl"])[:5]:
        print(f"  ${p['pnl']:>+7.2f}  e={p['avg_entry']:.2f} x={p['avg_exit']:.2f}  {p['hold_hours']:.1f}h  {p['title']}")

# ── Strategy fingerprint ─────────────────────────────────────────────────────

if closed_pos:
    avg_entry = sum(p["avg_entry"] for p in closed_pos) / len(closed_pos)
    avg_hold = sum(p["hold_hours"] for p in closed_pos if p["hold_hours"] > 0) / max(1, len([p for p in closed_pos if p["hold_hours"] > 0]))
    avg_size = sum(p["cost"] for p in closed_pos) / len(closed_pos)
    multi_buy = sum(1 for p in closed_pos if p["num_buys"] > 1)

    print(f"\n── Strategy Fingerprint ──")
    print(f"  Avg entry price:   ${avg_entry:.2f}")
    print(f"  Avg hold time:     {avg_hold:.1f}h")
    print(f"  Avg position size: ${avg_size:.2f}")
    print(f"  Multi-buy (DCA):   {multi_buy}/{len(closed_pos)} ({multi_buy/len(closed_pos)*100:.0f}%)")
    print(f"  Trades/day:        {len(closed_pos)/span_days:.1f}")
    print()
