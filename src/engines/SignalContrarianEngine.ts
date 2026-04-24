import { AbstractEngine } from "./BaseEngine";
import { getBookForToken } from "../pulse";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

export interface SignalBias {
  side: "UP" | "DOWN" | null;
  confirmed: boolean; // true when both gates agree
  fngFired: boolean;
  fundingFired: boolean;
}

/**
 * Pure decision function: given F&G value (0-100) and funding rate (decimal),
 * return which side to fade and whether both signals confirm each other.
 *
 * Contrarian interpretation:
 *  - F&G ≥ 75 (extreme greed)  → fade DOWN
 *  - F&G ≤ 25 (extreme fear)   → buy UP
 *  - Funding > +0.02% (longs paying) → fade DOWN
 *  - Funding < -0.02% (shorts paying) → buy UP
 *
 * If both gates fire and disagree, return side=null (ambiguous, skip).
 * If neither fires, return side=null (no edge).
 */
export function computeSignalBias(
  fng: number | null | undefined,
  fundingRate: number | null | undefined,
): SignalBias {
  let fngBias: "UP" | "DOWN" | null = null;
  if (fng != null) {
    if (fng >= 75) fngBias = "DOWN";
    else if (fng <= 25) fngBias = "UP";
  }

  let fundingBias: "UP" | "DOWN" | null = null;
  if (fundingRate != null) {
    if (fundingRate > 0.0002) fundingBias = "DOWN";
    else if (fundingRate < -0.0002) fundingBias = "UP";
  }

  const fngFired = fngBias !== null;
  const fundingFired = fundingBias !== null;

  if (!fngFired && !fundingFired) {
    return { side: null, confirmed: false, fngFired, fundingFired };
  }
  if (fngBias && fundingBias && fngBias !== fundingBias) {
    return { side: null, confirmed: false, fngFired, fundingFired };
  }
  const side = fngBias ?? fundingBias!;
  const confirmed = fngFired && fundingFired; // already know they agree
  return { side, confirmed, fngFired, fundingFired };
}

/**
 * First engine to actually read SignalSnapshot. Thesis: the market's leading
 * side is priced 60-75¢ because the crowd thinks it wins. When macro signals
 * say the crowd is overheated (F&G extreme, funding skewed), fade the crowd.
 *
 * Three gates, contrarian interpretation:
 *  - F&G ≥ 75 (extreme greed)  → bias DOWN (fade the euphoria)
 *  - F&G ≤ 25 (extreme fear)   → bias UP (fade the despair)
 *  - Funding > +0.02% (longs crowded, paying shorts) → bias DOWN
 *  - Funding < -0.02% (shorts crowded)              → bias UP
 *
 * When BOTH gates agree (e.g. greed + positive funding), fire with higher
 * confidence. When they disagree or both neutral, skip.
 *
 * Entry mechanics mirror momentum-settle (60-75¢ band, maker offset 1.5¢
 * below ask, hold to settle). Differs only in side selection.
 */
export class SignalContrarianEngine extends AbstractEngine {
  id = "signal-contrarian-v1";
  name = "Signal Contrarian";
  version = "1.0.0";

  private readonly entryMin = 0.60;
  private readonly entryMax = 0.75;
  private readonly baseCashPct = 0.20;
  private readonly confirmedCashPct = 0.30; // when both gates agree

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];
    if (!signals) return []; // can't run without signals

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    const bias = computeSignalBias(signals.fearGreed?.value, signals.funding?.rate);
    if (!bias.side) return [];
    const side = bias.side;
    const confirmed = bias.confirmed;
    const fng = signals.fearGreed?.value ?? -1;
    const fundingRate = signals.funding?.rate ?? 0;

    const tokenId = side === "UP" ? upTokenId : downTokenId;
    const book = getBookForToken(tokenId);
    const askPrice = book.asks[0]?.price ?? 0;
    if (askPrice < this.entryMin || askPrice > this.entryMax) return [];

    const edge = this.feeAdjustedEdge(confirmed ? 0.72 : 0.68, askPrice);
    if (!edge.profitable) return [];

    const cashPct = confirmed ? this.confirmedCashPct : this.baseCashPct;
    const makerPrice = Math.round((askPrice - 0.015) * 1000) / 1000;
    const shares = Math.floor((state.cashBalance * cashPct) / askPrice);
    if (shares < 5) return [];

    const bestAsk = book.asks[0]?.price ?? 0;
    if (makerPrice >= bestAsk) {
      // Spread too tight — fall back to taker
      this.markPending(tokenId);
      return [this.buy(tokenId, askPrice, shares, {
        orderType: "taker",
        note: `signal-contrarian: taker ${side} @ ${askPrice.toFixed(3)} fng=${fng} fund=${(fundingRate*100).toFixed(4)}% conf=${confirmed}`,
        signalSource: "signal_contrarian",
      })];
    }

    this.markPending(tokenId);
    return [this.buy(tokenId, makerPrice, shares, {
      orderType: "maker",
      note: `signal-contrarian: maker ${side} @ ${makerPrice.toFixed(3)} fng=${fng} fund=${(fundingRate*100).toFixed(4)}% conf=${confirmed}`,
      signalSource: "signal_contrarian",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
