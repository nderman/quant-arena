#!/usr/bin/env python3
"""Per-engine PnL summary from data/live_trades.jsonl.

Reads the append-only ledger and joins FILL → SETTLE rows by tokenId per
engine. Reports realized PnL, win rate, open positions.

Usage:
  python3 scripts/livePnLByEngine.py                 # all-time
  python3 scripts/livePnLByEngine.py --since 24h     # last 24h
  python3 scripts/livePnLByEngine.py --since 2026-04-30T07:20Z
"""
from __future__ import annotations
import argparse, sys
from pathlib import Path

from _live_ledger import LEDGER_PATH, aggregate, read_rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2026-04-29T07:00Z", help="cutoff: '24h', '7d', or ISO")
    ap.add_argument("--ledger", default=str(LEDGER_PATH))
    args = ap.parse_args()

    p = Path(args.ledger)
    if not p.exists():
        print(f"ledger not found: {p}", file=sys.stderr)
        return 1

    rows = read_rows(p, since=args.since)
    per_pair = aggregate(rows)

    print(f"=== Per-engine PnL since {args.since} (ledger: {p}) ===")
    print(f"{len(rows)} ledger rows in window\n")
    print(f"{'Engine @ Arena':<40} {'Fires':<6} {'W':<3} {'L':<3} {'WR':<5} {'Stake':<9} {'Realized':<11} {'Open':<8}")
    print("-" * 100)

    total = {"stake": 0.0, "realized": 0.0, "open": 0.0, "wins": 0, "losses": 0, "fires": 0}
    sorted_pairs = sorted(per_pair.items(), key=lambda kv: kv[1]["realized"], reverse=True)
    for (eid, arena), s in sorted_pairs:
        settles = s["wins"] + s["losses"]
        wr = (s["wins"] / settles * 100) if settles else 0
        open_str = f"{s['open_n']}/${s['open_stake']:.2f}"
        print(f"{f'{eid} @ {arena}':<40} {s['buys']:<6} {s['wins']:<3} {s['losses']:<3} {wr:<4.0f}% ${s['stake']:<8.2f} ${s['realized']:+9.2f}  {open_str:<8}")
        total["stake"] += s["stake"]
        total["realized"] += s["realized"]
        total["open"] += s["open_stake"]
        total["wins"] += s["wins"]
        total["losses"] += s["losses"]
        total["fires"] += s["buys"]

    print("-" * 100)
    overall_wr = total["wins"] / max(1, total["wins"] + total["losses"]) * 100
    print(f"{'TOTAL':<40} {total['fires']:<6} {total['wins']:<3} {total['losses']:<3} {overall_wr:<4.0f}% ${total['stake']:<8.2f} ${total['realized']:+9.2f}  ${total['open']:.2f} open")
    print(f"\nNet realized: ${total['realized']:+.2f}")
    print(f"Open exposure: ${total['open']:.2f} (at cost basis)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
