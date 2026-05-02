#!/usr/bin/env python3
"""Portfolio drawdown safety net — auto-halts live trading on big realized losses.

Sums SETTLE rows from data/live_trades.jsonl over a rolling lookback window.
If realized P&L is below -PORTFOLIO_HALT_LOSS_USD, touches data/live_halt.flag
and logs the decision. User must manually `rm data/live_halt.flag` to resume.

Why realized (not MTM): MTM oscillates to $0 on every settle (positions zero
out at resolution), causing false alarms. Realized P&L from settled trades
is the honest signal — the wallet actually lost or won this much in the window.

Built after the May 2 2026 incident: portfolio dropped $92 → $40 (-56%) in
~24h with only per-engine bankroll caps as protection. This adds a single
system-level circuit breaker.

Cron: */5 * * * *  cd ~/quant-arena && python3 scripts/portfolioHaltWatcher.py

Env knobs:
  PORTFOLIO_HALT_LOSS_USD       default 25 (halt at >$25 realized loss in window)
  PORTFOLIO_HALT_LOOKBACK_HOURS default 12 (sliding window for realized PnL sum)
  QUANT_DATA_DIR                default "data"
"""
from __future__ import annotations
import argparse, os, sys
import datetime as dt
from pathlib import Path

# Reuse the shared aggregator that livePnLByEngine + liveStatus use.
from _live_ledger import LEDGER_PATH, aggregate, read_rows

DATA_DIR = Path(os.environ.get("QUANT_DATA_DIR", "data"))
HALT_FLAG = DATA_DIR / "live_halt.flag"
LOG_PATH = DATA_DIR / "portfolio_halt.log"
LOSS_THRESHOLD_USD = float(os.environ.get("PORTFOLIO_HALT_LOSS_USD", "25"))
LOOKBACK_HOURS = float(os.environ.get("PORTFOLIO_HALT_LOOKBACK_HOURS", "12"))


def log(msg: str) -> None:
    ts = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    line = f"[{ts}] {msg}"
    print(line)
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a") as f:
            f.write(line + "\n")
    except OSError as e:
        print(f"  (log write failed: {e})", file=sys.stderr)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="report state but don't touch halt flag")
    args = ap.parse_args()

    if not LEDGER_PATH.exists():
        log("no ledger file — skipping (no halt action taken)")
        return 0

    rows = read_rows(LEDGER_PATH, since=f"{int(LOOKBACK_HOURS)}h")
    per_pair = aggregate(rows)
    realized_total = sum(s["realized"] for s in per_pair.values())
    fires = sum(s["buys"] for s in per_pair.values())
    settles = sum(s["wins"] + s["losses"] for s in per_pair.values())

    if fires == 0 and settles == 0:
        log(f"no trading activity in last {LOOKBACK_HOURS:.0f}h — skipping")
        return 0

    log(f"realized={realized_total:+.2f} over {LOOKBACK_HOURS:.0f}h ({fires} fires, {settles} settles)")

    if realized_total < -LOSS_THRESHOLD_USD:
        if HALT_FLAG.exists():
            log(f"  realized loss ${-realized_total:.2f} > ${LOSS_THRESHOLD_USD:.0f} threshold — halt flag already set")
        elif args.dry_run:
            log(f"  DRY-RUN — would set halt flag (loss ${-realized_total:.2f} > ${LOSS_THRESHOLD_USD:.0f})")
        else:
            HALT_FLAG.touch()
            log(f"  *** HALT TRIGGERED *** realized loss ${-realized_total:.2f} exceeds ${LOSS_THRESHOLD_USD:.0f} threshold over last {LOOKBACK_HOURS:.0f}h")
            log(f"  live_halt.flag created — investigate before removing manually")

    return 0


if __name__ == "__main__":
    sys.exit(main())
