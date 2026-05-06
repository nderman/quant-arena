#!/usr/bin/env python3
"""Retroactively tag round_history entries with their arena instance ID.

Pre Apr 24, all {coin} arenas wrote to a single round_history_{coin}.json
without arena-interval identification. This script reads each arena log
file, extracts which roundIds ran on which arena, and annotates the
round_history entries with `arenaInstanceId`, `coin`, `interval`.

Run once on the VPS or locally after pulling logs.

Usage:
  python3 scripts/backfillArenaIds.py
"""
import json, os, subprocess, re, sys
from collections import defaultdict

VPS = os.environ.get("QUANT_VPS_HOST", "root@vps.example.com")
LOG_DIR = "/root/quant-arena/logs"
DATA_DIR = "/root/quant-arena/data"

# arena process name -> (coin, interval, instanceId)
ARENAS = [
    ("arena-btc",      "btc", "5m",   "btc"),
    ("arena-btc-15m",  "btc", "15m",  "btc-15m"),
    ("arena-btc-1h",   "btc", "1h",   "btc-1h"),
    ("arena-btc-4h",   "btc", "4h",   "btc-4h"),
    ("arena-eth",      "eth", "5m",   "eth"),
    ("arena-eth-15m",  "eth", "15m",  "eth-15m"),
    ("arena-eth-1h",   "eth", "1h",   "eth-1h"),
    ("arena-eth-4h",   "eth", "4h",   "eth-4h"),
    ("arena-sol",      "sol", "5m",   "sol"),
    ("arena-sol-15m",  "sol", "15m",  "sol-15m"),
    ("arena-sol-1h",   "sol", "1h",   "sol-1h"),
    ("arena-sol-4h",   "sol", "4h",   "sol-4h"),
]

ROUND_START_RE = re.compile(r"Round (R\d{4}-\d+) starting")


def fetch_roundids_from_log(log_basename):
    """Return set of roundIds that ran on this arena's log."""
    try:
        r = subprocess.run(
            ["ssh", VPS, f"grep 'Round R.* starting' {LOG_DIR}/{log_basename}-out.log 2>/dev/null || true"],
            capture_output=True, text=True, timeout=30,
        )
        ids = set()
        for line in r.stdout.splitlines():
            m = ROUND_START_RE.search(line)
            if m:
                ids.add(m.group(1))
        return ids
    except Exception as e:
        print(f"  fetch error: {e}")
        return set()


def main():
    # Build: roundId -> (coin, interval, instanceId)
    rid_to_arena = {}
    for log_basename, coin, interval, instance_id in ARENAS:
        ids = fetch_roundids_from_log(log_basename)
        print(f"{log_basename}: {len(ids)} roundIds")
        for rid in ids:
            # If a roundId appears in multiple arenas (shouldn't happen but
            # possible with shared data dirs), last one wins. Log it.
            if rid in rid_to_arena:
                print(f"  WARN: {rid} in multiple arenas: {rid_to_arena[rid]} and {instance_id}")
            rid_to_arena[rid] = (coin, interval, instance_id)

    print(f"\nTotal: {len(rid_to_arena)} unique roundIds mapped")

    # For each coin, load round_history, annotate, and split into per-instance files
    for coin in ("btc", "eth", "sol"):
        try:
            r = subprocess.run(
                ["ssh", VPS, f"cat {DATA_DIR}/round_history_{coin}.json"],
                capture_output=True, text=True, timeout=30,
            )
            rounds = json.loads(r.stdout) if r.returncode == 0 else []
        except Exception:
            rounds = []
        if not rounds:
            continue

        # Bucket by instance
        by_instance = defaultdict(list)
        unknown = 0
        for rnd in rounds:
            rid = rnd.get("roundId", "")
            mapping = rid_to_arena.get(rid)
            if mapping:
                c, interval, instance_id = mapping
                rnd["arenaInstanceId"] = instance_id
                rnd["coin"] = c
                rnd["interval"] = interval
                by_instance[instance_id].append(rnd)
            else:
                unknown += 1

        print(f"\n{coin}: {len(rounds)} rounds — {unknown} unresolved")
        for instance_id, rnds in by_instance.items():
            print(f"  {instance_id}: {len(rnds)} rounds")

        # Write to annotated combined file AND per-instance files locally for inspection
        os.makedirs("data/backfill", exist_ok=True)
        with open(f"data/backfill/round_history_{coin}_annotated.json", "w") as f:
            json.dump(rounds, f, indent=2)
        for instance_id, rnds in by_instance.items():
            with open(f"data/backfill/round_history_{instance_id}.json", "w") as f:
                json.dump(rnds, f, indent=2)

    print(f"\nBackfill complete. Per-instance files in data/backfill/")
    print("To deploy to VPS as canonical: scp data/backfill/round_history_*.json root@vps:/root/quant-arena/data/")


if __name__ == "__main__":
    main()
