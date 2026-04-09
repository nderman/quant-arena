/**
 * Chainlink price feed poller via Polygon RPC.
 *
 * Polls on-chain Chainlink aggregators every N seconds and emits chainlink_tick
 * events. Engines can use this as the primary signal source instead of Binance
 * since Polymarket resolves on Chainlink — aligning engine decisions with
 * eventual settlement.
 */

import * as providers from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";
import { pulseEvents } from "./pulse";
import type { MarketTick, OrderBook } from "./types";

const RPC_URL = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
const RPC_FALLBACK = process.env.POLYGON_RPC_FALLBACK || "https://polygon-rpc.com";

// Polygon mainnet Chainlink aggregator addresses
export const CHAINLINK_FEEDS: Record<string, string> = {
  BTCUSDT: "0xc907E116054Ad103354f2D350FD2514433D57F6f",
  ETHUSDT: "0xF9680D99D6C9589e2a93a78A04A279e509205945",
  SOLUSDT: "0x10C8264C0935b3B9870013e057f330Ff3e9C56dC",
  XRPUSDT: "0x785ba89291f676b5386652eB12b30cF361020694",
};

const AGGREGATOR_ABI = [
  "function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80)",
  "function decimals() external view returns (uint8)",
];

const latestPrices = new Map<string, { price: number; updatedAt: number; fetchedAt: number }>();
const decimalsCache = new Map<string, number>();
let pollInterval: ReturnType<typeof setInterval> | null = null;
let provider: providers.StaticJsonRpcProvider | null = null;

async function getProvider(): Promise<providers.StaticJsonRpcProvider> {
  if (provider) return provider;
  for (const url of [RPC_URL, RPC_FALLBACK]) {
    try {
      const p = new providers.StaticJsonRpcProvider(url, 137);
      await p.getBlockNumber();
      provider = p;
      console.log(`[chainlink] Connected to Polygon RPC: ${url.slice(0, 40)}...`);
      return p;
    } catch (err: any) {
      console.warn(`[chainlink] RPC ${url.slice(0, 40)}... failed: ${err.message}`);
    }
  }
  throw new Error("No working Polygon RPC");
}

async function fetchPrice(symbol: string): Promise<{ price: number; updatedAt: number } | null> {
  const addr = CHAINLINK_FEEDS[symbol];
  if (!addr) return null;
  try {
    const p = await getProvider();
    const c = new Contract(addr, AGGREGATOR_ABI, p);

    let decimals = decimalsCache.get(symbol);
    if (decimals == null) {
      decimals = await c.decimals();
      decimalsCache.set(symbol, decimals!);
    }

    const [, answer, , updatedAt] = await c.latestRoundData();
    const price = Number(answer.toString()) / Math.pow(10, decimals!);
    return { price, updatedAt: Number(updatedAt.toString()) * 1000 };
  } catch (err: any) {
    console.warn(`[chainlink] fetchPrice ${symbol} failed: ${err.message}`);
    provider = null; // force reconnect on next call
    return null;
  }
}

function buildChainlinkTick(symbol: string, price: number): MarketTick {
  const emptyBook: OrderBook = { bids: [], asks: [], timestamp: Date.now() };
  return {
    source: "chainlink" as any, // extending source type
    symbol,
    midPrice: price,
    bestBid: price,
    bestAsk: price,
    spread: 0,
    distanceFrom50: 0,
    book: emptyBook,
    timestamp: Date.now(),
  };
}

/** Get latest cached Chainlink price for a symbol. Returns null if never fetched or stale (>2min). */
export function getLatestChainlinkPrice(symbol: string): number | null {
  const entry = latestPrices.get(symbol);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > 120_000) return null;
  return entry.price;
}

/** Get cached entry with metadata (for debug/staleness checks) */
export function getChainlinkEntry(symbol: string) {
  return latestPrices.get(symbol) || null;
}

export function startChainlinkPoller(symbols: string[], intervalMs = 2000): void {
  if (pollInterval) clearInterval(pollInterval);
  console.log(`[chainlink] Starting poller: ${symbols.join(", ")} every ${intervalMs}ms`);

  const tick = async () => {
    for (const symbol of symbols) {
      const result = await fetchPrice(symbol);
      if (!result) continue;
      latestPrices.set(symbol, { ...result, fetchedAt: Date.now() });
      const t = buildChainlinkTick(symbol, result.price);
      pulseEvents.emit("tick", t);
      pulseEvents.emit("chainlink_tick", t);
    }
  };

  tick(); // initial
  pollInterval = setInterval(tick, intervalMs);
}

export function stopChainlinkPoller(): void {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = null;
}
