import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * VolRegimeGateV2 — Claude's enhancement of vol-regime-gate-v1.
 *
 * The v1 thesis is sound: vol5m/vol1h ratio detects regime transitions.
 * What v1 misses:
 *   - Single-tick decision (one bad signals fetch fires us)
 *   - Constant modelProb regardless of signal STRENGTH
 *   - Entry bands rigid (60-75c / 25-40c) regardless of ratio extremity
 *   - No directional check — EXPAND mode picks "the leader" but doesn't
 *     verify Binance is actually moving that way
 *   - Fires anywhere in the candle, including the last 30s where
 *     settlement-prediction noise dominates
 *
 * v2 enhancements (5 of them, each with its own justification):
 *
 * (1) Ratio history — require the regime label to hold for 3 consecutive
 *     signal samples (= ~45s at 15s fetch cadence). One-tick spike is noise.
 *
 * (2) Direction-confirmed EXPAND — in EXPAND mode, also check Binance
 *     recent momentum and only fire if vol+momentum agree. If vol is
 *     expanding but Binance is flat, we're not in a directional regime,
 *     it's just noisy chop.
 *
 * (3) Adaptive modelProb — instead of constant 0.70/0.55, scale with the
 *     ratio's distance from the threshold. Bigger ratio = stronger signal
 *     = higher confidence. Bounded so we don't overconfidence into the
 *     fee curve.
 *
 * (4) Time-in-candle gate — skip the last 30s of any candle (settlement
 *     prediction window where MMs do crazy things and our directional
 *     signal carries less info than the imminent-resolution outcome).
 *
 * (5) Adaptive entry band — ratio further from threshold widens the
 *     accepted entry-price band. Strong EXPAND can take leader at 55-78c
 *     not just 60-75c. Strong COMPRESS can grab underdog at 20-45c.
 *
 * Why these 5 specifically: each addresses a SPECIFIC observed weakness
 * in v1's behavior, not just "more gates". Adding gates without thought
 * makes engines never-fire.
 */
export class VolRegimeGateV2Engine extends AbstractEngine {
  id = "vol-regime-gate-v2";
  name = "Vol Regime Gate v2 (multi-confirm)";
  version = "2.0.0";

  private readonly expandThreshold = 1.3;
  private readonly compressThreshold = 0.6;
  private readonly maxCashPct = 0.15;
  private readonly minCandleSecondsLeft = 30; // skip last 30s
  private readonly minMomentumExpandBps = 5;  // Binance must show 5bps move for EXPAND
  private readonly persistenceSamples = 3;    // 3 consecutive signal samples in same mode

  // Sample-by-sample mode history. Pushed when signals.realizedVol arrives.
  // Keeps last 5 samples; we look at last `persistenceSamples` for a vote.
  private modeHistory: ("EXPAND" | "COMPRESS" | "NEUTRAL")[] = [];
  private lastSampleTimestamp = 0;

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];
    if (!signals?.realizedVol) return [];
    this.trackBinance(tick);

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    // Time-in-candle gate (4)
    const secsLeft = this.getSecondsRemaining();
    if (secsLeft >= 0 && secsLeft < this.minCandleSecondsLeft) return [];

    // Sample mode + push to history if signals updated since last push
    const vol5m = signals.realizedVol.vol5m;
    const vol1h = signals.realizedVol.vol1h;
    if (!vol5m || !vol1h) return [];
    const ratio = vol5m / vol1h;
    const sampleTs = signals.timestamp ?? Date.now();
    if (sampleTs !== this.lastSampleTimestamp) {
      const mode = ratio > this.expandThreshold ? "EXPAND"
                 : ratio < this.compressThreshold ? "COMPRESS"
                 : "NEUTRAL";
      this.modeHistory.push(mode);
      while (this.modeHistory.length > 5) this.modeHistory.shift();
      this.lastSampleTimestamp = sampleTs;
    }

    // Persistence check (1) — require last N samples to all be the same non-NEUTRAL mode
    if (this.modeHistory.length < this.persistenceSamples) return [];
    const recent = this.modeHistory.slice(-this.persistenceSamples);
    const target = recent[0];
    if (target === "NEUTRAL") return [];
    if (!recent.every(m => m === target)) return [];
    const mode: "EXPAND" | "COMPRESS" = target;

    // Direction-confirmed EXPAND (2): for EXPAND mode, also need Binance momentum
    if (mode === "EXPAND") {
      const mom = this.recentMomentum(60); // ratio over 60s, ~1.0 = flat
      const momBps = (mom - 1) * 10000;
      if (Math.abs(momBps) < this.minMomentumExpandBps) return [];
    }

    const upBook = this.getBookForToken(upTokenId);
    const downBook = this.getBookForToken(downTokenId);
    if (!this.isBookTradeable(upBook) || !this.isBookTradeable(downBook)) return [];
    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    // Adaptive band (5): widen with ratio extremity
    const ratioStrength = mode === "EXPAND"
      ? Math.min(1, (ratio - this.expandThreshold) / 0.7)   // 0..1 over [1.3 .. 2.0]
      : Math.min(1, (this.compressThreshold - ratio) / 0.5); // 0..1 over [0.6 .. 0.1]
    // EXPAND: leader band [60-75] tightest, widens to [55-78] on strongest
    // COMPRESS: underdog band [25-40] tightest, widens to [20-45]
    const leaderMin = mode === "EXPAND" ? 0.60 - 0.05 * ratioStrength : 0;
    const leaderMax = mode === "EXPAND" ? 0.75 + 0.03 * ratioStrength : 0;
    const underdogMin = mode === "COMPRESS" ? 0.25 - 0.05 * ratioStrength : 0;
    const underdogMax = mode === "COMPRESS" ? 0.40 + 0.05 * ratioStrength : 0;

    let tokenId = "";
    let askPrice = 0;
    if (mode === "EXPAND") {
      const upQual = upAsk >= leaderMin && upAsk <= leaderMax;
      const downQual = downAsk >= leaderMin && downAsk <= leaderMax;
      if (!upQual && !downQual) return [];
      // Tie-break: pick whichever side aligns with Binance momentum direction
      const mom = this.recentMomentum(60);
      const binanceUp = mom > 1.0;
      if (upQual && downQual) {
        // Both qualify — pick the side Binance is moving toward
        if (binanceUp) { tokenId = upTokenId; askPrice = upAsk; }
        else { tokenId = downTokenId; askPrice = downAsk; }
      } else if (upQual) { tokenId = upTokenId; askPrice = upAsk; }
      else { tokenId = downTokenId; askPrice = downAsk; }
    } else {
      const upQual = upAsk >= underdogMin && upAsk <= underdogMax;
      const downQual = downAsk >= underdogMin && downAsk <= underdogMax;
      if (!upQual && !downQual) return [];
      // Tie-break: pick the cheaper underdog (more upside)
      if (upQual && (!downQual || upAsk < downAsk)) { tokenId = upTokenId; askPrice = upAsk; }
      else { tokenId = downTokenId; askPrice = downAsk; }
    }

    // Adaptive modelProb (3): scale with ratio strength, but bounded
    // EXPAND: base 0.65, up to 0.78 at max strength
    // COMPRESS: base 0.52, up to 0.62 at max strength
    const modelProb = mode === "EXPAND"
      ? 0.65 + 0.13 * ratioStrength
      : 0.52 + 0.10 * ratioStrength;

    const edge = this.feeAdjustedEdge(modelProb, askPrice);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / askPrice);
    if (shares < 5) return [];

    // Reset history after firing — don't re-fire on the same persistent regime
    this.modeHistory.length = 0;
    this.markPending(tokenId);
    return [this.buy(tokenId, askPrice, shares, {
      orderType: "taker",
      note: `vol-regime-v2: ${mode} ratio=${ratio.toFixed(2)} strength=${ratioStrength.toFixed(2)} prob=${modelProb.toFixed(2)} @ ${askPrice.toFixed(3)}`,
      signalSource: "vol_regime_v2",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
    this.modeHistory.length = 0;
    this.lastSampleTimestamp = 0;
  }
}
