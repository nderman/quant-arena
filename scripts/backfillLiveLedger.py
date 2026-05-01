#!/usr/bin/env python3
"""Backfill data/live_trades.jsonl from Polymarket Activity API + roster history.

Forward-going emission lives in src/live/liveLedger.ts. This script handles
the historical period before that emission existed (2026-04-29 → 2026-05-01).

Engine attribution uses a hand-curated ROSTER_HISTORY mapping
(arena, engine, start_iso, end_iso) — same logic as the analysis script,
but persisted to JSONL so future tools have a single source of truth.

Output schema matches src/live/liveLedger.ts:
  FILL:    {ts, type, engineId, coin, arenaInstanceId, tokenId,
            positionSide, side, size, limitPrice, fillPrice, cost, clientOrderId}
  SETTLE:  {ts, type, engineId, coin, arenaInstanceId, tokenId,
            marketSlug, won, shares, payout, pnl, costBasis}

Usage:
  python3 scripts/backfillLiveLedger.py             # dry-run (prints, no write)
  python3 scripts/backfillLiveLedger.py --write     # appends to data/live_trades.jsonl
  python3 scripts/backfillLiveLedger.py --reset --write   # truncate then write
"""
from __future__ import annotations
import argparse, json, os, re, sys, time, datetime as dt, urllib.request
from pathlib import Path
from collections import defaultdict
from typing import Optional

DATA_DIR = Path(os.environ.get("QUANT_DATA_DIR", "data"))
LEDGER_PATH = DATA_DIR / "live_trades.jsonl"
FUNDER = os.environ.get("FUNDER", "0xda848fc283c4543fCB5dd996d81a21E06072F93e")

# Roster history — what engine was live on what arena, when (UTC ISO).
# Build this carefully; future logs auto-attribute via liveLedger emission.
ROSTER_HISTORY = [
    # (arena_instance_id, engine_id, start_utc, end_utc or None)
    ("eth-15m", "maker-momentum-v1",     "2026-04-29T07:20Z", "2026-04-30T11:00Z"),
    ("btc",    "stingo43-late-v1",       "2026-04-29T00:00Z", "2026-04-29T23:59Z"),
    ("eth-4h", "signal-contrarian-v1",   "2026-04-30T07:20Z", None),
    ("sol",    "spread-compression-v1",  "2026-04-30T07:20Z", "2026-04-30T14:30Z"),
    ("sol",    "spread-compression-v1",  "2026-05-01T04:55Z", None),
    ("eth-15m","book-imbalance-v1",      "2026-04-30T07:20Z", "2026-05-01T05:30Z"),
    ("sol-4h", "momentum-settle-v1",     "2026-04-30T07:20Z", None),
    ("btc-4h", "bred-jp1t",              "2026-04-30T15:30Z", "2026-05-01T04:55Z"),
    ("btc-1h", "bred-fj25",              "2026-05-01T04:55Z", None),
    ("eth",    "chop-fader-v1",          "2026-05-01T05:00Z", None),
]

def parse_iso(s: str) -> float:
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()

def title_to_arena(title: str) -> Optional[str]:
    coin = "eth" if "Ethereum" in title else "sol" if "Solana" in title else "btc" if "Bitcoin" in title else None
    if not coin: return None
    m = re.search(r"(\d+):(\d+)([AP]M)-(\d+):(\d+)([AP]M) ET", title)
    if not m: return None
    def to_min(h, mm, ap):
        if ap == "PM" and h != 12: h += 12
        if ap == "AM" and h == 12: h = 0
        return h * 60 + mm
    duration = to_min(int(m.group(4)), int(m.group(5)), m.group(6)) - to_min(int(m.group(1)), int(m.group(2)), m.group(3))
    if duration < 0: duration += 24 * 60
    if duration <= 5:   return coin
    if duration <= 15:  return f"{coin}-15m"
    if duration <= 60:  return f"{coin}-1h"
    if duration <= 240: return f"{coin}-4h"
    return None

def attribute(title: str, ts: float) -> tuple[Optional[str], Optional[str]]:
    arena = title_to_arena(title)
    if not arena: return None, None
    for a, eid, start, end in ROSTER_HISTORY:
        if a != arena: continue
        if ts < parse_iso(start): continue
        if end is not None and ts > parse_iso(end): continue
        return eid, arena
    return None, arena

def fetch_activity(limit: int = 500) -> list[dict]:
    url = f"https://data-api.polymarket.com/activity?user={FUNDER}&limit={limit}"
    req = urllib.request.Request(url, headers={"User-Agent": "qf-backfill/1.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())

def coin_from_arena(arena: str) -> str:
    return arena.split("-")[0]

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="actually append to data/live_trades.jsonl")
    ap.add_argument("--reset", action="store_true", help="truncate the ledger first")
    ap.add_argument("--since", default="2026-04-29T07:00Z", help="UTC ISO cutoff")
    args = ap.parse_args()

    cutoff = parse_iso(args.since)
    activity = fetch_activity()
    print(f"fetched {len(activity)} activity events; processing those >= {args.since}")

    # Group buys by market slug — REDEEM events have empty `asset` field but
    # carry the same `slug` as the TRADE events on the same market.
    rows: list[dict] = []
    buys_by_market: dict[str, list[dict]] = defaultdict(list)
    skipped_unattributed = 0

    for a in sorted(activity, key=lambda x: x.get("timestamp", 0)):
        ts = a.get("timestamp", 0)
        if ts < cutoff: continue
        title = a.get("title", "") or ""
        typ = (a.get("type", "") or "").upper()
        side = a.get("side", "")
        size = float(a.get("size", 0) or 0)
        price = float(a.get("price", 0) or 0)
        usd = float(a.get("usdcSize", 0) or 0)
        token_id = a.get("asset", "") or ""
        slug = a.get("slug", "") or ""
        outcome = a.get("outcome", "")  # "Up" or "Down" for TRADEs
        position_side = "YES" if outcome == "Up" else "NO" if outcome == "Down" else "YES"

        eid, arena = attribute(title, ts)
        if not eid:
            skipped_unattributed += 1
            continue
        coin = coin_from_arena(arena)

        if typ == "TRADE" and side == "BUY":
            row = {
                "ts": int(ts * 1000),
                "type": "FILL",
                "engineId": eid,
                "coin": coin,
                "arenaInstanceId": arena,
                "tokenId": token_id,
                "positionSide": position_side,
                "side": "BUY",
                "size": size,
                "limitPrice": price,
                "fillPrice": price,
                "cost": usd,
                "clientOrderId": a.get("transactionHash", ""),
                "marketSlug": slug,
                "_source": "backfill",
            }
            rows.append(row)
            if slug:
                buys_by_market[slug].append(row)
        elif typ == "REDEEM":
            # REDEEMs have empty `asset` — match by `slug` (same per market)
            buys = buys_by_market.get(slug, [])
            if not buys:
                continue
            # The market may have multiple buys (different sides). PM emits one
            # REDEEM per outcome — payout > 0 means that side won. Match all
            # buys on this slug into a single settle event since we don't
            # know per-buy outcomes from the activity feed alone.
            total_size = sum(b["size"] for b in buys)
            total_cost = sum(b["cost"] for b in buys)
            # Only emit one SETTLE per slug — first REDEEM event (winning side)
            already_settled = any(r["type"]=="SETTLE" and r.get("marketSlug")==slug for r in rows)
            if already_settled and usd == 0: continue  # ignore the losing-side $0 redeem after a winning one
            won = usd > 0
            payout = usd if won else 0
            pnl = payout - total_cost
            settle_row = {
                "ts": int(ts * 1000),
                "type": "SETTLE",
                "engineId": eid,
                "coin": coin,
                "arenaInstanceId": arena,
                "tokenId": buys[0]["tokenId"],  # representative
                "marketSlug": slug,
                "won": won,
                "shares": total_size,
                "payout": payout,
                "pnl": pnl,
                "costBasis": total_cost,
                "_source": "backfill",
            }
            rows.append(settle_row)

    print(f"\nGenerated {len(rows)} ledger rows ({sum(1 for r in rows if r['type']=='FILL')} FILL, {sum(1 for r in rows if r['type']=='SETTLE')} SETTLE)")
    print(f"Skipped {skipped_unattributed} unattributed events (outside roster history or unrecognized title)")

    if not args.write:
        print("\nDRY RUN — sample first 5 rows:")
        for r in rows[:5]: print("  " + json.dumps(r))
        print("\nRe-run with --write to append. Use --reset to truncate first.")
        return 0

    if args.reset and LEDGER_PATH.exists():
        LEDGER_PATH.unlink()
        print(f"reset: removed existing {LEDGER_PATH}")

    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LEDGER_PATH.open("a") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    print(f"appended {len(rows)} rows to {LEDGER_PATH}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
