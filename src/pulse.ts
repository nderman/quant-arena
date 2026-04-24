/**
 * Quant Farm — Pulse (Data Feed)
 *
 * Connects to Polymarket CLOB WS (L2 depth) and Binance L2.
 * Emits normalized MarketTick events for the arena.
 * Tracks "Mid-Point Distance" — how far price is from $0.50 (fee regime indicator).
 *
 * Borrowed patterns: wsClient.ts from polymarket-ai-bot (heartbeat, reconnect, event bus).
 */

import WebSocket from "ws";
import { EventEmitter } from "events";
import { CONFIG } from "./config";
import { random } from "./rng";
import type { MarketTick, L2Level, OrderBook } from "./types";

// ── Event Bus ────────────────────────────────────────────────────────────────

export const pulseEvents = new EventEmitter();
pulseEvents.setMaxListeners(50);

// ── State ────────────────────────────────────────────────────────────────────

let pmBookWs: WebSocket | null = null;   // L2 book depth
let pmPriceWs: WebSocket | null = null;  // last_trade_price + best_bid_ask
let binanceWs: WebSocket | null = null;
let pmBookReconnectDelay = 1000;
let pmPriceReconnectDelay = 1000;
let binanceReconnectDelay = 1000;
let pmBookHeartbeat: ReturnType<typeof setInterval> | null = null;
let pmPriceHeartbeat: ReturnType<typeof setInterval> | null = null;
let binanceHeartbeat: ReturnType<typeof setInterval> | null = null;

// Dual orderbooks: UP and DOWN tokens have independent books (UP + DOWN ≠ $1.00)
// The gap between them is where merge arb profit lives
const emptyBook: OrderBook = { bids: [], asks: [], timestamp: 0 };
let latestUpBook: OrderBook = { ...emptyBook };
let latestDownBook: OrderBook = { ...emptyBook };
let latestBinanceBook: OrderBook = { ...emptyBook };
let lastPmDataTs = 0; // timestamp of last PM data received
let staleCheckInterval: ReturnType<typeof setInterval> | null = null;
let forceRotationFn: (() => void) | null = null; // called by stale detector to re-discover markets

// ── Binance Volume Tracking (for toxic flow scaling) ────────────────────────
const binanceVolState = new Map<string, { prevTotalSize: number; sizeChange: number; avgChange: number }>();

function trackBinanceVolume(symbol: string, book: OrderBook): void {
  const totalSize = book.bids.reduce((s, l) => s + l.size, 0) + book.asks.reduce((s, l) => s + l.size, 0);
  const prev = binanceVolState.get(symbol);
  if (!prev) {
    binanceVolState.set(symbol, { prevTotalSize: totalSize, sizeChange: 0, avgChange: totalSize * 0.05 });
    return;
  }
  const change = Math.abs(totalSize - prev.prevTotalSize);
  const alpha = 0.1; // EMA smoothing
  const avgChange = prev.avgChange * (1 - alpha) + change * alpha;
  binanceVolState.set(symbol, { prevTotalSize: totalSize, sizeChange: change, avgChange });
}

/** Returns ratio of current book size change to EMA average (>1 = spike) */
export function getBinanceVolumeSpike(symbol?: string): number {
  const sym = (symbol || CONFIG.BINANCE_SYMBOL).toUpperCase();
  const state = binanceVolState.get(sym);
  if (!state || state.avgChange <= 0) return 0;
  return state.sizeChange / state.avgChange;
}

/** Get the UP token's book (backwards compat) */
export function getLatestPmBook(): OrderBook { return latestUpBook; }

/** Reset both books (call on market rotation to avoid stale data) */
export function resetBooks(): void {
  latestUpBook = { bids: [], asks: [], timestamp: 0 };
  latestDownBook = { bids: [], asks: [], timestamp: 0 };
  resetBookSignals();
}

/** Get the correct book for a specific token */
export function getBookForToken(tokenId: string): OrderBook {
  if (tokenId === pmDownTokenId) return latestDownBook;
  return latestUpBook; // UP token or unknown → UP book
}

// ── Book microstructure signals ──────────────────────────────────────────────
// Phase B of signal wiring. Engines can read these to trade on order flow
// (bid/ask imbalance, spread dynamics, quote cancellation velocity) instead
// of only Binance momentum. All reads are O(N) over the top of the book.

const QUOTE_VELOCITY_WINDOW_MS = 10_000;
const bookUpdateTimestamps: { up: number[]; down: number[] } = { up: [], down: [] };

function recordBookUpdate(tokenId: string): void {
  const now = Date.now();
  const arr = tokenId === pmDownTokenId ? bookUpdateTimestamps.down : bookUpdateTimestamps.up;
  arr.push(now);
  // Trim old entries. Hot loop but O(k) amortized since push/shift balance.
  const cutoff = now - QUOTE_VELOCITY_WINDOW_MS;
  while (arr.length > 0 && arr[0] < cutoff) arr.shift();
}

/** Bid/ask imbalance on top N levels. Range [-1, +1]. Positive = bid-heavy. */
export function getBookImbalance(tokenId: string, topN = 3): number {
  const book = getBookForToken(tokenId);
  const bidDepth = book.bids.slice(0, topN).reduce((s, l) => s + l.size, 0);
  const askDepth = book.asks.slice(0, topN).reduce((s, l) => s + l.size, 0);
  const total = bidDepth + askDepth;
  if (total === 0) return 0;
  return (bidDepth - askDepth) / total;
}

/** Current spread in basis points. Returns 0 if book is empty or crossed. */
export function getSpreadBps(tokenId: string): number {
  const book = getBookForToken(tokenId);
  const bestBid = book.bids[0]?.price ?? 0;
  const bestAsk = book.asks[0]?.price ?? 0;
  if (bestBid <= 0 || bestAsk <= 0 || bestAsk <= bestBid) return 0;
  const mid = (bestBid + bestAsk) / 2;
  return ((bestAsk - bestBid) / mid) * 10_000;
}

/** Book updates in the last 10s. Proxy for MM cancellation/quote-churn rate. */
export function getQuoteVelocity(tokenId: string): number {
  const now = Date.now();
  const cutoff = now - QUOTE_VELOCITY_WINDOW_MS;
  const arr = tokenId === pmDownTokenId ? bookUpdateTimestamps.down : bookUpdateTimestamps.up;
  while (arr.length > 0 && arr[0] < cutoff) arr.shift();
  return arr.length;
}

/** Shares resting at the best bid (queue-depth proxy for maker fill ETA). */
export function getDepthAtBestBid(tokenId: string): number {
  const book = getBookForToken(tokenId);
  return book.bids[0]?.size ?? 0;
}

/** Reset velocity counters on rotation so cross-candle velocity doesn't leak. */
export function resetBookSignals(): void {
  bookUpdateTimestamps.up.length = 0;
  bookUpdateTimestamps.down.length = 0;
}

// Both token IDs for subscription (set by arena on discovery)
let pmSubscriptionTokens: string[] = [];
let pmUpTokenId = "";
let pmDownTokenId = "";
export function setPmSubscriptionTokens(tokens: string[]): void {
  pmSubscriptionTokens = tokens.filter(Boolean);
  pmUpTokenId = tokens[0] || "";
  pmDownTokenId = tokens[1] || "";
}
function getPmTokens(): string[] {
  if (pmSubscriptionTokens.length > 0) return pmSubscriptionTokens;
  return CONFIG.PM_CONDITION_ID ? [CONFIG.PM_CONDITION_ID] : [];
}

// ── Polymarket CLOB WebSocket ────────────────────────────────────────────────

/**
 * Parse a PM L2 book message. Validates and filters bad data:
 *   - Drops levels with invalid (NaN/negative/zero) prices or sizes
 *   - Drops levels outside the legitimate PM range (0.001, 0.999)
 *   - Returns null if the book is crossed (best bid >= best ask)
 *   - Returns null if the resulting book has no levels on either side
 *
 * Without this filtering, transient/bad PM quotes (occasionally published
 * during the few microseconds between market maker updates) leak into our
 * sim and produce phantom-alpha trades. fade-v2's "impossible win" pattern
 * was caused by this exact gap.
 */
// Exported for unit tests — pure function, no side effects
export function parsePmL2(data: any): OrderBook | null {
  try {
    const cleanLevels = (raw: any[]): L2Level[] =>
      raw
        .map((l: any) => ({ price: parseFloat(l.price), size: parseFloat(l.size) }))
        .filter((l: L2Level) =>
          Number.isFinite(l.price) &&
          Number.isFinite(l.size) &&
          l.size > 0 &&
          l.price > CONFIG.PM_PRICE_MIN &&
          l.price < CONFIG.PM_PRICE_MAX
        );

    const bids = cleanLevels(data.bids || []).sort((a, b) => b.price - a.price);
    const asks = cleanLevels(data.asks || []).sort((a, b) => a.price - b.price);

    if (!bids.length || !asks.length) return null;

    // Crossed book detection: best bid must be < best ask. PM occasionally
    // publishes crossed quotes during transient updates — reject them.
    if (bids[0].price >= asks[0].price) return null;

    return { bids, asks, timestamp: Date.now() };
  } catch {
    return null;
  }
}

/**
 * Compare a freshly parsed book against the previous one for the same token.
 * Rejects updates where the best price moved by more than `maxJumpFraction`
 * (default 25%) — this catches transient quotes where PM briefly publishes
 * a stale level before the next message corrects it.
 *
 * Returns true if the new book is acceptable, false if it should be discarded
 * as a transient artifact.
 */
// Exported for unit tests — pure function, no side effects
export function isBookUpdateReasonable(
  newBook: OrderBook,
  prevBook: OrderBook,
  maxJumpFraction: number = CONFIG.PM_BOOK_MAX_JUMP_FRACTION,
): boolean {
  // First update for this token — accept anything (no baseline to compare).
  if (!prevBook.bids.length || !prevBook.asks.length) return true;
  // Stale prev book — can't distinguish a real move from a transient quote
  // when the previous data is too old, so accept anything.
  if (Date.now() - prevBook.timestamp > CONFIG.PM_BOOK_PREV_STALE_MS) return true;

  const prevBestBid = prevBook.bids[0].price;
  const prevBestAsk = prevBook.asks[0].price;
  const newBestBid = newBook.bids[0].price;
  const newBestAsk = newBook.asks[0].price;

  const bidJump = Math.abs(newBestBid - prevBestBid) / Math.max(prevBestBid, CONFIG.PM_PRICE_MIN);
  const askJump = Math.abs(newBestAsk - prevBestAsk) / Math.max(prevBestAsk, CONFIG.PM_PRICE_MIN);

  return bidJump < maxJumpFraction && askJump < maxJumpFraction;
}

function buildPmTickFromPrice(price: number, assetId: string): MarketTick {
  return {
    source: "polymarket",
    symbol: assetId || CONFIG.PM_CONDITION_ID || "PM",
    midPrice: price,
    bestBid: price,
    bestAsk: price,
    spread: 0,
    distanceFrom50: Math.abs(price - 0.5),
    book: assetId === pmDownTokenId ? latestDownBook : latestUpBook,
    timestamp: Date.now(),
  };
}

function buildPmTick(book: OrderBook): MarketTick {
  const bestBid = book.bids[0]?.price ?? 0;
  const bestAsk = book.asks[0]?.price ?? 1;
  const midPrice = (bestBid + bestAsk) / 2;
  return {
    source: "polymarket",
    symbol: CONFIG.PM_CONDITION_ID || "PM-UNKNOWN",
    midPrice,
    bestBid,
    bestAsk,
    spread: bestAsk - bestBid,
    distanceFrom50: Math.abs(midPrice - 0.5),
    book,
    timestamp: book.timestamp,
  };
}

export function startPmChannel(): void {
  if (!CONFIG.PM_CONDITION_ID) {
    console.log("[pulse] No PM_CONDITION_ID set — Polymarket feed disabled");
    return;
  }

  startPmBookChannel();
  startPmPriceChannel();

  // Stale data detector: reconnect if no PM data received for too long
  // Forces market re-discovery so we don't reconnect to expired tokens
  if (staleCheckInterval) clearInterval(staleCheckInterval);
  staleCheckInterval = setInterval(() => {
    const staleMs = lastPmDataTs > 0 ? Date.now() - lastPmDataTs : 0;
    const bookOpen = pmBookWs?.readyState === 1;
    const priceOpen = pmPriceWs?.readyState === 1;

    if (staleMs > CONFIG.STALE_DATA_THRESHOLD_MS) {
      // Skip if WS is already mid-reconnect (not OPEN)
      if (!bookOpen && !priceOpen) return;

      console.warn(`[pulse] PM data stale for ${(staleMs / 1000).toFixed(0)}s — reconnecting + forcing rotation`);
      lastPmDataTs = Date.now();
      // Reset delays so close handler reconnects fast (don't let exponential backoff stack)
      pmBookReconnectDelay = 1000;
      pmPriceReconnectDelay = 1000;
      pmBookWs?.close();
      pmPriceWs?.close();
      // Force market rotation to re-discover and re-subscribe with fresh tokens
      if (forceRotationFn) forceRotationFn();
    }
  }, CONFIG.STALE_DATA_CHECK_MS);
}

// ── PM Book Channel (L2 depth) ──────────────────────────────────────────────

function startPmBookChannel(): void {
  const url = CONFIG.PM_WS_URL;
  console.log(`[pulse] Connecting PM Book WS: ${url}`);

  pmBookWs = new WebSocket(url);

  pmBookWs.on("open", () => {
    console.log("[pulse] PM Book WS connected");
    pmBookReconnectDelay = 1000;

    // Subscribe BOTH tokens — each gets routed to its own book
    pmBookWs?.send(JSON.stringify({
      type: "subscribe",
      channel: "book",
      assets_ids: getPmTokens(),
    }));

    if (pmBookHeartbeat) clearInterval(pmBookHeartbeat);
    pmBookHeartbeat = setInterval(() => {
      if (pmBookWs?.readyState === WebSocket.OPEN) pmBookWs.send("PING");
    }, 10_000);
  });

  pmBookWs.on("message", (raw: Buffer) => {
    const data = raw.toString();
    if (data === "PONG") return;

    try {
      const msgs = JSON.parse(data);
      const entries = Array.isArray(msgs) ? msgs : [msgs];

      for (const entry of entries) {
        if (entry.bids || entry.asks) {
          const book = parsePmL2(entry);
          if (book && book.bids.length && book.asks.length) {
            // Route to correct book based on asset_id
            const assetId = entry.asset_id || entry.market || "";
            const prevBook = assetId === pmDownTokenId ? latestDownBook : latestUpBook;

            // Transient quote filter: discard updates where the best price
            // jumps by > 25% in one message. Real PM books don't move that
            // fast in a single update — these are almost always transient
            // quotes published during MM repricing windows.
            if (!isBookUpdateReasonable(book, prevBook)) {
              continue;
            }

            if (assetId === pmDownTokenId) {
              latestDownBook = book;
            } else {
              latestUpBook = book;
            }
            recordBookUpdate(assetId);
            lastPmDataTs = Date.now();
            pulseEvents.emit("pm_book", book);
          }
        }
      }
    } catch { /* ignore */ }
  });

  pmBookWs.on("close", () => {
    if (pmBookHeartbeat) clearInterval(pmBookHeartbeat);
    setTimeout(() => startPmBookChannel(), pmBookReconnectDelay);
    pmBookReconnectDelay = Math.min(pmBookReconnectDelay * 2, 30_000);
  });

  pmBookWs.on("error", (err) => {
    console.error("[pulse] PM Book WS error:", err.message);
    pmBookWs?.close();
  });
}

// ── PM Price Channel (last_trade_price + best_bid_ask) ───────────────────────

function startPmPriceChannel(): void {
  const url = CONFIG.PM_WS_URL;
  console.log(`[pulse] Connecting PM Price WS: ${url}`);

  pmPriceWs = new WebSocket(url);

  pmPriceWs.on("open", () => {
    console.log("[pulse] PM Price WS connected");
    pmPriceReconnectDelay = 1000;

    const tokens = getPmTokens();
    pmPriceWs?.send(JSON.stringify({
      assets_ids: tokens,
      type: "market",
      level: 2,
      custom_feature_enabled: true,
    }));
    console.log(`[pulse] Price subscribed: ${tokens.length} tokens (${tokens[0]?.slice(0, 20)}...)`);

    if (pmPriceHeartbeat) clearInterval(pmPriceHeartbeat);
    pmPriceHeartbeat = setInterval(() => {
      if (pmPriceWs?.readyState === WebSocket.OPEN) pmPriceWs.send("PING");
    }, 10_000);
  });

  pmPriceWs.on("message", (raw: Buffer) => {
    const data = raw.toString();
    if (data === "PONG") return;

    try {
      const parsed = JSON.parse(data);
      // Can be a single object or array
      const msgs = Array.isArray(parsed) ? parsed : [parsed];

      for (const msg of msgs) {
        // ── price_changes: real-time price updates with best_bid/best_ask ──
        if (msg.price_changes && Array.isArray(msg.price_changes)) {
          for (const pc of msg.price_changes) {
            const bestBid = Number(pc.best_bid || 0);
            const bestAsk = Number(pc.best_ask || 0);
            const assetId = pc.asset_id || "";
            if (bestBid > 0 || bestAsk > 0) {
              const mid = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
              const tick = buildPmTickFromPrice(mid, assetId);
              tick.bestBid = bestBid;
              tick.bestAsk = bestAsk;
              tick.spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;
              tick.tokenSide = assetId === pmDownTokenId ? "DOWN" : "UP";
              lastPmDataTs = Date.now();
              pulseEvents.emit("tick", tick);
              pulseEvents.emit("pm_tick", tick);
            }
          }
          continue;
        }

        // ── last_trade_price (older API format) ──
        if (msg.event_type === "last_trade_price") {
          const assetId = msg.asset_id || "";
          const price = Number(msg.price);
          if (price > 0 && price <= 1) {
            const tick = buildPmTickFromPrice(price, assetId);
            tick.tokenSide = assetId === pmDownTokenId ? "DOWN" : "UP";
            pulseEvents.emit("tick", tick);
            pulseEvents.emit("pm_tick", tick);
          }
        }
      }
    } catch { /* ignore */ }
  });

  pmPriceWs.on("close", () => {
    if (pmPriceHeartbeat) clearInterval(pmPriceHeartbeat);
    setTimeout(() => startPmPriceChannel(), pmPriceReconnectDelay);
    pmPriceReconnectDelay = Math.min(pmPriceReconnectDelay * 2, 30_000);
  });

  pmPriceWs.on("error", (err) => {
    console.error("[pulse] PM Price WS error:", err.message);
    pmPriceWs?.close();
  });
}

// ── Binance L2 WebSocket ─────────────────────────────────────────────────────

function parseBinanceDepth(data: any): OrderBook | null {
  try {
    const bids: L2Level[] = (data.bids || data.b || [])
      .map((b: any) => ({ price: parseFloat(b[0]), size: parseFloat(b[1]) }))
      .sort((a: L2Level, b: L2Level) => b.price - a.price);
    const asks: L2Level[] = (data.asks || data.a || [])
      .map((a: any) => ({ price: parseFloat(a[0]), size: parseFloat(a[1]) }))
      .sort((a: L2Level, b: L2Level) => a.price - b.price);
    return { bids, asks, timestamp: Date.now() };
  } catch {
    return null;
  }
}

function buildBinanceTick(book: OrderBook, symbol: string): MarketTick {
  const bestBid = book.bids[0]?.price ?? 0;
  const bestAsk = book.asks[0]?.price ?? 0;
  const midPrice = (bestBid + bestAsk) / 2;
  return {
    source: "binance",
    symbol,
    midPrice,
    bestBid,
    bestAsk,
    spread: bestAsk - bestBid,
    distanceFrom50: 0, // N/A for Binance spot
    book,
    timestamp: book.timestamp,
  };
}

export function startBinanceChannel(): void {
  // Subscribe to multiple symbols via combined stream
  const symbols = [CONFIG.BINANCE_SYMBOL, ...CONFIG.BINANCE_EXTRA_SYMBOLS.split(",")]
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
  const streams = symbols.map(s => `${s}@depth20@100ms`).join("/");
  const url = `${CONFIG.BINANCE_WS_URL.replace("/ws", "/stream")}?streams=${streams}`;
  console.log(`[pulse] Connecting to Binance WS: ${symbols.join(", ")}`);

  binanceWs = new WebSocket(url);

  binanceWs.on("open", () => {
    console.log("[pulse] Binance WS connected");
    binanceReconnectDelay = 1000;

    if (binanceHeartbeat) clearInterval(binanceHeartbeat);
    binanceHeartbeat = setInterval(() => {
      if (binanceWs?.readyState === WebSocket.OPEN) {
        binanceWs.ping();
      }
    }, 30_000);
  });

  binanceWs.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      // Combined stream wraps data: {stream: "btcusdt@depth20@100ms", data: {...}}
      const data = msg.data || msg;
      const streamName = msg.stream || "";
      const sym = streamName.split("@")[0]?.toUpperCase() || symbols[0].toUpperCase();

      const book = parseBinanceDepth(data);
      if (book && book.bids.length && book.asks.length) {
        latestBinanceBook = book;
        trackBinanceVolume(sym, book);
        const tick = buildBinanceTick(book, sym);
        pulseEvents.emit("tick", tick);
        pulseEvents.emit("binance_tick", tick);
      }
    } catch { /* ignore */ }
  });

  binanceWs.on("close", () => {
    console.log(`[pulse] Binance WS closed — reconnecting in ${binanceReconnectDelay}ms`);
    if (binanceHeartbeat) clearInterval(binanceHeartbeat);
    setTimeout(() => startBinanceChannel(), binanceReconnectDelay);
    binanceReconnectDelay = Math.min(binanceReconnectDelay * 2, 30_000);
  });

  binanceWs.on("error", (err) => {
    console.error("[pulse] Binance WS error:", err.message);
    binanceWs?.close();
  });
}

// ── Simulated Tick Generator (for offline/dry-run testing) ───────────────────

let simInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Generate synthetic ticks for offline arena rounds.
 * Random walk around a starting price with configurable volatility.
 */
export function startSimulatedPulse(opts: {
  startPrice?: number;
  volatility?: number;
  intervalMs?: number;
} = {}): void {
  const { startPrice = 0.50, volatility = 0.002, intervalMs = CONFIG.TICK_INTERVAL_MS } = opts;
  let price = startPrice;

  console.log(`[pulse] Starting simulated pulse: price=${startPrice}, vol=${volatility}, interval=${intervalMs}ms`);

  simInterval = setInterval(() => {
    // Random walk
    const move = (random() - 0.5) * 2 * volatility;
    price = Math.max(0.01, Math.min(0.99, price + move));

    const spread = 0.01 + random() * 0.02;
    const bestBid = price - spread / 2;
    const bestAsk = price + spread / 2;

    const book: OrderBook = {
      bids: [
        { price: bestBid, size: 100 + random() * 500 },
        { price: bestBid - 0.01, size: 200 + random() * 800 },
        { price: bestBid - 0.02, size: 300 + random() * 1000 },
      ],
      asks: [
        { price: bestAsk, size: 100 + random() * 500 },
        { price: bestAsk + 0.01, size: 200 + random() * 800 },
        { price: bestAsk + 0.02, size: 300 + random() * 1000 },
      ],
      timestamp: Date.now(),
    };

    latestUpBook = book;

    const tick: MarketTick = {
      source: "polymarket",
      symbol: "SIM-BTC-5min",
      midPrice: price,
      bestBid,
      bestAsk,
      spread,
      distanceFrom50: Math.abs(price - 0.5),
      book,
      timestamp: Date.now(),
    };

    pulseEvents.emit("tick", tick);
    pulseEvents.emit("pm_tick", tick);
  }, intervalMs);
}

export function stopSimulatedPulse(): void {
  if (simInterval) {
    clearInterval(simInterval);
    simInterval = null;
  }
}

// ── Market Rotation (5M markets expire every 5 min) ─────────────────────────

let rotationInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Re-subscribe to the latest 5M market every `intervalMs`.
 * Calls `discoverFn` to get the current token ID, then sends a new WS subscribe.
 */
export function startMarketRotation(
  discoverFn: () => Promise<{ yesTokenId: string; noTokenId: string } | null>,
  intervalMs = 120_000, // check every 2 min
): void {
  let currentToken = "";

  const rotate = async () => {
    try {
      const result = await discoverFn();
      if (!result) return;

      const tokenChanged = result.yesTokenId !== currentToken;
      if (tokenChanged) {
        currentToken = result.yesTokenId;
        pmUpTokenId = result.yesTokenId;
        pmDownTokenId = result.noTokenId;
        resetBooks();
        console.log(`[pulse] Rotating to new market: ${currentToken.slice(0, 20)}... (dual books: UP + DOWN)`);
      }

      // Always update so reconnect handlers use current tokens
      const bothTokens = [result.yesTokenId, result.noTokenId].filter(Boolean);
      pmSubscriptionTokens = bothTokens;

      // Only send subscribe when tokens changed (reconnect handlers subscribe via getPmTokens)
      if (tokenChanged) {
        if (pmBookWs?.readyState === WebSocket.OPEN) {
          pmBookWs.send(JSON.stringify({
            type: "subscribe", channel: "book", assets_ids: bothTokens,
          }));
        }
        if (pmPriceWs?.readyState === WebSocket.OPEN) {
          pmPriceWs.send(JSON.stringify({
            assets_ids: bothTokens, type: "market", level: 2, custom_feature_enabled: true,
          }));
        }
      }
    } catch (err: any) {
      console.error("[pulse] Market rotation failed:", err.message);
    }
  };

  forceRotationFn = rotate; // expose for stale detector
  rotate(); // initial
  rotationInterval = setInterval(rotate, intervalMs);
}

// ── Shutdown ─────────────────────────────────────────────────────────────────

export function shutdown(): void {
  stopSimulatedPulse();
  if (pmBookHeartbeat) clearInterval(pmBookHeartbeat);
  if (pmPriceHeartbeat) clearInterval(pmPriceHeartbeat);
  if (binanceHeartbeat) clearInterval(binanceHeartbeat);
  if (rotationInterval) clearInterval(rotationInterval);
  if (staleCheckInterval) clearInterval(staleCheckInterval);
  pmBookWs?.close();
  pmPriceWs?.close();
  binanceWs?.close();
  console.log("[pulse] Shutdown complete");
}

// ── Standalone Test ──────────────────────────────────────────────────────────

if (require.main === module) {
  console.log("[pulse] Running standalone test...");
  pulseEvents.on("tick", (tick: MarketTick) => {
    console.log(`[${tick.source}] ${tick.symbol} mid=${tick.midPrice.toFixed(4)} spread=${tick.spread.toFixed(4)} dist50=${tick.distanceFrom50.toFixed(4)}`);
  });

  if (CONFIG.PM_CONDITION_ID) {
    startPmChannel();
  }
  startBinanceChannel();

  // Also run simulated for demo
  if (!CONFIG.PM_CONDITION_ID) {
    startSimulatedPulse({ startPrice: 0.55, volatility: 0.003 });
  }
}
