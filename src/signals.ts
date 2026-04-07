/**
 * Quant Farm — Signal Sources
 *
 * Free external data feeds that engines can use for alpha.
 * All sources are free, no API keys required.
 *
 * Borrowed from: fearGreed.ts, fundingRate.ts, deribitVol.ts, binanceVol.ts
 */

import { fetchJson } from "./http";
import type { SignalSnapshot } from "./types";

// ── Types ────────────────────────────────────────────────────────────────────

export type { SignalSnapshot };

export interface FearGreedData {
  value: number;        // 0-100 (0=extreme fear, 100=extreme greed)
  label: string;        // "Extreme Fear", "Fear", "Neutral", "Greed", "Extreme Greed"
  timestamp: number;
}

export interface FundingData {
  symbol: string;
  rate: number;          // e.g. 0.0001 = 0.01%
  annualized: number;    // rate * 3 * 365
  direction: "long" | "short" | "neutral";  // who's paying
}

export interface ImpliedVolData {
  currency: string;      // "BTC" or "ETH"
  dvol: number;          // annualized implied vol (e.g. 55 = 55%)
  timestamp: number;
}

export interface RealizedVolData {
  symbol: string;
  vol5m: number;         // 5-minute realized vol (annualized)
  vol1h: number;         // 1-hour realized vol (annualized)
  vol1d: number;         // daily realized vol (annualized)
}


// ── Fear & Greed Index ───────────────────────────────────────────────────────

let cachedFng: FearGreedData | null = null;
let fngFetchedAt = 0;
const FNG_CACHE_MS = 3600_000; // 1 hour cache (updates daily anyway)

/**
 * Crypto Fear & Greed Index from alternative.me
 * Free, no auth, updates daily.
 *
 * Interpretation:
 *   0-24: Extreme Fear → contrarian BUY signal
 *   25-49: Fear → mild BUY bias
 *   50: Neutral
 *   51-74: Greed → mild SELL bias
 *   75-100: Extreme Greed → contrarian SELL signal
 */
export async function fetchFearGreed(): Promise<FearGreedData | null> {
  if (cachedFng && Date.now() - fngFetchedAt < FNG_CACHE_MS) return cachedFng;

  try {
    const data = await fetchJson<any>("https://api.alternative.me/fng/?limit=1");
    const entry = data?.data?.[0];
    if (!entry) return null;

    cachedFng = {
      value: parseInt(entry.value),
      label: entry.value_classification,
      timestamp: parseInt(entry.timestamp) * 1000,
    };
    fngFetchedAt = Date.now();
    return cachedFng;
  } catch (err: any) {
    console.error("[signals] Fear & Greed fetch failed:", err.message);
    return cachedFng; // return stale data if available
  }
}

// ── Binance Funding Rate ─────────────────────────────────────────────────────

/**
 * 8-hour perpetual funding rate from Binance.
 * Free, no auth.
 *
 * Interpretation:
 *   rate > 0.01%: Longs paying shorts (bullish overcrowding → contrarian short)
 *   rate < -0.01%: Shorts paying longs (bearish overcrowding → contrarian long)
 *   rate near 0: Neutral
 */
export async function fetchFundingRate(symbol = "BTCUSDT"): Promise<FundingData | null> {
  try {
    const data = await fetchJson<any[]>(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol}&limit=1`
    );
    if (!data?.[0]) return null;

    const rate = parseFloat(data[0].fundingRate);
    const annualized = rate * 3 * 365; // 3x/day × 365 days

    return {
      symbol,
      rate,
      annualized,
      direction: rate > 0.0001 ? "long" : rate < -0.0001 ? "short" : "neutral",
    };
  } catch (err: any) {
    console.error("[signals] Funding rate fetch failed:", err.message);
    return null;
  }
}

// ── Deribit DVOL (Implied Volatility) ────────────────────────────────────────

/**
 * Deribit DVOL — annualized implied volatility from BTC/ETH options.
 * Free, no auth. BTC and ETH only.
 *
 * Interpretation:
 *   DVOL > 80: High vol → wider ranges, bigger moves expected
 *   DVOL 40-80: Normal
 *   DVOL < 40: Low vol → compression, breakout likely
 */
export async function fetchDeribitDVOL(currency = "BTC"): Promise<ImpliedVolData | null> {
  try {
    const now = Date.now();
    const dayAgo = now - 86400_000;
    const data = await fetchJson<any>(
      `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${currency}&resolution=3600&start_timestamp=${dayAgo}&end_timestamp=${now}`
    );

    const points = data?.result?.data;
    if (!points?.length) return null;

    const latest = points[points.length - 1];
    return {
      currency,
      dvol: latest[1], // [timestamp, open, high, low, close] — use open
      timestamp: latest[0],
    };
  } catch (err: any) {
    console.error("[signals] Deribit DVOL fetch failed:", err.message);
    return null;
  }
}

// ── Binance Realized Volatility ──────────────────────────────────────────────

/**
 * Compute realized volatility from Binance klines.
 * Free, no auth. 1200 req/min limit.
 */
export async function fetchRealizedVol(symbol = "BTCUSDT"): Promise<RealizedVolData | null> {
  try {
    const [klines5m, klines1h, klines1d] = await Promise.all([
      fetchJson<any[]>(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=288`),
      fetchJson<any[]>(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=168`),
      fetchJson<any[]>(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1d&limit=30`),
    ]);

    const calcVol = (candles: any[], periodsPerYear: number): number => {
      const closes = candles.map((c: any) => parseFloat(c[4]));
      const returns: number[] = [];
      for (let i = 1; i < closes.length; i++) {
        returns.push(Math.log(closes[i] / closes[i - 1]));
      }
      if (returns.length < 2) return 0;
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
      return Math.sqrt(variance * periodsPerYear) * 100; // annualized %
    };

    return {
      symbol,
      vol5m: calcVol(klines5m, 288 * 365),   // 288 5-min periods per day
      vol1h: calcVol(klines1h, 24 * 365),     // 24 hourly periods per day
      vol1d: calcVol(klines1d, 365),           // 365 daily periods per year
    };
  } catch (err: any) {
    console.error("[signals] Realized vol fetch failed:", err.message);
    return null;
  }
}

// ── Binance Spot Price ───────────────────────────────────────────────────────

export async function fetchBinancePrice(symbol = "BTCUSDT"): Promise<number | null> {
  try {
    const data = await fetchJson<{ price: string }>(
      `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`
    );
    return parseFloat(data.price);
  } catch {
    return null;
  }
}

// ── Aggregate Signal Snapshot ────────────────────────────────────────────────

/**
 * Fetch all signals in parallel. Returns a snapshot engines can use.
 * Call this once per tick cycle (or on a timer) and pass to engines.
 */
export async function fetchSignalSnapshot(symbol = "BTCUSDT"): Promise<SignalSnapshot> {
  const [fearGreed, funding, impliedVol, realizedVol, binancePrice] = await Promise.allSettled([
    fetchFearGreed(),
    fetchFundingRate(symbol),
    fetchDeribitDVOL(symbol.replace("USDT", "")),
    fetchRealizedVol(symbol),
    fetchBinancePrice(symbol),
  ]);

  return {
    timestamp: Date.now(),
    fearGreed: fearGreed.status === "fulfilled" ? fearGreed.value : null,
    funding: funding.status === "fulfilled" ? funding.value : null,
    impliedVol: impliedVol.status === "fulfilled" ? impliedVol.value : null,
    realizedVol: realizedVol.status === "fulfilled" ? realizedVol.value : null,
    binancePrice: binancePrice.status === "fulfilled" ? binancePrice.value : null,
  };
}

// ── Standalone Test ──────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    console.log("[signals] Fetching all signals...\n");
    const snap = await fetchSignalSnapshot();

    if (snap.fearGreed) {
      console.log(`Fear & Greed: ${snap.fearGreed.value} (${snap.fearGreed.label})`);
    }
    if (snap.funding) {
      console.log(`Funding Rate: ${(snap.funding.rate * 100).toFixed(4)}% (${snap.funding.direction}) | annualized: ${(snap.funding.annualized * 100).toFixed(1)}%`);
    }
    if (snap.impliedVol) {
      console.log(`Deribit DVOL (${snap.impliedVol.currency}): ${snap.impliedVol.dvol.toFixed(1)}%`);
    }
    if (snap.realizedVol) {
      console.log(`Realized Vol (${snap.realizedVol.symbol}): 5m=${snap.realizedVol.vol5m.toFixed(1)}% | 1h=${snap.realizedVol.vol1h.toFixed(1)}% | 1d=${snap.realizedVol.vol1d.toFixed(1)}%`);
    }
    if (snap.binancePrice) {
      console.log(`BTC Price: $${snap.binancePrice.toLocaleString()}`);
    }
  })().catch(console.error);
}
