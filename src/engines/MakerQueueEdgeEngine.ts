import { AbstractEngine } from "./BaseEngine";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * MakerQueueEdgeEngine
 *
 * Thesis: when the PM book is DEEP (>200 shares at best bid) and STABLE
 * (low quote velocity), posting a maker BUY one tick under the best bid
 * has favorable queue dynamics. Deep+stable means market makers are
 * confidently quoting and not actively repricing — our limit will get
 * picked off only by an aggressive taker, and only when we're at a
 * better price than the rest of the queue (we joined cheaper).
 *
 * Pure microstructure play. Lower fire rate than other engines but
 * very low downside variance because:
 *  1. We only fire when we can post BELOW the bid (so we get rebate)
 *  2. We only fire on deep stable books (favorable adverse-selection)
 *  3. The spread offset means our limit only fills if the bid moves
 *     to us, i.e. price drops into our limit. Either we get a great
 *     price and likely hold to settle for profit, or we don't fill.
 *
 * Gates:
 *  - depthAtBestBid > 200 (deep book)
 *  - quoteVelocity < 5 over 10s (stable, not churning)
 *  - spread > 1¢ (room to post inside spread)
 *  - leading-side ask in 50-75¢ band (mid-range, not extremes)
 *  - 5-share min, 15% cash cap
 */
export class MakerQueueEdgeEngine extends AbstractEngine {
  id = "maker-queue-edge-v1";
  name = "Maker Queue Edge";
  version = "1.0.0";

  private readonly minDepth = 200;       // shares at best bid
  private readonly maxVelocity = 5;      // book updates in last 10s
  private readonly minSpreadBps = 100;   // 1¢ at $0.50 mid = 200 bps; 0.5¢ = 100 bps
  private readonly entryMin = 0.50;
  private readonly entryMax = 0.75;
  private readonly maxCashPct = 0.15;

  onTick(tick: MarketTick, state: EngineState, _signals?: SignalSnapshot): EngineAction[] {
    if (tick.source !== "polymarket") return [];

    const upTokenId = this.getUpTokenId();
    const downTokenId = this.getDownTokenId();
    if (!upTokenId || !downTokenId) return [];

    this.updatePendingOrders();
    if (this.hasPendingOrder()) return [];

    const upPos = this.getPosition(upTokenId);
    const downPos = this.getPosition(downTokenId);
    if ((upPos && upPos.shares > 0) || (downPos && downPos.shares > 0)) return [];

    const upBook = this.getBookForToken(upTokenId);
    const downBook = this.getBookForToken(downTokenId);
    if (!this.isBookTradeable(upBook) || !this.isBookTradeable(downBook)) return [];

    const upAsk = upBook.asks[0]?.price ?? 0;
    const downAsk = downBook.asks[0]?.price ?? 0;
    if (upAsk <= 0 || downAsk <= 0) return [];

    // Only fire on the side that's in our entry band
    const upQual = upAsk >= this.entryMin && upAsk <= this.entryMax;
    const downQual = downAsk >= this.entryMin && downAsk <= this.entryMax;
    if (!upQual && !downQual) return [];

    // Pick whichever qualifies and has the deeper bid + stabler book
    let tokenId = "";
    let askPrice = 0;
    let bidPrice = 0;
    if (upQual && downQual) {
      // Both qualify — pick the side with deeper depth
      const upDepth = this.depthAtBestBid(upTokenId);
      const downDepth = this.depthAtBestBid(downTokenId);
      if (upDepth > downDepth) {
        tokenId = upTokenId; askPrice = upAsk; bidPrice = upBook.bids[0]?.price ?? 0;
      } else {
        tokenId = downTokenId; askPrice = downAsk; bidPrice = downBook.bids[0]?.price ?? 0;
      }
    } else if (upQual) {
      tokenId = upTokenId; askPrice = upAsk; bidPrice = upBook.bids[0]?.price ?? 0;
    } else {
      tokenId = downTokenId; askPrice = downAsk; bidPrice = downBook.bids[0]?.price ?? 0;
    }
    if (bidPrice <= 0) return [];

    // Microstructure gates
    const depth = this.depthAtBestBid(tokenId);
    if (depth < this.minDepth) return [];

    const velocity = this.quoteVelocity(tokenId);
    if (velocity > this.maxVelocity) return [];

    const spreadBps = this.spreadBps(tokenId);
    if (spreadBps < this.minSpreadBps) return [];

    // Post 1 tick BELOW best bid — we're trying to be the next best price.
    // Only fills if someone aggressively crosses past current bid down to us.
    const limitPrice = Math.round((bidPrice - 0.01) * 100) / 100;
    if (limitPrice <= 0) return [];

    // Edge gate at 0.65 — we're posting deep enough that fills come from
    // aggressive sellers, who tend to be wrong about direction
    const edge = this.feeAdjustedEdge(0.65, limitPrice);
    if (!edge.profitable) return [];

    const shares = Math.floor((state.cashBalance * this.maxCashPct) / limitPrice);
    if (shares < 5) return [];

    this.markPending(tokenId);
    return [this.buy(tokenId, limitPrice, shares, {
      orderType: "maker",
      note: `queue-edge: maker ${tokenId === upTokenId ? "UP" : "DOWN"} @${limitPrice.toFixed(3)} depth=${depth.toFixed(0)} vel=${velocity} spread=${spreadBps.toFixed(0)}bps`,
      signalSource: "maker_queue_edge",
    })];
  }

  onRoundEnd(_state: EngineState): void {
    this.clearPendingOrders();
  }
}
