#!/usr/bin/env python3
"""Empirical calibration of Layer 2 settlement bias.

Pulls all settled trades from the Activity API, buckets them by entry
price, and computes the per-bucket flip probability that would make sim's
predicted loss rate match the observed live loss rate. Writes
`config/empirical_flip_prob.json` for the referee to consume.

The current `extremeFlipProb(price)` formula is hand-tuned: a linear
ramp from 0 at |p-0.5|=0.30 up to 0.40 at |p-0.5|=0.50. Two months of
live data shows the formula is way off — live actual loss rates run
60-85% at extreme prices vs the formula's ~20% prediction.

**Calibration method:**

1. Pull all REDEEM events from Activity API.
2. Join each REDEEM back to its source BUY (via slug → tokenId via TRADE
   events) to get the entry price.
3. Bucket by entry price (0.05 increments, both sides of 0.50).
4. Per bucket: count trades, compute live_loss_rate.
5. Assume sim's unbiased loss rate = 1 - sim_unbiased_win_rate, where
   sim_unbiased_win_rate is approximated by the empirical win rate at
   the SAME entry price in non-extreme buckets (interpolated). For
   buckets near the mid (0.45-0.55) where sim has historically tracked
   live well, the empirical rate IS the unbiased rate.
6. Solve for flip_prob:
       live_loss_rate = unbiased_loss_rate + flip_prob × (1 - unbiased_loss_rate)
       → flip_prob = (live_loss_rate - unbiased_loss_rate) / (1 - unbiased_loss_rate)
   Clipped to [0, 1].

**Schema (config/empirical_flip_prob.json):**

```
{
  "calibrated_at": "ISO timestamp",
  "n_trades": int,
  "buckets": [
    {"price_lo": 0.00, "price_hi": 0.05, "n": int, "live_loss_rate": float, "flip_prob": float},
    ...
  ],
  "fallback": "linear",      # if a bucket has < min_n samples
  "min_n": int,              # min samples per bucket to use empirical value
  "midband_unbiased_loss_rate": float  # baseline from 0.45-0.55 bucket
}
```

Usage:
  python3 scripts/calibrateLayer2.py            # print summary, dry-run
  python3 scripts/calibrateLayer2.py --write    # write the JSON
"""
from __future__ import annotations
import argparse, json, os, sys, urllib.request, datetime as dt
from collections import defaultdict
from pathlib import Path

DATA_DIR = Path(os.environ.get("QUANT_DATA_DIR", "data"))
CONFIG_DIR = Path(os.environ.get("QUANT_CONFIG_DIR", "config"))
LEDGER_PATH = DATA_DIR / "live_trades.jsonl"
OUTPUT_PATH = CONFIG_DIR / "empirical_flip_prob.json"

BUCKETS = [(round(i * 0.05, 2), round((i + 1) * 0.05, 2)) for i in range(20)]
MIN_N_PER_BUCKET = 5  # need ≥5 samples for a bucket's empirical rate to be trusted


def fetch_activity(funder: str, limit: int = 500) -> list[dict]:
    url = f"https://data-api.polymarket.com/activity?user={funder}&limit={limit}"
    req = urllib.request.Request(url, headers={"User-Agent": "qf-calibrate/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def collect_settled_trades(funder: str) -> list[dict]:
    """Returns [{entry_price, won}, ...] for every settled live trade."""
    events = fetch_activity(funder)
    # Build slug → token via TRADE events
    slug_to_token: dict[str, str] = {}
    trade_prices: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for e in events:
        if e.get("type") == "TRADE" and e.get("side") == "BUY":
            slug = e.get("slug", "")
            token = e.get("asset", "")
            price = float(e.get("price", 0))
            size = float(e.get("size", 0))
            if slug and token:
                slug_to_token[slug] = token
                trade_prices[token].append((price, size))

    # Aggregate per-token entry price (weighted by size)
    entry_price: dict[str, float] = {}
    for token, trades in trade_prices.items():
        total_size = sum(s for _, s in trades)
        if total_size > 0:
            entry_price[token] = sum(p * s for p, s in trades) / total_size

    # Each REDEEM → outcome of the underlying BUY
    out = []
    for e in events:
        if e.get("type") != "REDEEM":
            continue
        slug = e.get("slug", "")
        token = slug_to_token.get(slug)
        if not token or token not in entry_price:
            continue
        won = float(e.get("usdcSize", 0)) > 0
        out.append({"entry_price": entry_price[token], "won": won, "slug": slug})
    return out


def bucket_trades(trades: list[dict]) -> dict[tuple[float, float], dict]:
    out: dict[tuple[float, float], dict] = {}
    for lo, hi in BUCKETS:
        out[(lo, hi)] = {"n": 0, "wins": 0, "losses": 0}
    for t in trades:
        p = t["entry_price"]
        for lo, hi in BUCKETS:
            if lo <= p < hi or (p == 1.0 and hi == 1.0):
                b = out[(lo, hi)]
                b["n"] += 1
                if t["won"]:
                    b["wins"] += 1
                else:
                    b["losses"] += 1
                break
    return out


def compute_unbiased_baseline(buckets: dict[tuple[float, float], dict]) -> float:
    """Estimate sim's unbiased loss rate from midband (0.45-0.55).

    In this band sim has historically tracked live within sample noise,
    so we treat its empirical loss rate as the "true" rate. We invert:
    bias-induced loss probability at other prices is the excess over this.
    """
    mid_n = 0; mid_l = 0
    for (lo, hi), b in buckets.items():
        if lo >= 0.40 and hi <= 0.60:
            mid_n += b["n"]; mid_l += b["losses"]
    if mid_n == 0:
        return 0.50  # default — pure 50/50 binary
    return mid_l / mid_n


def calibrate(trades: list[dict]) -> dict:
    buckets = bucket_trades(trades)
    unbiased = compute_unbiased_baseline(buckets)
    out_buckets = []
    for (lo, hi), b in buckets.items():
        record = {
            "price_lo": lo, "price_hi": hi, "n": b["n"],
            "wins": b["wins"], "losses": b["losses"],
            "live_loss_rate": (b["losses"] / b["n"]) if b["n"] else None,
            "flip_prob": None,
        }
        if b["n"] >= MIN_N_PER_BUCKET:
            live_lr = b["losses"] / b["n"]
            # Solve: live_lr = unbiased + flip × (1 - unbiased)
            if unbiased < 1.0:
                fp = (live_lr - unbiased) / (1 - unbiased)
                record["flip_prob"] = max(0.0, min(1.0, fp))
            else:
                record["flip_prob"] = 0.0
        out_buckets.append(record)
    return {
        "calibrated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "n_trades": sum(b["n"] for b in out_buckets),
        "midband_unbiased_loss_rate": unbiased,
        "min_n_per_bucket": MIN_N_PER_BUCKET,
        "fallback": "linear",
        "buckets": out_buckets,
    }


def print_summary(cal: dict) -> None:
    print(f"=== Empirical Layer 2 calibration ({cal['n_trades']} trades, midband loss rate = {cal['midband_unbiased_loss_rate']:.2%}) ===\n")
    print(f"  {'price':<14} {'n':<5} {'W/L':<8} {'live_loss_rate':<16} {'flip_prob':<11} note")
    print("  " + "-" * 80)
    for b in cal["buckets"]:
        rng = f"{b['price_lo']:.2f}-{b['price_hi']:.2f}"
        wl = f"{b['wins']}/{b['losses']}"
        lr = f"{b['live_loss_rate']:.2%}" if b['live_loss_rate'] is not None else "—"
        fp = f"{b['flip_prob']:.2f}" if b['flip_prob'] is not None else "fallback"
        note = "" if b['n'] >= cal['min_n_per_bucket'] else f"(n<{cal['min_n_per_bucket']}, uses fallback)"
        if b['n'] > 0:
            print(f"  {rng:<14} {b['n']:<5} {wl:<8} {lr:<16} {fp:<11} {note}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="Write JSON to config/empirical_flip_prob.json")
    args = ap.parse_args()

    funder = os.environ.get("FUNDER") or os.environ.get("PM_FUNDER")
    if not funder:
        print("error: FUNDER env var required", file=sys.stderr)
        return 1

    trades = collect_settled_trades(funder)
    if not trades:
        print("no settled trades found in Activity API", file=sys.stderr)
        return 1

    cal = calibrate(trades)
    print_summary(cal)

    if args.write:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        tmp = OUTPUT_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(cal, indent=2))
        os.rename(tmp, OUTPUT_PATH)
        print(f"\nwrote {OUTPUT_PATH}")
    else:
        print(f"\nDRY RUN — pass --write to save to {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
