#!/usr/bin/env python3
"""Sync Polymarket Activity API → live_trades.jsonl, dedup by transactionHash.

Catches:
  - Manual buys/sells via the PM UI (e.g., user sold half a position)
  - Forward-emitted fills that failed to write (disk full, race, etc.)
  - Settlements that didn't make it through liveSettlement.ts
  - Any trade the live executor missed

Runs every 10 min on the VPS via cron. Append-only — never rewrites
existing ledger rows. Tagged `_source: "sync"` so we can distinguish
from forward-emitted (`undefined`) and historical backfill (`"backfill"`).

Usage:
  python3 scripts/syncManualTrades.py             # dry-run (prints diff)
  python3 scripts/syncManualTrades.py --write     # append new rows
  python3 scripts/syncManualTrades.py --hours 24  # widen lookback
"""
from __future__ import annotations
import argparse, json, os, re, sys, time, datetime as dt, urllib.request
from pathlib import Path
from collections import defaultdict
from typing import Optional

DATA_DIR = Path(os.environ.get("QUANT_DATA_DIR", "data"))
LEDGER_PATH = DATA_DIR / "live_trades.jsonl"
FUNDER = os.environ.get("FUNDER", "0xda848fc283c4543fCB5dd996d81a21E06072F93e")

# Roster history — same as backfillLiveLedger.py. Keep in sync when major
# rotations happen. Future: derive from auto_rotation_last_seen.json snapshots.
ROSTER_HISTORY = [
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

def existing_dedup_keys() -> set:
    """Build dedup-key set from existing ledger rows.

    NOTE: Forward-emitted FILL rows store `clientOrderId` = PM's CLOB order
    UUID (e.g. "0x5f7e09..." but as a CLOB ID, not chain). Activity API
    returns `transactionHash` = on-chain settlement hash. They are NOT the
    same value. So we use a tuple-based fingerprint that works for both:
      FILL:   ("fill", marketSlug, side, round(size,4), round(price,4))
      SETTLE: ("settle", marketSlug)   — only one SETTLE per market ever
    The forward emission and the Activity API will agree on this tuple.
    transactionHash is also added when present, as an extra precaution.
    """
    keys: set = set()
    if not LEDGER_PATH.exists():
        return keys
    for line in LEDGER_PATH.read_text().splitlines():
        if not line.strip(): continue
        try: r = json.loads(line)
        except: continue
        slug = r.get("marketSlug", "")
        if r.get("type") == "FILL":
            side = r.get("side", "")
            size = round(float(r.get("size", 0) or 0), 4)
            price = round(float(r.get("fillPrice", r.get("limitPrice", 0)) or 0), 4)
            if slug: keys.add(("fill", slug, side, size, price))
            coid = r.get("clientOrderId", "")
            if coid: keys.add(("hash", coid))
        elif r.get("type") == "SETTLE":
            if slug: keys.add(("settle", slug))
    return keys

def fetch_activity(limit: int = 200) -> list[dict]:
    url = f"https://data-api.polymarket.com/activity?user={FUNDER}&limit={limit}"
    req = urllib.request.Request(url, headers={"User-Agent": "qf-sync/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())

def coin_from_arena(arena: str) -> str:
    return arena.split("-")[0]

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="actually append new rows")
    ap.add_argument("--hours", type=float, default=2.0, help="lookback window")
    ap.add_argument("--limit", type=int, default=200, help="API event limit")
    args = ap.parse_args()

    cutoff = time.time() - args.hours * 3600
    activity = fetch_activity(args.limit)
    activity = [a for a in activity if a.get("timestamp", 0) >= cutoff]

    existing = existing_dedup_keys()
    new_rows: list[dict] = []
    skipped = 0; already = 0

    # Group buys by slug to compute SETTLE costBasis like backfill does
    buys_by_market: dict[str, list[dict]] = defaultdict(list)
    # Pre-load all FILLs for slugs we might encounter (so SETTLE math sees historical buys too)
    if LEDGER_PATH.exists():
        for line in LEDGER_PATH.read_text().splitlines():
            try: r = json.loads(line)
            except: continue
            if r.get("type") == "FILL" and r.get("marketSlug"):
                buys_by_market[r["marketSlug"]].append(r)

    for a in sorted(activity, key=lambda x: x.get("timestamp", 0)):
        ts = a.get("timestamp", 0)
        ts_ms = int(ts * 1000)
        title = a.get("title", "") or ""
        slug = a.get("slug", "") or ""
        typ = (a.get("type", "") or "").upper()
        side = a.get("side", "")
        size = float(a.get("size", 0) or 0)
        price = float(a.get("price", 0) or 0)
        usd = float(a.get("usdcSize", 0) or 0)
        token_id = a.get("asset", "") or ""
        outcome = a.get("outcome", "")
        position_side = "YES" if outcome == "Up" else "NO" if outcome == "Down" else "YES"
        tx_hash = a.get("transactionHash", "") or ""

        # Dedup. tx_hash dedup catches re-runs of sync (Activity API events
        # carry a stable transactionHash). The fingerprint dedup catches
        # forward-emitted rows from liveExecutor (which don't have tx_hash
        # but do have slug/side/size/price).
        if tx_hash and ("hash", tx_hash) in existing:
            already += 1
            continue
        if typ == "TRADE" and side in ("BUY", "SELL"):
            fp = ("fill", slug, side, round(size, 4), round(price, 4))
            if fp in existing:
                already += 1
                continue
        elif typ == "REDEEM":
            # Only one SETTLE per market — dedup by slug alone
            if slug and ("settle", slug) in existing:
                already += 1
                continue

        eid, arena = attribute(title, ts)
        if not eid:
            skipped += 1
            continue
        coin = coin_from_arena(arena)

        if typ == "TRADE" and side in ("BUY", "SELL"):
            row = {
                "ts": ts_ms,
                "type": "FILL",
                "engineId": eid,
                "coin": coin,
                "arenaInstanceId": arena,
                "tokenId": token_id,
                "positionSide": position_side,
                "side": side,
                "size": size,
                "limitPrice": price,
                "fillPrice": price,
                "cost": usd,
                "clientOrderId": tx_hash,
                "marketSlug": slug,
                "_source": "sync",
            }
            new_rows.append(row)
            buys_by_market[slug].append(row)
        elif typ == "REDEEM":
            buys = buys_by_market.get(slug, [])
            if not buys: continue
            # Cost basis = sum of BUYs minus SELLs (pro-rata), not naive sum.
            # Without filtering side, partial sells inflate costBasis and
            # understate PnL.
            buy_only = [b for b in buys if b.get("side", "BUY") == "BUY"]
            sell_only = [b for b in buys if b.get("side") == "SELL"]
            total_size = sum(b["size"] for b in buy_only) - sum(b["size"] for b in sell_only)
            total_cost = sum(b.get("cost", 0) for b in buy_only) - sum(b.get("cost", 0) for b in sell_only)
            if total_size <= 0: continue   # fully closed before settlement
            won = usd > 0
            payout = usd if won else 0
            pnl = payout - total_cost
            settle_row = {
                "ts": ts_ms,
                "type": "SETTLE",
                "engineId": eid,
                "coin": coin,
                "arenaInstanceId": arena,
                "tokenId": buys[0].get("tokenId",""),
                "marketSlug": slug,
                "won": won,
                "shares": total_size,
                "payout": payout,
                "pnl": pnl,
                "costBasis": total_cost,
                "_source": "sync",
            }
            new_rows.append(settle_row)

    print(f"[{dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')}Z] sync: scanned {len(activity)} activity events, {already} already in ledger, {skipped} unattributed, {len(new_rows)} NEW")
    for r in new_rows[:8]:
        print(f"  + {r['type']} {r.get('side','')} {r['engineId']} sz={r.get('size','-')} @${r.get('fillPrice', r.get('payout',0)):.4f} {r.get('marketSlug','')[:42]}")
    if len(new_rows) > 8:
        print(f"  ... and {len(new_rows)-8} more")

    if not args.write:
        if new_rows: print(f"DRY RUN — re-run with --write to append {len(new_rows)} rows")
        return 0

    if new_rows:
        LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LEDGER_PATH.open("a") as f:
            for r in new_rows:
                f.write(json.dumps(r) + "\n")
        print(f"appended {len(new_rows)} rows to {LEDGER_PATH}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
