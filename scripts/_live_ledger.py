"""Shared ledger reader for data/live_trades.jsonl.

Both `livePnLByEngine.py` and `liveStatus.py` aggregate FILL/SETTLE rows the
same way. Putting it here prevents the two from drifting silently — once
bitten, twice shy after April's "phantom alpha from never-populated state"
incident.
"""
from __future__ import annotations
import datetime as dt
import json
import os
import re
from collections import defaultdict
from pathlib import Path

DATA_DIR = Path(os.environ.get("QUANT_DATA_DIR", "data"))
LEDGER_PATH = DATA_DIR / "live_trades.jsonl"


def parse_since(s: str) -> float:
    """Accept '24h', '7d', or ISO timestamp. Returns Unix seconds."""
    m = re.match(r"^(\d+)([hd])$", s)
    if m:
        n = int(m.group(1))
        unit = 3600 if m.group(2) == "h" else 86400
        return dt.datetime.now(dt.timezone.utc).timestamp() - n * unit
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def read_rows(path: Path | str = LEDGER_PATH, since: str | None = None) -> list[dict]:
    """Read jsonl ledger, optionally filter by `since` cutoff."""
    p = Path(path)
    if not p.exists():
        return []
    rows = []
    cutoff_ms = parse_since(since) * 1000 if since else 0
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if r.get("ts", 0) >= cutoff_ms:
            rows.append(r)
    rows.sort(key=lambda r: r.get("ts", 0))
    return rows


def _empty_stats() -> dict:
    return {"buys": 0, "sells": 0, "stake": 0.0, "wins": 0, "losses": 0,
            "realized": 0.0, "open_n": 0, "open_stake": 0.0}


def aggregate(rows: list[dict]) -> dict[tuple[str, str], dict]:
    """Aggregate FILL/SETTLE rows into per-(engineId, arena) stats.

    Open positions = FILLs without a matching SETTLE row for the same tokenId.
    SELL fills are counted as a separate SELL count but their cash-back is
    folded into `realized` so the net column reflects manual de-risks.
    """
    per_pair: dict[tuple[str, str], dict] = defaultdict(_empty_stats)
    open_positions: dict[tuple[str, str, str], dict] = defaultdict(
        lambda: {"size": 0.0, "cost": 0.0})
    settled_tokens: set[tuple[str, str, str]] = set()

    for r in rows:
        eid = r.get("engineId", "?")
        arena = r.get("arenaInstanceId", "?")
        key = (eid, arena)
        token = r.get("tokenId", "")
        rtype = r.get("type")
        if rtype == "FILL":
            side = r.get("side")
            if side == "BUY":
                per_pair[key]["buys"] += 1
                per_pair[key]["stake"] += r.get("cost", 0)
                open_positions[(eid, arena, token)]["size"] += r.get("size", 0)
                open_positions[(eid, arena, token)]["cost"] += r.get("cost", 0)
            elif side == "SELL":
                per_pair[key]["sells"] += 1
                per_pair[key]["realized"] += r.get("cost", 0)
        elif rtype == "SETTLE":
            per_pair[key]["realized"] += r.get("pnl", 0)
            if r.get("won"):
                per_pair[key]["wins"] += 1
            else:
                per_pair[key]["losses"] += 1
            settled_tokens.add((eid, arena, token))

    for (eid, arena, token), pos in open_positions.items():
        if (eid, arena, token) in settled_tokens or pos["size"] <= 0:
            continue
        per_pair[(eid, arena)]["open_n"] += 1
        per_pair[(eid, arena)]["open_stake"] += pos["cost"]

    return per_pair
