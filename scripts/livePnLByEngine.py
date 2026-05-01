#!/usr/bin/env python3
"""Per-engine PnL summary from data/live_trades.jsonl.

Reads the append-only ledger and joins FILL → SETTLE rows by tokenId per
engine. Reports realized PnL, win rate, open positions, average per-trade.

Usage:
  python3 scripts/livePnLByEngine.py                 # all-time
  python3 scripts/livePnLByEngine.py --since 24h     # last 24h
  python3 scripts/livePnLByEngine.py --since 2026-04-30T07:20Z
"""
from __future__ import annotations
import argparse, json, os, re, sys, datetime as dt
from pathlib import Path
from collections import defaultdict

DATA_DIR = Path(os.environ.get("QUANT_DATA_DIR", "data"))
LEDGER_PATH = DATA_DIR / "live_trades.jsonl"

def parse_since(s: str) -> float:
    """Accept '24h', '7d', or ISO timestamp."""
    m = re.match(r"^(\d+)([hd])$", s)
    if m:
        n = int(m.group(1))
        unit = 3600 if m.group(2) == "h" else 86400
        return (dt.datetime.now(dt.timezone.utc).timestamp()) - n * unit
    return dt.datetime.fromisoformat(s.replace("Z","+00:00")).timestamp()

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2026-04-29T07:00Z", help="cutoff: '24h', '7d', or ISO")
    ap.add_argument("--ledger", default=str(LEDGER_PATH))
    args = ap.parse_args()

    cutoff_ms = parse_since(args.since) * 1000
    p = Path(args.ledger)
    if not p.exists():
        print(f"ledger not found: {p}", file=sys.stderr)
        return 1

    rows = []
    for line in p.read_text().splitlines():
        if not line.strip(): continue
        try: rows.append(json.loads(line))
        except: continue
    rows = [r for r in rows if r.get("ts", 0) >= cutoff_ms]
    rows.sort(key=lambda r: r.get("ts", 0))

    # Per (engine, arena) aggregation
    Stats = lambda: {"buys":0, "sells":0, "stake":0.0, "wins":0, "losses":0,
                     "settled_pnl":0.0, "settled_payout":0.0, "settled_cost":0.0,
                     "open_n":0, "open_stake":0.0}
    per_pair = defaultdict(Stats)
    # Track open positions by (engine, arena, tokenId)
    open_positions = defaultdict(lambda: {"size":0.0, "cost":0.0})
    settled_tokens = set()

    for r in rows:
        eid = r.get("engineId", "?")
        arena = r.get("arenaInstanceId", "?")
        key = (eid, arena)
        token = r.get("tokenId", "")
        if r["type"] == "FILL":
            if r["side"] == "BUY":
                per_pair[key]["buys"] += 1
                per_pair[key]["stake"] += r.get("cost", 0)
                open_positions[(eid, arena, token)]["size"] += r.get("size", 0)
                open_positions[(eid, arena, token)]["cost"] += r.get("cost", 0)
            elif r["side"] == "SELL":
                per_pair[key]["sells"] += 1
                # Sells reduce open positions but for simplicity treat as cash-back
                per_pair[key]["settled_payout"] += r.get("cost", 0)
        elif r["type"] == "SETTLE":
            per_pair[key]["settled_pnl"] += r.get("pnl", 0)
            per_pair[key]["settled_payout"] += r.get("payout", 0)
            per_pair[key]["settled_cost"] += r.get("costBasis", 0)
            if r.get("won"): per_pair[key]["wins"] += 1
            else: per_pair[key]["losses"] += 1
            settled_tokens.add((eid, arena, token))

    # Open positions: those with FILLs but no matching SETTLE
    for (eid, arena, token), pos in open_positions.items():
        if (eid, arena, token) in settled_tokens: continue
        if pos["size"] <= 0: continue
        per_pair[(eid, arena)]["open_n"] += 1
        per_pair[(eid, arena)]["open_stake"] += pos["cost"]

    print(f"=== Per-engine PnL since {args.since} (ledger: {p}) ===")
    print(f"{len(rows)} ledger rows in window\n")
    print(f"{'Engine @ Arena':<40} {'Fires':<6} {'W':<3} {'L':<3} {'WR':<5} {'Stake':<9} {'Realized':<11} {'Open':<8}")
    print("-"*100)
    total = {"stake":0.0, "realized":0.0, "open":0.0, "wins":0, "losses":0, "fires":0}
    sorted_pairs = sorted(per_pair.items(), key=lambda kv: kv[1]["settled_pnl"], reverse=True)
    for (eid, arena), s in sorted_pairs:
        total_settles = s["wins"] + s["losses"]
        wr = (s["wins"] / total_settles * 100) if total_settles else 0
        open_str = f"{s['open_n']}/${s['open_stake']:.2f}"
        print(f"{f'{eid} @ {arena}':<40} {s['buys']:<6} {s['wins']:<3} {s['losses']:<3} {wr:<4.0f}% ${s['stake']:<8.2f} ${s['settled_pnl']:+9.2f}  {open_str:<8}")
        total["stake"] += s["stake"]; total["realized"] += s["settled_pnl"]
        total["open"] += s["open_stake"]; total["wins"] += s["wins"]; total["losses"] += s["losses"]; total["fires"] += s["buys"]
    print("-"*100)
    overall_wr = (total["wins"] / max(1, total["wins"] + total["losses"]) * 100)
    print(f"{'TOTAL':<40} {total['fires']:<6} {total['wins']:<3} {total['losses']:<3} {overall_wr:<4.0f}% ${total['stake']:<8.2f} ${total['realized']:+9.2f}  ${total['open']:.2f} open")
    print(f"\nNet realized: ${total['realized']:+.2f}")
    print(f"Open exposure: ${total['open']:.2f} (at cost basis)")
    return 0

if __name__ == "__main__":
    sys.exit(main())
