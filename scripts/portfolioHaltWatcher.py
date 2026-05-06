#!/usr/bin/env python3
"""Portfolio drawdown safety net — auto-halts live trading on big losses.

Combines two signals to halt the wallet on adverse moves:

1. Realized P&L: SETTLE rows from data/live_trades.jsonl summed over a
   rolling lookback window. The honest "wallet actually lost this much."

2. Open MTM exposure: sum of unsettled position cost basis from the
   ledger. Even if nothing has settled yet, deeply underwater positions
   should count toward halt — otherwise we miss the May 6 pattern where
   2 trial engines opened simultaneously and both bled before any settle.

Halt fires when:  realized + min(0, mtm_loss) < -PORTFOLIO_HALT_LOSS_USD

`mtm_loss` is the difference between current open-position cost basis
and a "fair" estimate (using avg fill price). If we don't have a market
data feed, mtm_loss defaults to 0 — realized-only mode preserves the
old behavior.

Built incrementally:
- May 2 2026: realized-only watcher after -$52 in 24h drawdown
- May 6 2026: added open-MTM tracking + lower threshold after the $52 loss
  came BEFORE realized P&L caught it (positions stuck open underwater)

Cron: */5 * * * *  cd ~/quant-arena && python3 scripts/portfolioHaltWatcher.py

Env knobs:
  PORTFOLIO_HALT_LOSS_USD       default 15 (was 25; tightened May 6)
  PORTFOLIO_HALT_LOOKBACK_HOURS default 6  (was 12; tightened May 6)
  PORTFOLIO_HALT_INCLUDE_MTM    default true (set false to disable open-MTM signal)
  QUANT_DATA_DIR                default "data"
"""
from __future__ import annotations
import argparse, os, sys
import datetime as dt
from pathlib import Path

from _live_ledger import LEDGER_PATH, aggregate, read_rows

DATA_DIR = Path(os.environ.get("QUANT_DATA_DIR", "data"))
HALT_FLAG = DATA_DIR / "live_halt.flag"
LOG_PATH = DATA_DIR / "portfolio_halt.log"
LOSS_THRESHOLD_USD = float(os.environ.get("PORTFOLIO_HALT_LOSS_USD", "15"))
LOOKBACK_HOURS = float(os.environ.get("PORTFOLIO_HALT_LOOKBACK_HOURS", "6"))
INCLUDE_MTM = os.environ.get("PORTFOLIO_HALT_INCLUDE_MTM", "true").lower() == "true"


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

    # Open MTM: sum of cost basis for unsettled positions across all engines.
    # Conservative — assumes worst case is total loss of cost basis. The
    # threshold should account for this (we're saying "if we'd lose this much
    # AND have already lost realized X, halt"). Doesn't replace MTM-via-book
    # but doesn't need market data either.
    open_exposure = sum(s["open_stake"] for s in per_pair.values()) if INCLUDE_MTM else 0
    # Pessimistic MTM: assume open positions are 50% impaired (rough proxy
    # without per-position market data). Tunable; a more accurate version
    # would query Polymarket /positions for curPrice.
    open_mtm_loss = -open_exposure * 0.5 if INCLUDE_MTM else 0
    combined_loss = realized_total + open_mtm_loss

    if fires == 0 and settles == 0 and open_exposure == 0:
        log(f"no trading activity in last {LOOKBACK_HOURS:.0f}h — skipping")
        return 0

    log(f"realized={realized_total:+.2f} open_exposure=${open_exposure:.2f} "
        f"mtm_assumed=${open_mtm_loss:+.2f} combined=${combined_loss:+.2f} "
        f"({fires} fires, {settles} settles, window={LOOKBACK_HOURS:.0f}h)")

    if combined_loss < -LOSS_THRESHOLD_USD:
        if HALT_FLAG.exists():
            log(f"  combined loss ${-combined_loss:.2f} > ${LOSS_THRESHOLD_USD:.0f} — halt flag already set")
        elif args.dry_run:
            log(f"  DRY-RUN — would set halt flag (loss ${-combined_loss:.2f} > ${LOSS_THRESHOLD_USD:.0f})")
        else:
            HALT_FLAG.touch()
            log(f"  *** HALT TRIGGERED *** combined loss ${-combined_loss:.2f} exceeds ${LOSS_THRESHOLD_USD:.0f} threshold")
            log(f"  realized={realized_total:+.2f}, open_exposure=${open_exposure:.2f} (assumed -50% MTM)")
            log(f"  live_halt.flag created — investigate before removing manually")

    return 0


if __name__ == "__main__":
    sys.exit(main())
