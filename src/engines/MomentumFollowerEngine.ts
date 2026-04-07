/**
 * Momentum Follower Engine
 *
 * Strategy: Track Binance spot movement over a rolling window.
 * If BTC is trending UP and PM Up price hasn't caught up → buy UP.
 * If BTC is trending DOWN and PM Down price is cheap → buy DOWN (sell UP).
 *
 * Key insight: 5M markets lag Binance by seconds. The edge is in
 * the speed gap between Binance moving and PM repricing.
 *
 * Exit: take profit at 15% or dump position with 90s left (don't hold to resolution).
 */

import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

export class MomentumFollowerEngine extends AbstractEngine {
  id = "momentum-follower-v1";
  name = "Momentum Follower";
  version = "1.0.0";

  // Binance price tracking
  private binancePrices: number[] = [];
  private readonly windowSize = 30;       // track last 30 Binance ticks (~3s at 100ms)
  private lastPmMid = 0;

  // Position tracking
  private entryTime = 0;
  private readonly maxHoldMs = 210_000;   // dump after 3.5 min (leave 90s buffer before 5M expiry)
  private readonly takeProfitPct = 0.15;  // 15% TP
  private readonly stopLossPct = -0.20;   // 20% SL
  private readonly maxPositionPct = 0.30; // risk 30% of bankroll per trade

  // Entry thresholds
  private readonly minMomentum = 0.0003;  // 3bps Binance move over window
  private readonly minPmLag = 0.03;       // PM must lag by at least 3% vs implied direction
  private readonly minEdgeAfterFee = 0.01;

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    const tokenId = state.activeTokenId;
    if (!tokenId) return [];

    // ── Track Binance prices ──
    if (tick.source === "binance" && tick.symbol.toUpperCase().startsWith("BTC")) {
      this.binancePrices.push(tick.midPrice);
      if (this.binancePrices.length > this.windowSize) {
        this.binancePrices.shift();
      }
      return [];
    }

    if (tick.source !== "polymarket") return [];
    this.lastPmMid = tick.midPrice;

    // Need enough Binance data
    if (this.binancePrices.length < 10) return [];

    const pos = this.getPosition(tokenId);

    // ── Exit logic ──
    if (pos && pos.shares > 0) {
      const holdTime = Date.now() - this.entryTime;
      const unrealizedPct = (tick.midPrice - pos.avgEntry) / pos.avgEntry;

      // Take profit
      if (unrealizedPct >= this.takeProfitPct) {
        return [this.sell(tokenId, tick.bestBid, pos.shares, {
          note: `TP: ${(unrealizedPct * 100).toFixed(1)}% in ${(holdTime / 1000).toFixed(0)}s`,
          signalSource: "momentum_tp",
        })];
      }

      // Stop loss
      if (unrealizedPct <= this.stopLossPct) {
        return [this.sell(tokenId, tick.bestBid, pos.shares, {
          note: `SL: ${(unrealizedPct * 100).toFixed(1)}%`,
          signalSource: "momentum_sl",
        })];
      }

      // Time exit — dump before resolution (don't gamble on binary outcome)
      if (holdTime > this.maxHoldMs) {
        const exit = this.cheapestExit(tick.midPrice, pos.shares);
        if (exit.method === "MERGE") {
          return [this.merge(tokenId, pos.shares, {
            note: `time exit via merge, saves $${exit.savings.toFixed(4)}`,
            signalSource: "momentum_time_exit",
          })];
        }
        return [this.sell(tokenId, tick.bestBid, pos.shares, {
          note: `time exit: ${(holdTime / 1000).toFixed(0)}s held`,
          signalSource: "momentum_time_exit",
        })];
      }

      return [];
    }

    // ── Entry logic: Binance momentum vs PM lag ──
    const oldest = this.binancePrices[0];
    const newest = this.binancePrices[this.binancePrices.length - 1];
    const momentum = (newest - oldest) / oldest; // % change over window

    if (Math.abs(momentum) < this.minMomentum) return [];

    const pmMid = tick.midPrice;
    const btcGoingUp = momentum > 0;

    // If BTC going up, UP (Yes) should be > 0.50. The lag is how much PM is below implied.
    // If BTC going down, UP (Yes) should be < 0.50. The lag is how much PM is above implied.
    let pmLag: number;
    let shouldBuyUp: boolean;

    let buyTokenId: string;
    let buyPrice: number;

    if (btcGoingUp) {
      // BTC rising → UP should be expensive, Down cheap
      // If PM Up is still cheap (< 0.55 when it should be 0.70+), buy UP
      pmLag = 0.50 + Math.abs(momentum) * 100 - pmMid; // rough: bigger momentum = more implied UP
      shouldBuyUp = pmLag > this.minPmLag && pmMid < 0.75; // don't chase above 0.75
      if (!shouldBuyUp) return [];
      buyTokenId = tokenId;
      buyPrice = tick.bestAsk;
    } else {
      // BTC falling → buy the DOWN (NO) token
      const downTokenId = this.getDownTokenId();
      if (!downTokenId) return [];

      const downPrice = 1 - pmMid; // DOWN price is complement of UP price
      pmLag = 0.50 + Math.abs(momentum) * 100 - downPrice;
      if (pmLag < this.minPmLag || downPrice > 0.75) return [];
      buyTokenId = downTokenId;
      buyPrice = downPrice;
    }

    // Fee check
    const edge = this.feeAdjustedEdge(buyPrice + pmLag, buyPrice);
    if (!edge.profitable || edge.netEdge < this.minEdgeAfterFee) return [];

    // Size
    const maxUsd = state.cashBalance * this.maxPositionPct;
    const shares = Math.floor(maxUsd / buyPrice);
    if (shares < 5) return [];

    this.entryTime = Date.now();

    const direction = btcGoingUp ? "UP" : "DOWN";
    return [this.buy(buyTokenId, buyPrice, shares, {
      note: `mom=${(momentum * 10000).toFixed(0)}bps ${direction}, lag=${(pmLag * 100).toFixed(1)}%, pm=${pmMid.toFixed(3)}`,
      signalSource: "binance_momentum_lag",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.binancePrices = [];
    this.lastPmMid = 0;
    this.entryTime = 0;
  }
}
