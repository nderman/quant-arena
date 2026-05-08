#!/usr/bin/env python3
"""Live-settle watchdog — auto-blacklist engines exhibiting chop-fader pattern.

Runs as a cron (every 15 min). Detects (engine, arena) pairs where:

  - last 5 settled live trades show ≥ 4 losses (asymmetric loss rate)
  - sim's totalPnl over the same rounds is ≥ 0 (sim still claims winning)

That combination is the hallmark of the recurring extreme-price bias —
sim wildly optimistic, live actually losing. The watchdog appends the
pair to config/sim_unreliable.json and removes it from
data/live_engines.json, then logs the decision.

Why this matters: 2026-05-08 incident saw 25 of 29 settled live trades
LOST across 4 engines before manual audit. Trial-gate's $5 bankroll
bounded total loss but the per-engine bleed accumulated 5+ losses each.
This watchdog is meant to catch the same pattern at trade #5.

Pairs already in the blacklist are skipped (idempotent).
Pairs with < MIN_SETTLES are skipped (not enough signal).
Pairs where sim ALSO lost are NOT blacklisted — that's regular bad
strategy, handled by the auto_rotate streak cull, not this watchdog.

Usage:
  python3 scripts/liveSettleWatchdog.py             # dry-run (default)
  python3 scripts/liveSettleWatchdog.py --commit    # apply changes
"""
from __future__ import annotations
import argparse, json, os, sys, urllib.request, datetime as dt
from collections import defaultdict
from pathlib import Path
from typing import Optional

DATA_DIR = Path(os.environ.get("QUANT_DATA_DIR", "data"))
CONFIG_DIR = Path(os.environ.get("QUANT_CONFIG_DIR", "config"))
LEDGER_PATH = DATA_DIR / "live_trades.jsonl"
ROSTER_PATH = DATA_DIR / "live_engines.json"
BLACKLIST_PATH = CONFIG_DIR / "sim_unreliable.json"
LOG_PATH = DATA_DIR / "auto_blacklist.log"
ROUND_HISTORY_GLOB = "round_history_*.json"

MIN_SETTLES = int(os.environ.get("WATCHDOG_MIN_SETTLES", "5"))
LOSS_THRESHOLD = int(os.environ.get("WATCHDOG_LOSS_THRESHOLD", "4"))
ACTIVITY_LIMIT = int(os.environ.get("WATCHDOG_ACTIVITY_LIMIT", "200"))


def log(msg: str, also_print: bool = True) -> None:
    line = f"[{dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}] {msg}"
    if also_print:
        print(line)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a") as f:
        f.write(line + "\n")


def fetch_activity(funder: str) -> list[dict]:
    url = f"https://data-api.polymarket.com/activity?user={funder}&limit={ACTIVITY_LIMIT}"
    req = urllib.request.Request(url, headers={"User-Agent": "qf-watchdog/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def load_forward_buys() -> list[dict]:
    """Forward-emitted BUY fills only — sync rows have phantom attribution."""
    if not LEDGER_PATH.exists():
        return []
    out = []
    for line in LEDGER_PATH.read_text().splitlines():
        if not line.strip():
            continue
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("_source") in ("sync", "backfill"):
            continue
        if r.get("type") == "FILL" and r.get("side") == "BUY":
            out.append(r)
    return out


def build_slug_to_token_map(activity: list[dict]) -> dict[str, str]:
    """Activity API TRADE events have BOTH slug AND asset(tokenId). Build a
    bridge so REDEEMs (which have slug but no asset) can join to forward BUYs
    (which have tokenId but no slug).
    """
    out: dict[str, str] = {}
    for evt in activity:
        if evt.get("type") != "TRADE" or evt.get("side") != "BUY":
            continue
        slug = evt.get("slug", "")
        token = evt.get("asset", "")
        if slug and token:
            out[slug] = token
    return out


def extract_settles(activity: list[dict], buys: list[dict]) -> dict[tuple[str, str], list[dict]]:
    """Per (engine, arena) → list of settled trades [{ts, won, pnl, buy_ts}], newest first.

    Joining REDEEM → TRADE-by-slug → forward-BUY-by-tokenId → engineId.
    """
    slug_to_token = build_slug_to_token_map(activity)
    # Build per-token TRADE info (price, won) so we can detect outcome at REDEEM time.
    # REDEEM with usdcSize == 0 = the token didn't win (this side lost).
    # REDEEM with usdcSize > 0 (specifically size × $1 minus fees) = won.
    # Note: PM's REDEEM event reports the WALLET's redemption; if you held the
    # losing token, the redeem event still occurs but with usdcSize=0.
    out: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for evt in activity:
        if evt.get("type") != "REDEEM":
            continue
        slug = evt.get("slug", "")
        if not slug:
            continue
        token = slug_to_token.get(slug)
        if not token:
            continue
        # Find ALL forward BUYs for this token (could be multiple partials)
        matching = [b for b in buys if b.get("tokenId") == token]
        if not matching:
            continue
        # Use first BUY for engine attribution (assume they're all the same engine)
        first = matching[0]
        engine_id = first.get("engineId", "?")
        arena = first.get("arenaInstanceId", "?")

        # Determine outcome: usdcSize > 0 → won. PnL = sum(payout) - sum(cost).
        total_cost = sum((b.get("cost", 0) or b.get("size", 0) * b.get("fillPrice", 0))
                         for b in matching)
        payout = float(evt.get("usdcSize", 0))
        won = payout > 0
        pnl = payout - total_cost
        # Use earliest buy_ts for round-matching (round encloses the original entry)
        buy_ts = min(b.get("ts", 0) / 1000 for b in matching)
        avg_price = (total_cost / sum(b.get("size", 0) for b in matching)
                     if sum(b.get("size", 0) for b in matching) else 0)

        out[(engine_id, arena)].append({
            "ts": evt.get("timestamp", 0),
            "won": won,
            "pnl": pnl,
            "buy_ts": buy_ts,
            "price": avg_price,
            "slug": slug,
        })
    for k in out:
        out[k].sort(key=lambda r: -r["ts"])
    return out


def sim_pnl_for_engine_around(engine_id: str, arena: str, buy_timestamps: list[float]) -> float:
    """Sum sim totalPnl for the engine over rounds containing any of these buy ts."""
    path = DATA_DIR / f"round_history_{arena}.json"
    if not path.exists():
        return 0.0
    rounds = json.loads(path.read_text())
    total = 0.0
    seen_round_ids = set()
    # For each round, check if its [start_ts, end_ts] window covers any buy ts
    for i, r in enumerate(rounds):
        ts_str = r.get("timestamp")
        if not ts_str:
            continue
        try:
            r_end = dt.datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp()
        except Exception:
            continue
        # Round end is the timestamp; round start is previous round's end
        prev_end = 0.0
        if i > 0:
            prev_ts = rounds[i - 1].get("timestamp")
            if prev_ts:
                try:
                    prev_end = dt.datetime.fromisoformat(prev_ts.replace("Z", "+00:00")).timestamp()
                except Exception:
                    pass
        # Check if any buy timestamp falls in [prev_end, r_end]
        for buy_ts in buy_timestamps:
            if prev_end <= buy_ts <= r_end:
                if r.get("roundId") in seen_round_ids:
                    break
                seen_round_ids.add(r.get("roundId"))
                eng = next((e for e in r.get("allResults", [])
                            if (e.get("engineId") or e.get("id")) == engine_id), None)
                if eng:
                    total += eng.get("totalPnl", 0)
                break
    return total


def load_blacklist() -> dict:
    if not BLACKLIST_PATH.exists():
        return {"pairs": [], "reason": "", "blacklisted_at": ""}
    return json.loads(BLACKLIST_PATH.read_text())


def load_roster() -> dict:
    if not ROSTER_PATH.exists():
        return {}
    return json.loads(ROSTER_PATH.read_text())


def already_blacklisted(blacklist: dict, engine: str, arena: str) -> bool:
    return [engine, arena] in blacklist.get("pairs", [])


def write_blacklist(blacklist: dict, additions: list[tuple[str, str]], reason_suffix: str) -> None:
    for eng, arena in additions:
        blacklist["pairs"].append([eng, arena])
    blacklist["reason"] = (blacklist.get("reason", "") + " | " + reason_suffix).strip(" |")
    blacklist["blacklisted_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    tmp = BLACKLIST_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(blacklist, indent=2))
    os.rename(tmp, BLACKLIST_PATH)


def remove_from_roster(roster: dict, engine: str, arena: str) -> bool:
    if arena not in roster:
        return False
    before = len(roster[arena])
    roster[arena] = [e for e in roster[arena] if e.get("engineId") != engine]
    if not roster[arena]:
        del roster[arena]
    return len(roster.get(arena, [])) < before


def write_roster(roster: dict) -> None:
    backup_ts = int(dt.datetime.now(dt.timezone.utc).timestamp())
    backup_path = ROSTER_PATH.with_suffix(f".json.bak.watchdog_{backup_ts}")
    if ROSTER_PATH.exists():
        backup_path.write_text(ROSTER_PATH.read_text())
    tmp = ROSTER_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(roster, indent=2))
    os.rename(tmp, ROSTER_PATH)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true",
                    help="Apply changes (default is dry-run)")
    args = ap.parse_args()

    funder = os.environ.get("FUNDER") or os.environ.get("PM_FUNDER")
    if not funder:
        print("error: FUNDER env var required", file=sys.stderr)
        return 1

    log(f"watchdog start (commit={args.commit}, min_settles={MIN_SETTLES}, loss_threshold={LOSS_THRESHOLD}/{MIN_SETTLES})", also_print=False)

    activity = fetch_activity(funder)
    buys = load_forward_buys()
    settles = extract_settles(activity, buys)
    blacklist = load_blacklist()
    roster = load_roster()

    print(f"=== watchdog: {len(activity)} activity events, {len(buys)} forward BUYs, {len(settles)} (engine,arena) pairs with settles ===")
    print()

    candidates = []
    for (engine, arena), records in sorted(settles.items()):
        recent = records[:MIN_SETTLES]
        if len(recent) < MIN_SETTLES:
            continue
        losses = sum(1 for r in recent if not r["won"])
        if losses < LOSS_THRESHOLD:
            continue
        if already_blacklisted(blacklist, engine, arena):
            continue
        sim_total = sim_pnl_for_engine_around(engine, arena, [r["buy_ts"] for r in recent])
        if sim_total < 0:
            continue
        candidates.append((engine, arena, losses, recent, sim_total))

    if not candidates:
        print("  (no chop-fader-pattern divergences detected)")
        log("no divergences detected", also_print=False)
        return 0

    print(f"  {'engine @ arena':<48} {'losses':<8} {'sim_total':<12} avg_entry")
    print("  " + "-" * 95)
    additions = []
    for engine, arena, losses, recent, sim_total in candidates:
        avg_entry = sum(r["price"] for r in recent) / len(recent)
        print(f"  {engine + ' @ ' + arena:<48} {losses}/{MIN_SETTLES:<5}  ${sim_total:+9.2f}    ${avg_entry:.3f}")
        additions.append((engine, arena))

    if not args.commit:
        print("\n  DRY RUN — pass --commit to apply")
        return 0

    reason = f"watchdog 2026-{dt.datetime.now(dt.timezone.utc).strftime('%m-%d')}: chop-fader-pattern auto-detect (≥{LOSS_THRESHOLD}/{MIN_SETTLES} live losses with sim positive)"
    write_blacklist(blacklist, additions, reason)
    for engine, arena in additions:
        if remove_from_roster(roster, engine, arena):
            log(f"REMOVED {engine} @ {arena} from roster")
    write_roster(roster)
    log(f"BLACKLISTED {len(additions)} pairs: {additions}")
    print(f"\n  applied {len(additions)} blacklist additions + roster removals")
    return 0


if __name__ == "__main__":
    sys.exit(main())
