#!/usr/bin/env python3
"""
labelRegimes.py — Classify market regime for each completed arena round and
break down per-engine PnL by regime.

Goal: answer "does bred-4h85 work in all regimes or just trends?" and
"is dca-settle a trending-market specialist?".

Fetches ledger data over ssh and 1m klines from Binance public API.
"""

import json
import math
import os
import subprocess
import sys
import urllib.request
from datetime import datetime
from statistics import pstdev

VPS = "root@165.232.84.91"

ROUNDS = {
    "BTC": {
        "db": "~/quant-arena/data/ledger_btc.db",
        "symbol": "BTCUSDT",
        "round_ids": [
            "R0001-1775993501018",
            "R0002-1776015103087",
            "R0003-1776036705150",
        ],
    },
    "ETH": {
        "db": "~/quant-arena/data/ledger_eth.db",
        "symbol": "ETHUSDT",
        "round_ids": [
            "R0001-1775993500934",
            "R0002-1776015103028",
            "R0003-1776036705080",
        ],
    },
    "SOL": {
        "db": "~/quant-arena/data/ledger_sol.db",
        "symbol": "SOLUSDT",
        "round_ids": [
            "R0001-1775993500938",
            "R0002-1776015103035",
            "R0003-1776036705095",
        ],
    },
}


_ON_VPS = os.path.isdir("/root/quant-arena/data")


def ssh_sqlite(db: str, sql: str) -> str:
    escaped = sql.replace('"', '\\"')
    if _ON_VPS:
        # Running on VPS — invoke sqlite3 locally; expand ~ to /root.
        local_db = db.replace("~", "/root")
        cmd = ["sqlite3", local_db, sql]
    else:
        cmd = ["ssh", VPS, f'sqlite3 {db} "{escaped}"']
    out = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return out.stdout.strip()


def iso_to_ms(ts: str) -> int:
    # '2026-04-12T11:31:45.246Z' -> ms epoch
    ts = ts.replace("Z", "+00:00")
    return int(datetime.fromisoformat(ts).timestamp() * 1000)


def get_round_window(db: str, round_id: str):
    out = ssh_sqlite(
        db,
        f"SELECT MIN(timestamp), MAX(timestamp) FROM trades WHERE round_id='{round_id}';",
    )
    if not out or "|" not in out:
        return None, None
    mn, mx = out.split("|", 1)
    return iso_to_ms(mn), iso_to_ms(mx)


def fetch_klines(symbol: str, start_ms: int, end_ms: int):
    """Binance returns max 1000 candles per call; 6h = 360 candles, one call is fine."""
    url = (
        "https://api.binance.com/api/v3/klines"
        f"?symbol={symbol}&interval=1m&startTime={start_ms}&endTime={end_ms}&limit=1000"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "regime-labeler/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def compute_features(klines):
    # kline: [openTime, open, high, low, close, volume, closeTime, ...]
    closes = [float(k[4]) for k in klines]
    highs = [float(k[2]) for k in klines]
    lows = [float(k[3]) for k in klines]
    if len(closes) < 3:
        return None

    open_p = float(klines[0][1])
    close_p = closes[-1]
    total_return = (close_p - open_p) / open_p  # fraction

    log_rets = []
    for i in range(1, len(closes)):
        if closes[i - 1] > 0:
            log_rets.append(math.log(closes[i] / closes[i - 1]))
    # bps per minute
    vol_bps_min = pstdev(log_rets) * 10_000 if len(log_rets) > 1 else 0.0

    hi = max(highs)
    lo = min(lows)
    mean_p = sum(closes) / len(closes)
    range_pct = (hi - lo) / mean_p

    # Max drawdown within window (peak-to-trough on closes)
    peak = closes[0]
    max_dd = 0.0
    for c in closes:
        if c > peak:
            peak = c
        dd = (c - peak) / peak
        if dd < max_dd:
            max_dd = dd

    # Directional persistence: sign of return relative to window direction
    window_sign = 1 if total_return >= 0 else -1
    aligned = sum(1 for r in log_rets if (r >= 0 and window_sign > 0) or (r < 0 and window_sign < 0))
    persistence = aligned / len(log_rets) if log_rets else 0.0

    return {
        "n": len(closes),
        "total_return": total_return,
        "vol_bps_min": vol_bps_min,
        "range_pct": range_pct,
        "max_dd": max_dd,
        "persistence": persistence,
    }


def classify(f):
    ret_pct = f["total_return"] * 100  # in %
    vol = f["vol_bps_min"]
    persist = f["persistence"]

    if vol > 30.0:
        return "SPIKE"
    if ret_pct > 1.0:
        return "TREND_UP"
    if ret_pct < -1.0:
        return "TREND_DOWN"
    if vol < 8.0 and f["range_pct"] < 0.004:
        return "QUIET"
    # small net move, non-quiet = CHOP; boost to TREND if very persistent
    if persist > 0.58 and abs(ret_pct) > 0.4:
        return "TREND_UP" if ret_pct > 0 else "TREND_DOWN"
    return "CHOP"


def get_engine_pnl(db: str, round_id: str):
    out = ssh_sqlite(
        db,
        f"SELECT engine_id, SUM(pnl), COUNT(*) FROM trades WHERE round_id='{round_id}' GROUP BY engine_id ORDER BY SUM(pnl) DESC;",
    )
    rows = []
    for line in out.splitlines():
        if "|" not in line:
            continue
        parts = line.split("|")
        if len(parts) < 3:
            continue
        eng, pnl, n = parts[0], parts[1], parts[2]
        try:
            rows.append((eng, float(pnl), int(n)))
        except ValueError:
            continue
    return rows


def main():
    # (coin, round_id, regime, features, engine_pnl)
    results = []

    for coin, cfg in ROUNDS.items():
        for rid in cfg["round_ids"]:
            print(f"[fetch] {coin} {rid}", file=sys.stderr)
            start_ms, end_ms = get_round_window(cfg["db"], rid)
            if start_ms is None:
                print(f"  no trades for {rid}", file=sys.stderr)
                continue
            klines = fetch_klines(cfg["symbol"], start_ms, end_ms)
            feats = compute_features(klines)
            if feats is None:
                print(f"  insufficient klines", file=sys.stderr)
                continue
            regime = classify(feats)
            engines = get_engine_pnl(cfg["db"], rid)
            results.append((coin, rid, start_ms, end_ms, regime, feats, engines))

    # ----- Per-round summary table -----
    print()
    print("=" * 100)
    print("ROUND REGIMES")
    print("=" * 100)
    hdr = f"{'COIN':5} {'ROUND':22} {'REGIME':11} {'RET%':>8} {'VOL_bps':>9} {'RANGE%':>8} {'MAX_DD%':>9} {'PERSIST':>8}"
    print(hdr)
    print("-" * 100)
    for coin, rid, s, e, regime, f, _ in results:
        short_rid = rid.split("-")[0]
        print(
            f"{coin:5} {short_rid:22} {regime:11} "
            f"{f['total_return']*100:>+8.3f} {f['vol_bps_min']:>9.2f} "
            f"{f['range_pct']*100:>8.3f} {f['max_dd']*100:>+9.3f} {f['persistence']*100:>7.1f}%"
        )

    # ----- Per-regime per-engine leaderboard -----
    # Aggregate across all (coin, round) that fall in same regime
    regime_engines = {}  # regime -> engine -> [pnl_sum, trades, appearances, round_list]
    for coin, rid, _, _, regime, _, engines in results:
        short = f"{coin}/{rid.split('-')[0]}"
        d = regime_engines.setdefault(regime, {})
        for eng, pnl, n in engines:
            row = d.setdefault(eng, {"pnl": 0.0, "trades": 0, "rounds": []})
            row["pnl"] += pnl
            row["trades"] += n
            row["rounds"].append(short)

    print()
    print("=" * 100)
    print("ENGINE PnL BY REGIME (aggregated across rounds in that regime)")
    print("=" * 100)
    for regime in sorted(regime_engines.keys()):
        d = regime_engines[regime]
        n_rounds = len(set(r for row in d.values() for r in row["rounds"]))
        print()
        print(f"--- {regime}  ({n_rounds} round(s)) ---")
        print(f"{'ENGINE':32} {'PnL':>10} {'TRADES':>7} {'ROUNDS'}")
        sorted_engs = sorted(d.items(), key=lambda kv: -kv[1]["pnl"])
        for eng, row in sorted_engs:
            rnds = ",".join(row["rounds"])
            print(f"{eng:32} {row['pnl']:>+10.2f} {row['trades']:>7} {rnds}")

    # ----- Cross-regime engine consistency -----
    print()
    print("=" * 100)
    print("ENGINE CONSISTENCY: PnL per regime (columns) — blank = not in that regime's rounds")
    print("=" * 100)
    all_engines = set()
    for d in regime_engines.values():
        all_engines.update(d.keys())
    regimes_seen = sorted(regime_engines.keys())
    header = f"{'ENGINE':32} " + " ".join(f"{r:>11}" for r in regimes_seen) + f" {'TOTAL':>10}"
    print(header)
    print("-" * len(header))
    rows = []
    for eng in all_engines:
        vals = []
        total = 0.0
        for r in regimes_seen:
            pnl = regime_engines[r].get(eng, {}).get("pnl")
            if pnl is None:
                vals.append("")
            else:
                vals.append(f"{pnl:+.2f}")
                total += pnl
        rows.append((eng, vals, total))
    rows.sort(key=lambda x: -x[2])
    for eng, vals, total in rows:
        cells = " ".join(f"{v:>11}" for v in vals)
        print(f"{eng:32} {cells} {total:>+10.2f}")


if __name__ == "__main__":
    main()
