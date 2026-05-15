/**
 * Binance perpetual funding-rate poller for sentiment-extreme signals.
 *
 * Funding rate represents the cost longs pay shorts (or vice versa) on
 * perp futures. Extreme funding indicates crowded positioning:
 *   - Funding > +50 bps annualized: longs paying heavily → crowded long
 *   - Funding < -30 bps annualized: shorts paying → crowded short
 *
 * Crowded positioning historically mean-reverts on 4-12h horizons.
 *
 * Polls Binance `premiumIndex` endpoint every 5 minutes (funding rate
 * updates every 8h on Binance, so 5min poll is plenty).
 *
 * Hermetic for tests: set `BINANCE_FUNDING_DISABLE_FETCH=1`.
 */
import * as https from "https";

const POLL_INTERVAL_MS = 5 * 60_000;
const TRACKED = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

interface FundingState {
  rate: number;        // last funding rate (8h interval, fractional)
  annualizedBps: number; // approx annualized basis points (rate × 365 × 3 × 10000)
  fetchedAt: number;
}

const state: Map<string, FundingState> = new Map();
let pollTimer: NodeJS.Timeout | null = null;

function fetchFunding(symbol: string): Promise<number | null> {
  return new Promise((resolve) => {
    const req = https.get(
      `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`,
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(body);
            const r = j?.lastFundingRate ? parseFloat(j.lastFundingRate) : null;
            resolve(r !== null && Number.isFinite(r) ? r : null);
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
  await Promise.all(
    TRACKED.map(async (symbol) => {
      const r = await fetchFunding(symbol);
      if (r === null) return;
      // Binance funding accrues every 8h → 3 events/day → ×3×365 to annualize
      const annualizedBps = r * 365 * 3 * 10000;
      state.set(symbol, { rate: r, annualizedBps, fetchedAt: Date.now() });
    }),
  );
}

export function startPolling(): void {
  if (pollTimer) return;
  if (process.env.BINANCE_FUNDING_DISABLE_FETCH === "1") return;
  void pollAll();
  pollTimer = setInterval(() => void pollAll(), POLL_INTERVAL_MS);
}

/** Returns annualized funding rate in basis points, or null. */
export function getFundingAnnualizedBps(symbol: string): number | null {
  const s = state.get(symbol);
  if (!s) return null;
  // Stale data: if fetched > 30 min ago, treat as missing
  if (Date.now() - s.fetchedAt > 30 * 60_000) return null;
  return s.annualizedBps;
}

// ── Test helpers ─────────────────────────────────────────────────────────────
export function _injectFundingForTest(symbol: string, annualizedBps: number): void {
  state.set(symbol, {
    rate: annualizedBps / (365 * 3 * 10000),
    annualizedBps,
    fetchedAt: Date.now(),
  });
}

export function _resetForTest(): void {
  state.clear();
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
