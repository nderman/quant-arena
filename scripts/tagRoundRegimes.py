#!/usr/bin/env python3
"""Retroactively tag rounds in round_history_<coin>.json with regime labels.

For each round, queries Binance 1-min klines for the round's time window,
computes realized vol / return / persistence, assigns a regime label
(QUIET / CHOP / TREND / SPIKE), and writes the result back to round_history.

The labeled file enables per-engine per-regime analysis: which engines
win in CHOP vs TREND vs SPIKE? Answers feed the regime gate design.

Usage:
  python3 scripts/tagRoundRegimes.py             # tag BTC + ETH + SOL on VPS
  python3 scripts/tagRoundRegimes.py --local     # tag local history files
  python3 scripts/tagRoundRegimes.py --coin btc  # just one coin

Thresholds (match AbstractEngine.currentRegime):
  SPIKE: realizedVol >= 15 bps per 1-min tick
  TREND: |totalReturn| >= 0.10% (10 bps) over the round
  CHOP:  vol 2-15 bps, not trend
  QUIET: vol < 2 bps, no trend
"""
import json, sys, time, math, os, subprocess
from urllib.request import urlopen
from datetime import datetime

LOCAL = "--local" in sys.argv
COIN_FILTER = None
if "--coin" in sys.argv:
    i = sys.argv.index("--coin")
    if i + 1 < len(sys.argv):
        COIN_FILTER = sys.argv[i + 1].lower()

COIN_SYMBOLS = {"btc": "BTCUSDT", "eth": "ETHUSDT", "sol": "SOLUSDT", "xrp": "XRPUSDT"}
VPS = os.environ.get("QUANT_VPS_HOST", "root@vps.example.com")
REMOTE_DIR = "~/quant-arena/data"
LOCAL_DIR = "data"

# Auto-detect: if running on the VPS itself, use local files instead of SSH-to-self.
if not LOCAL and os.path.isdir("/root/quant-arena/data"):
    LOCAL = True
    LOCAL_DIR = "/root/quant-arena/data"


def fetch_klines(symbol, start_ms, end_ms):
    """Fetch 1-min klines for a specific window. Returns list of (ts_ms, close)."""
    url = (
        f"https://api.binance.com/api/v3/klines"
        f"?symbol={symbol}&interval=1m&startTime={start_ms}&endTime={end_ms}&limit=500"
    )
    try:
        data = json.loads(urlopen(url, timeout=10).read())
        return [(k[0], float(k[4])) for k in data]
    except Exception as e:
        print(f"    fetch error: {e}")
        return []


def label_regime(klines):
    """Classify a window of klines into QUIET/CHOP/TREND/SPIKE with metrics."""
    if len(klines) < 3:
        return {
            "label": "QUIET",
            "realizedVolBps": 0.0,
            "totalReturnPct": 0.0,
            "persistencePct": 0.0,
            "durationMin": 0,
        }

    opens = [p for _, p in klines]
    returns = []
    for i in range(1, len(opens)):
        prev, curr = opens[i - 1], opens[i]
        if prev > 0:
            returns.append((curr - prev) / prev)

    if not returns:
        return {
            "label": "QUIET",
            "realizedVolBps": 0.0,
            "totalReturnPct": 0.0,
            "persistencePct": 0.0,
            "durationMin": 0,
        }

    mean_ret = sum(returns) / len(returns)
    variance = sum((r - mean_ret) ** 2 for r in returns) / len(returns)
    vol = math.sqrt(variance)  # stddev of 1-min log returns (fraction)
    vol_bps = vol * 10000

    total_return = (opens[-1] - opens[0]) / opens[0] if opens[0] > 0 else 0
    total_return_pct = total_return * 100

    # Persistence: % of 1-min candles moving in same direction as total move
    if total_return > 0:
        persisted = sum(1 for r in returns if r > 0)
    elif total_return < 0:
        persisted = sum(1 for r in returns if r < 0)
    else:
        persisted = 0
    persistence_pct = persisted * 100 / len(returns)

    duration_min = (klines[-1][0] - klines[0][0]) / 60000

    # Classification
    if vol_bps >= 15:
        label = "SPIKE"
    elif abs(total_return_pct) >= 0.10:
        label = "TREND"
    elif vol_bps >= 2:
        label = "CHOP"
    else:
        label = "QUIET"

    return {
        "label": label,
        "realizedVolBps": round(vol_bps, 2),
        "totalReturnPct": round(total_return_pct, 3),
        "persistencePct": round(persistence_pct, 1),
        "durationMin": int(duration_min),
    }


def load_history(coin):
    """Read round_history_<coin>.json from VPS or local."""
    if LOCAL:
        path = os.path.join(LOCAL_DIR, f"round_history_{coin}.json")
        if not os.path.exists(path):
            return None
        with open(path) as f:
            return json.load(f)
    else:
        # Fetch from VPS
        remote_path = f"{REMOTE_DIR}/round_history_{coin}.json"
        try:
            result = subprocess.run(
                ["ssh", VPS, f"cat {remote_path}"],
                capture_output=True, text=True, timeout=15,
            )
            if result.returncode != 0:
                print(f"  ssh error: {result.stderr.strip()}")
                return None
            return json.loads(result.stdout)
        except Exception as e:
            print(f"  fetch error: {e}")
            return None


def save_history(coin, data):
    """Write back to VPS or local."""
    payload = json.dumps(data, indent=2)
    if LOCAL:
        path = os.path.join(LOCAL_DIR, f"round_history_{coin}.json")
        with open(path, "w") as f:
            f.write(payload)
    else:
        remote_path = f"{REMOTE_DIR}/round_history_{coin}.json"
        # Write via ssh redirect
        subprocess.run(
            ["ssh", VPS, f"cat > {remote_path}"],
            input=payload, text=True, timeout=15,
        )


def round_window_ms(round_entry):
    """Derive time window for a round from its roundId (format R0001-<epochMs>)."""
    rid = round_entry.get("roundId", "")
    parts = rid.split("-", 1)
    if len(parts) != 2:
        return None
    try:
        start_ms = int(parts[1])
    except ValueError:
        return None
    # Get timestamp field if present (ISO string of round END)
    ts = round_entry.get("timestamp")
    if ts:
        try:
            end_ms = int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
            if end_ms > start_ms:
                return (start_ms, end_ms)
        except Exception:
            pass
    # Fallback: assume 6h round
    return (start_ms, start_ms + 6 * 3600 * 1000)


def main():
    coins = [COIN_FILTER] if COIN_FILTER else ["btc", "eth", "sol"]
    total_tagged = 0
    total_existing = 0

    for coin in coins:
        symbol = COIN_SYMBOLS.get(coin)
        if not symbol:
            continue

        print(f"\n=== {coin.upper()} ({symbol}) ===")
        history = load_history(coin)
        if history is None:
            print(f"  no history file")
            continue

        print(f"  loaded {len(history)} rounds")
        regime_counts = {"QUIET": 0, "CHOP": 0, "TREND": 0, "SPIKE": 0}
        new_tags = 0
        existing_tags = 0

        for round_entry in history:
            if "regime" in round_entry and round_entry["regime"]:
                existing_tags += 1
                regime_counts[round_entry["regime"]["label"]] += 1
                continue

            window = round_window_ms(round_entry)
            if not window:
                continue
            start_ms, end_ms = window

            klines = fetch_klines(symbol, start_ms, end_ms)
            if not klines:
                continue

            stats = label_regime(klines)

            # Sub-window regime distribution: slice the round into 30-min
            # buckets, label each, output a histogram. Catches intra-round
            # regime changes (e.g. "2h CHOP then 4h TREND").
            bucket_size_min = 30
            regime_hist = {"QUIET": 0, "CHOP": 0, "TREND": 0, "SPIKE": 0}
            if len(klines) >= bucket_size_min:
                for i in range(0, len(klines), bucket_size_min):
                    bucket = klines[i:i + bucket_size_min]
                    if len(bucket) < 3:
                        continue
                    bucket_stats = label_regime(bucket)
                    regime_hist[bucket_stats["label"]] += 1
            total_buckets = sum(regime_hist.values()) or 1
            stats["bucketHistogram"] = {k: round(v / total_buckets, 2) for k, v in regime_hist.items()}
            stats["bucketCount"] = total_buckets

            round_entry["regime"] = stats
            regime_counts[stats["label"]] += 1
            new_tags += 1

            rid_short = round_entry["roundId"][:16]
            print(
                f"  {rid_short}... {stats['label']:>6} "
                f"vol={stats['realizedVolBps']:>5.1f}bps "
                f"ret={stats['totalReturnPct']:>+6.2f}% "
                f"({stats['durationMin']}m)"
            )
            time.sleep(0.2)

        if new_tags > 0:
            save_history(coin, history)
            print(f"  ✓ wrote {new_tags} new tags")

        total_tagged += new_tags
        total_existing += existing_tags

        print(f"  Regime counts: " + ", ".join(f"{k}={v}" for k, v in regime_counts.items() if v > 0))

    print(f"\nDone. Tagged {total_tagged} new rounds, {total_existing} already tagged.")


if __name__ == "__main__":
    main()
