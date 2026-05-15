import { AbstractEngine } from "./BaseEngine";
import { startPolling, getCrossAssetReturn } from "../live/crossAssetPrices";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * BTC-ETH lag-catch divergence engine.
 *
 * BTC and ETH are highly correlated (~0.85 over short horizons). When their
 * 1h returns diverge significantly (one moved, the other lagged), the
 * laggard tends to catch up over the following hours. We bet the laggard's
 * direction on the next 4h candle.
 *
 * Fires only on 4h arenas — gives the catch-up enough time to play out.
 *
 * Mechanism per arena:
 *   - my coin's 1h return = `recentMomentum(3600)`
 *   - other coin's 1h return = cross-asset poller cache
 *   - if abs(diff) > MIN_DIVERGENCE_BPS, bet the laggard
 *   - alpha-zone gate ([0.40, 0.70]) on the entry price
 *
 * Skipped: SOL arenas — SOL's correlation with BTC/ETH is weaker and the
 * lag-catch isn't as clean. (Could re-enable as a v2 if data supports it.)
 */
export class BtcEthDivergenceEngine extends AbstractEngine {
  id = "btc-eth-divergence-v1";
  name = "BTC-ETH Divergence";
  version = "1.0.0";

  private readonly minDivergenceBps =
    Number(process.env.DIVERGENCE_MIN_BPS) || 30;
  private readonly minRemainingSec =
    Number(process.env.DIVERGENCE_MIN_REMAINING_SEC) || 7200;
  private readonly maxCashPct = 0.20;
  private startedPolling = false;

  onTick(
    tick: MarketTick,
    state: EngineState,
    _signals?: SignalSnapshot,
  ): EngineAction[] {
    if (tick.source === "binance") this.trackBinance(tick);
    if (tick.source !== "polymarket") return [];

    if (!this.startedPolling) {
      startPolling();
      this.startedPolling = true;
    }

    // 4h arenas only
    if (this.candleSeconds() !== 14400) return [];

    this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];
    this.clearStalePositions();

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    const remaining = this.getSecondsRemaining();
    if (remaining < this.minRemainingSec) return [];

    const myMomentum = this.recentMomentum(3600);
    const symbol = this.getMarketSymbol();
    let otherSymbol: string | null = null;
    if (symbol === "BTCUSDT") otherSymbol = "ETHUSDT";
    else if (symbol === "ETHUSDT") otherSymbol = "BTCUSDT";
    if (!otherSymbol) return []; // SOL or unknown — skip

    const otherMomentum = getCrossAssetReturn(otherSymbol, 3600);
    if (otherMomentum === null) return [];
    if (myMomentum === 0 && otherMomentum === 0) return [];

    const divergenceBps = Math.abs(myMomentum - otherMomentum) * 10000;
    if (divergenceBps < this.minDivergenceBps) return [];

    // Laggard catches up: if my coin underperformed, bet UP on this candle.
    const buyUp = myMomentum < otherMomentum;
    const tokenId = buyUp ? upTokenId : downTokenId;

    const book = this.getBookForToken(tokenId);
    if (!this.isBookTradeable(book)) return [];
    const ask = book.asks[0]?.price ?? 0;
    if (ask < 0.40 || ask > 0.70) return [];

    const edge = this.feeAdjustedEdge(0.62, ask);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / ask);
    if (shares < 5) return [];

    this.markPending(tokenId);
    return [
      this.buy(tokenId, ask, shares, {
        orderType: "taker",
        note: `btc-eth-div: ${buyUp ? "UP" : "DOWN"} @ ${ask.toFixed(3)}, div=${divergenceBps.toFixed(0)}bps (mine=${(myMomentum * 10000).toFixed(0)}bps other=${(otherMomentum * 10000).toFixed(0)}bps)`,
        signalSource: "btc_eth_divergence",
      }),
    ];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
