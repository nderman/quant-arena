/**
 * Cross-asset Binance spot price poller — exposes BTC/ETH/SOL prices to any
 * engine regardless of which coin its arena is currently watching.
 *
 * Each arena instance only sees its own coin's WS feed via pulse.ts. The
 * BTC↔ETH divergence engine and similar cross-asset signals need price
 * history for the OTHER coin. This module is a small HTTP poller (every
 * 30s) that maintains a rolling 2h history per symbol.
 *
 * `startPolling()` is idempotent; multiple engines that import this module
 * still result in a single timer.
 *
 * Hermetic for tests: set `CROSS_ASSET_DISABLE_FETCH=1` to skip the timer
 * and only use injected data via `_injectPriceForTest`.
 */
import * as https from "https";

const POLL_INTERVAL_MS = 30_000;
const MAX_SAMPLES = 240; // 240 × 30s = 2h

const TRACKED = ["BTCUSDT", "ETHUSDT", "SOLUSDT"] as const;
type TrackedSymbol = (typeof TRACKED)[number];

const prices: Map<string, { time: number; price: number }[]> = new Map();
for (const s of TRACKED) prices.set(s, []);

let pollTimer: NodeJS.Timeout | null = null;

function fetchPrice(symbol: string): Promise<number | null> {
  return new Promise((resolve) => {
    const req = https.get(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`,
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(body);
            const p = j?.price ? parseFloat(j.price) : null;
            resolve(p && Number.isFinite(p) && p > 0 ? p : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function pollAll(): Promise<void> {
  const now = Date.now();
  await Promise.all(
    TRACKED.map(async (symbol) => {
      const price = await fetchPrice(symbol);
      if (price === null) return;
      const arr = prices.get(symbol)!;
      arr.push({ time: now, price });
      while (arr.length > MAX_SAMPLES) arr.shift();
    }),
  );
}

/** Idempotently start the polling timer. Safe to call from multiple engines. */
export function startPolling(): void {
  if (pollTimer) return;
  if (process.env.CROSS_ASSET_DISABLE_FETCH === "1") return;
  void pollAll();
  pollTimer = setInterval(() => void pollAll(), POLL_INTERVAL_MS);
}

/** Fractional return of `symbol` over `lookbackSec`. Null if insufficient data. */
export function getCrossAssetReturn(symbol: string, lookbackSec: number): number | null {
  const arr = prices.get(symbol);
  if (!arr || arr.length < 2) return null;
  const cutoff = Date.now() - lookbackSec * 1000;
  const latest = arr[arr.length - 1];
  let oldest = arr[0];
  for (const s of arr) {
    if (s.time >= cutoff) {
      oldest = s;
      break;
    }
  }
  if (oldest.price <= 0 || oldest === latest) return null;
  return (latest.price - oldest.price) / oldest.price;
}

/** Most recent cached price for `symbol`, or null. */
export function getCrossAssetPrice(symbol: string): number | null {
  const arr = prices.get(symbol);
  if (!arr || arr.length === 0) return null;
  return arr[arr.length - 1].price;
}

// ── Test helpers ─────────────────────────────────────────────────────────────
export function _injectPriceForTest(symbol: string, time: number, price: number): void {
  const arr = prices.get(symbol);
  if (!arr) return;
  arr.push({ time, price });
  while (arr.length > MAX_SAMPLES) arr.shift();
}

export function _resetForTest(): void {
  for (const s of TRACKED) {
    const arr = prices.get(s);
    if (arr) arr.length = 0;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
