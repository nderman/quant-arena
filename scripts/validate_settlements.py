#!/usr/bin/env python3
"""
Validate our settlement decisions against Polymarket's actual Chainlink resolutions.

Parses settlement logs to find our WIN/LOSS decisions, then queries the
Polymarket CLOB API for the ground-truth winner for each token.

Usage:
  python3 scripts/validate_settlements.py [log_path] [ledger_path]
"""

import sqlite3
import sys
import os
import re
import json
import urllib.request
import urllib.error
import time
from collections import defaultdict

LOG = sys.argv[1] if len(sys.argv) > 1 else "logs/out.log"
LEDGER = sys.argv[2] if len(sys.argv) > 2 else "data/ledger.db"
CLOB_API = "https://clob.polymarket.com/markets"
GAMMA_API = "https://gamma-api.polymarket.com/markets"
SLEEP = 0.1

# Match: [settlement] ✓ WIN engine: N shares @ avg P → $1.00 | P&L: ...
SETTLEMENT_RE = re.compile(
    r"\[settlement\]\s+(?P<icon>✓ WIN|✗ LOSS)\s+(?P<engine>[\w-]+):\s+(?P<shares>[\d.]+)\s+shares\s+@\s+avg\s+(?P<avg>[\d.]+)\s+→\s+\$(?P<payout>[\d.]+)"
)

def fetch_json(url, timeout=10):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "validator"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except Exception:
        return None

def parse_settlements(log_path):
    """Parse settlement logs into list of (timestamp_str, engine, our_decision_won, shares, avg, payout)."""
    if not os.path.exists(log_path):
        print(f"Log not found: {log_path}")
        return []
    settlements = []
    with open(log_path) as f:
        for line in f:
            m = SETTLEMENT_RE.search(line)
            if not m:
                continue
            ts_match = re.search(r"(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})", line)
            if not ts_match:
                continue
            settlements.append({
                "ts": ts_match.group(1),
                "engine": m.group("engine"),
                "our_won": m.group("icon").startswith("✓"),
                "shares": float(m.group("shares")),
                "avg": float(m.group("avg")),
                "payout": float(m.group("payout")),
            })
    return settlements

def find_token_for_settlement(conn, engine, ts_str, avg_price, shares):
    """Look up the tokenId for an engine's settled position by matching avg entry and shares."""
    c = conn.cursor()
    # Find positions held by this engine before settlement time
    c.execute("""
        SELECT token_id, action, price, size FROM trades
        WHERE engine_id = ? AND timestamp < ?
        ORDER BY timestamp DESC LIMIT 100
    """, (engine, ts_str.replace(" ", "T") + "Z"))
    rows = c.fetchall()
    # Find a BUY for this engine with matching size band
    for token_id, action, price, size in rows:
        if action == "BUY" and abs(price - avg_price) < 0.05:
            return token_id
    return rows[0][0] if rows else None

def get_market_via_token(token_id):
    """Get conditionId + winners via Gamma → CLOB API chain."""
    # Try closed=true first (resolved markets), then default
    data = fetch_json(f"{GAMMA_API}?clob_token_ids={token_id}&closed=true")
    if not data:
        data = fetch_json(f"{GAMMA_API}?clob_token_ids={token_id}")
    if not data:
        return None, None, None
    m = data[0]
    cid = m.get("conditionId")
    question = m.get("question", "")
    if not cid:
        return None, None, question
    clob = fetch_json(f"{CLOB_API}/{cid}")
    if not clob or not clob.get("closed"):
        return cid, None, question
    winners = {t["token_id"]: t.get("winner", False) for t in clob.get("tokens", [])}
    return cid, winners, question

def main():
    settlements = parse_settlements(LOG)
    print(f"Parsed {len(settlements)} settlement records from {LOG}\n")

    if not settlements:
        sys.exit(1)

    if not os.path.exists(LEDGER):
        print(f"Ledger not found: {LEDGER}")
        sys.exit(1)
    conn = sqlite3.connect(LEDGER)

    # Group by token for efficiency: each token has one resolution
    # We'll process unique (engine, ts, avg) tuples
    cache_token_winner = {}  # token_id -> bool (winner) or None (pending)
    cache_token_question = {}

    correct = 0
    wrong = 0
    pending = 0
    not_found = 0
    mismatches = []

    print(f"{'Time':<20} {'Engine':<25} {'Our':<6} {'PM':<6} {'Question':<50}")
    print("-" * 110)

    for s in settlements[-30:]:  # last 30 settlements
        token_id = find_token_for_settlement(conn, s["engine"], s["ts"], s["avg"], s["shares"])
        if not token_id:
            not_found += 1
            continue

        if token_id not in cache_token_winner:
            time.sleep(SLEEP)
            cid, winners, question = get_market_via_token(token_id)
            cache_token_question[token_id] = question
            if winners is None:
                cache_token_winner[token_id] = None
            else:
                cache_token_winner[token_id] = winners.get(token_id)

        pm_won = cache_token_winner[token_id]
        question = (cache_token_question.get(token_id) or "?")[:48]

        if pm_won is None:
            print(f"{s['ts']:<20} {s['engine']:<25} {'WIN' if s['our_won'] else 'LOSS':<6} {'PEND':<6} {question}")
            pending += 1
        else:
            our = "WIN" if s["our_won"] else "LOSS"
            pm = "WIN" if pm_won else "LOSS"
            match = "✓" if s["our_won"] == pm_won else "✗"
            print(f"{s['ts']:<20} {s['engine']:<25} {our:<6} {pm:<6} {match} {question}")
            if s["our_won"] == pm_won:
                correct += 1
            else:
                wrong += 1
                mismatches.append({"engine": s["engine"], "ts": s["ts"], "our": our, "pm": pm, "q": question})

    print(f"\n--- Summary ---")
    total = correct + wrong
    if total > 0:
        print(f"Correct: {correct}/{total} ({100*correct/total:.1f}%)")
        print(f"Wrong:   {wrong}/{total} ({100*wrong/total:.1f}%)")
    print(f"Pending: {pending}")
    print(f"Not found: {not_found}")

    if mismatches:
        print(f"\n--- Mismatches ({len(mismatches)}) ---")
        for m in mismatches:
            print(f"  {m['ts']} {m['engine']}: we={m['our']} pm={m['pm']} | {m['q']}")

if __name__ == "__main__":
    main()
