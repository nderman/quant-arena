#!/usr/bin/env python3
"""Weekly whale leaderboard snapshot + diff.

Pulls the Polymarket Data API's monthly crypto leaderboard, saves the top
50 to `data/whale_scan/<isodate>.json`, and diffs against the prior
snapshot to track:
- New entrants (wallets that just appeared in the top 50)
- Dropouts (wallets that left the top 50)
- Persisters (wallets in both — with rank + PnL delta)

Goal: separate "flash-in-the-pan" lucky months from "persistent edge"
wallets. Persisters are the candidates worth deep-diving (per the
2026-05-13 Bonereaper1 / Marketing101 analysis).

Usage:
  python3 scripts/whaleScan.py             # snapshot + diff (default)
  python3 scripts/whaleScan.py --dry-run   # diff only, don't save snapshot
"""
from __future__ import annotations
import argparse, json, os, sys, urllib.request, datetime as dt
from pathlib import Path

DATA_DIR = Path(os.environ.get("QUANT_DATA_DIR", "data")) / "whale_scan"
DATA_DIR.mkdir(parents=True, exist_ok=True)
LOG_PATH = DATA_DIR / "diffs.log"

# Endpoint discovered 2026-05-14 from a curl trace of Polymarket's UI.
# Returns BIGGEST WINNERS per event (one row per (wallet, market) win),
# not unique wallets — so we aggregate by proxyWallet below to get the
# canonical "top-by-monthly-pnl" list. Needs browser-like headers or
# the API returns 404.
API_URL = (
    "https://data-api.polymarket.com/v1/biggest-winners"
    "?timePeriod=month&limit=200&offset=0&category=crypto"
)
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Referer": "https://polymarket.com/",
    "Accept": "application/json, text/plain, */*",
}


def log(msg: str) -> None:
    line = f"[{dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}] {msg}"
    print(line)
    with LOG_PATH.open("a") as f:
        f.write(line + "\n")


def pull_leaderboard() -> list[dict]:
    """Pull the biggest-winners endpoint and aggregate per-event rows by
    proxyWallet → one row per wallet with summed monthly pnl."""
    req = urllib.request.Request(API_URL, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        rows = json.loads(r.read())
    if not isinstance(rows, list):
        return []
    # Aggregate: each row is a single (wallet, event) win. Sum pnl per wallet.
    by_wallet: dict[str, dict] = {}
    for row in rows:
        wallet = (row.get("proxyWallet") or "").lower()
        if not wallet:
            continue
        bucket = by_wallet.setdefault(wallet, {
            "proxyWallet": wallet,
            "userName": row.get("userName") or "",
            "totalPnl": 0.0,
            "eventCount": 0,
            "topEventSlug": row.get("eventSlug"),
            "topEventPnl": float(row.get("pnl") or 0),
        })
        pnl = float(row.get("pnl") or 0)
        bucket["totalPnl"] += pnl
        bucket["eventCount"] += 1
        if pnl > bucket["topEventPnl"]:
            bucket["topEventPnl"] = pnl
            bucket["topEventSlug"] = row.get("eventSlug")
    # Sort descending by total pnl
    return sorted(by_wallet.values(), key=lambda r: -r["totalPnl"])


def latest_snapshot() -> tuple[str | None, list[dict] | None]:
    """Return (filename, contents) of most recent prior snapshot, or (None, None)."""
    files = sorted([p for p in DATA_DIR.glob("*.json") if not p.name.startswith("_")])
    if not files:
        return None, None
    p = files[-1]
    return p.name, json.loads(p.read_text())


def write_snapshot(rows: list[dict]) -> Path:
    iso = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    out = DATA_DIR / f"{iso}.json"
    out.write_text(json.dumps(rows, indent=2))
    return out


def normalize(row: dict) -> dict:
    """Extract a small canonical record from an aggregated leaderboard row."""
    addr = row.get("proxyWallet") or row.get("address") or ""
    return {
        "address": addr.lower() if addr else "",
        "name": row.get("userName") or row.get("name") or "",
        "pnl": float(row.get("totalPnl") or row.get("pnl") or 0),
        "eventCount": int(row.get("eventCount") or 0),
    }


def diff(prev: list[dict], cur: list[dict]) -> dict:
    prev_by = {normalize(r)["address"]: normalize(r) for r in prev if normalize(r)["address"]}
    cur_by = {normalize(r)["address"]: normalize(r) for r in cur if normalize(r)["address"]}
    prev_keys = set(prev_by.keys())
    cur_keys = set(cur_by.keys())
    added = sorted(cur_keys - prev_keys, key=lambda a: -cur_by[a]["pnl"])
    dropped = sorted(prev_keys - cur_keys, key=lambda a: -prev_by[a]["pnl"])
    persisted = sorted(cur_keys & prev_keys, key=lambda a: -cur_by[a]["pnl"])
    return {"added": [cur_by[a] for a in added],
            "dropped": [prev_by[a] for a in dropped],
            "persisted": [(prev_by[a], cur_by[a]) for a in persisted]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="Don't save snapshot")
    args = ap.parse_args()

    try:
        rows = pull_leaderboard()
    except Exception as e:
        log(f"ERROR pulling leaderboard: {e}")
        return 1

    if not isinstance(rows, list) or not rows:
        log(f"ERROR: leaderboard returned unexpected shape: {type(rows).__name__}")
        return 1

    prior_name, prior = latest_snapshot()
    log(f"snapshot: {len(rows)} rows, prior={prior_name or 'none'}")

    if prior:
        d = diff(prior, rows)
        log(f"=== diff vs {prior_name} ===")
        log(f"  added ({len(d['added'])}):")
        for w in d["added"][:10]:
            log(f"    + {w['name'] or w['address'][:10]} pnl=${w['pnl']:,.0f} events={w['eventCount']}")
        log(f"  dropped ({len(d['dropped'])}):")
        for w in d["dropped"][:10]:
            log(f"    - {w['name'] or w['address'][:10]} pnl=${w['pnl']:,.0f}")
        log(f"  persisted ({len(d['persisted'])}):")
        for (p, c) in d["persisted"][:10]:
            d_pnl = c["pnl"] - p["pnl"]
            log(f"    = {c['name'] or c['address'][:10]} pnl=${c['pnl']:,.0f} (Δ${d_pnl:+,.0f})")
    else:
        log("no prior snapshot — first run")
        for r in rows[:10]:
            n = normalize(r)
            log(f"  rank: {n['name'] or n['address'][:10]} pnl=${n['pnl']:,.0f} events={n['eventCount']}")

    if not args.dry_run:
        path = write_snapshot(rows)
        log(f"saved snapshot to {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
