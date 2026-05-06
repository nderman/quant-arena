"""Shared loader for per-arena round_history files.

Replaces the legacy `COINS = ["btc","eth","sol"]` + `round_history_{coin}.json`
pattern that ignored the post-Apr-24 multi-arena split (5m/15m/1h/4h per coin).

Use `iter_rounds(source)` to stream `(arena_id, round_dict)` tuples across
every available arena. Use `load_history(arena_id, source)` for a single arena.

Sources:
  - "vps": SSH to VPS and `cat`. Use from laptop.
  - "local": read from ./data on the current machine. Use on VPS or laptop with synced data.
  - "backfill": read from ./data/backfill (historical reconstruction from before the arena split).
"""
import json, os, subprocess, glob

VPS = os.environ.get("QUANT_VPS_HOST", "root@vps.example.com")
REMOTE_DIR = "~/quant-arena/data"
BACKFILL_DIR = "data/backfill"
LOCAL_DIR = "data"

COINS = ("btc", "eth", "sol")
INTERVALS = ("5m", "15m", "1h", "4h")


def arena_id(coin: str, interval: str) -> str:
    """5m arenas use the bare coin id; everything else is `coin-interval`."""
    return coin if interval == "5m" else f"{coin}-{interval}"


def all_arena_ids() -> list[str]:
    return [arena_id(c, i) for c in COINS for i in INTERVALS]


def parse_arena_id(aid: str) -> tuple[str, str]:
    """Inverse of arena_id — returns (coin, interval)."""
    if "-" in aid:
        coin, interval = aid.split("-", 1)
        return coin, interval
    return aid, "5m"


def load_history(instance_id: str, source: str = "local") -> list[dict]:
    fname = f"round_history_{instance_id}.json"
    if source == "backfill":
        path = os.path.join(BACKFILL_DIR, fname)
    elif source == "local":
        path = os.path.join(LOCAL_DIR, fname)
    elif source == "vps":
        try:
            r = subprocess.run(["ssh", VPS, f"cat {REMOTE_DIR}/{fname}"],
                               capture_output=True, text=True, timeout=15)
            return json.loads(r.stdout) if r.returncode == 0 and r.stdout else []
        except Exception:
            return []
    else:
        raise ValueError(f"unknown source: {source}")
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def iter_rounds(source: str = "local", coins: list[str] | None = None,
                intervals: list[str] | None = None):
    """Yield (arena_id, round_dict) for every round in every matching arena."""
    coin_set = set(coins) if coins else set(COINS)
    interval_set = set(intervals) if intervals else set(INTERVALS)
    for c in COINS:
        if c not in coin_set:
            continue
        for i in INTERVALS:
            if i not in interval_set:
                continue
            aid = arena_id(c, i)
            for rd in load_history(aid, source):
                yield aid, rd


def list_available_arenas(source: str = "local") -> list[str]:
    """Discover arena ids that actually have round_history files (vs. theoretical)."""
    if source == "vps":
        try:
            r = subprocess.run(["ssh", VPS, f"ls {REMOTE_DIR}/round_history_*.json"],
                               capture_output=True, text=True, timeout=15)
            paths = r.stdout.strip().splitlines()
        except Exception:
            return []
    else:
        d = BACKFILL_DIR if source == "backfill" else LOCAL_DIR
        paths = glob.glob(os.path.join(d, "round_history_*.json"))
    arenas = []
    for p in paths:
        base = os.path.basename(p)
        if base.startswith("round_history_") and base.endswith(".json"):
            arenas.append(base[len("round_history_"):-len(".json")])
    return sorted(arenas)
