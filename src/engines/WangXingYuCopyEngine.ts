import { AbstractEngine } from "./BaseEngine";
import {
  refreshIfStale,
  getSignalForToken,
  markConsumed,
} from "../live/wangXingYuActivity";
import type {
  EngineAction,
  EngineState,
  MarketTick,
  SignalSnapshot,
} from "../types";

/**
 * WangXingYu copy-trade engine — fires the same direction WangXingYu just
 * fired on the current arena's candle. Holds to settle.
 *
 * Wallet `0x4c353dd347c2e7d8bcdc5cd6ee569de7baf23e2f` showed 96% WR on 865
 * closed BTC candle positions and +$2,797,871 realized P&L over 82 days
 * (2026-02-10 → 2026-05-03), across 5m/15m/1h/4h resolutions. They almost
 * never sell (1% sell ratio) and never buy above $0.70. See
 * `docs/whale_analysis_2026-05-13.md` (May 14 PM section).
 *
 * Strategy: trust their signal directly. Match by tokenId — when our current
 * arena's UP or DOWN token matches a recent BUY in their activity feed, we
 * fire the same side at trial size and hold. No exit logic — the candle
 * resolution closes the position.
 *
 * Two gates beyond signal-match:
 *   1. `MIN_REMAINING_SEC` — skip if there's not enough candle time left for
 *      our poll/fill latency to be safe (default 90s, matches 25% miss rate
 *      on 5m candles per the timing analysis).
 *   2. `fee-adjusted edge` at modelProb=0.85. Their 96% WR justifies a high
 *      posterior, but 0.85 leaves margin for execution slippage and rejects
 *      fires above ~$0.80 even if they somehow fired there.
 */
export class WangXingYuCopyEngine extends AbstractEngine {
  id = "wangxingyu-copy-v1";
  name = "WangXingYu Copy";
  version = "1.0.0";

  private readonly maxCashPct = 0.20;
  private readonly minRemainingSec =
    Number(process.env.WANGXINGYU_COPY_MIN_REMAINING_SEC) || 90;
  private readonly maxSignalAgeSec =
    Number(process.env.WANGXINGYU_COPY_MAX_SIGNAL_AGE_SEC) || 600;
  private readonly modelProb =
    Number(process.env.WANGXINGYU_COPY_MODEL_PROB) || 0.85;

  onTick(
    tick: MarketTick,
    state: EngineState,
    _signals?: SignalSnapshot,
  ): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    // Non-blocking poll. Returns immediately; next tick sees the result.
    refreshIfStale();

    this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];
    this.clearStalePositions();

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) {
      return [];
    }

    // Match either side
    const upSig = getSignalForToken(upTokenId);
    const downSig = getSignalForToken(downTokenId);
    const sig = upSig ?? downSig;
    if (!sig) return [];
    const tokenId = upSig ? upTokenId : downTokenId;
    const side: "UP" | "DOWN" = upSig ? "UP" : "DOWN";

    // Stale signal? (their buy was long ago — candle probably resolved)
    const nowSec = Math.floor(Date.now() / 1000);
    const signalAgeSec = nowSec - sig.ts;
    if (signalAgeSec > this.maxSignalAgeSec) {
      markConsumed(tokenId);
      return [];
    }

    // Not enough remaining time in our current candle window for our latency.
    // `-1` means window data is missing — treat as "unsafe to fire" rather
    // than "infinite time remaining" (fixes silent-fire on missing state).
    const remaining = this.getSecondsRemaining();
    if (remaining < 0 || remaining < this.minRemainingSec) {
      markConsumed(tokenId);
      return [];
    }

    const book = this.getBookForToken(tokenId);
    if (!this.isBookTradeable(book)) return [];
    const ask = book.asks[0]?.price ?? 0;
    if (ask <= 0 || ask >= 0.95) return [];

    const edge = this.feeAdjustedEdge(this.modelProb, ask);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / ask);
    if (shares < 5) return [];

    markConsumed(tokenId);
    this.markPending(tokenId);
    return [
      this.buy(tokenId, ask, shares, {
        orderType: "taker",
        note: `wangxingyu-copy: ${side} @ ${ask.toFixed(3)} (their fill @ ${sig.price.toFixed(3)}, ${signalAgeSec}s lag)`,
        signalSource: "wangxingyu_copy",
      }),
    ];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
