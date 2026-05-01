/**
 * Quant Farm — Market Discovery
 *
 * Finds active crypto markets on Polymarket via the Gamma API.
 * Returns condition IDs and token IDs for the arena to track.
 *
 * Borrowed from: cryptoDiscovery.ts, btcUpDownDiscovery.ts
 */

import { fetchJson } from "./http";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DiscoveredMarket {
  conditionId: string;
  title: string;
  slug: string;
  yesTokenId: string;
  noTokenId: string;
  endDate: string;
  liquidity: number;
  volume: number;
  bestBid: number;
  bestAsk: number;
  lastPrice: number;
}

interface GammaMarket {
  conditionId: string;
  question: string;
  slug: string;
  endDateIso: string;           // Date-only for non-5M markets: "2026-04-21"
  endDate?: string;             // Full ISO timestamp: "2026-04-21T11:00:00Z"
  liquidity: string;
  volume: string;
  active: boolean;
  closed: boolean;
  clobTokenIds?: string;        // JSON-encoded array of token IDs [yesTokenId, noTokenId]
  outcomePrices?: string;       // JSON-encoded array of prices ["0.52", "0.48"]
  outcomes?: string;            // JSON-encoded array ["Yes", "No"]
  liquidityNum?: number;
}

interface ClobMarket {
  condition_id: string;
  tokens: { token_id: string; outcome: string }[];
}

// ── Discovery ────────────────────────────────────────────────────────────────

/**
 * Discover active crypto markets on Polymarket.
 * Filters for BTC/ETH/SOL price markets with sufficient liquidity.
 */
export async function discoverCryptoMarkets(opts: {
  minLiquidity?: number;
  tokens?: string[];
  limit?: number;
} = {}): Promise<DiscoveredMarket[]> {
  const { minLiquidity = 1000, tokens = ["BTC", "Bitcoin", "ETH", "Ethereum", "SOL", "Solana"], limit = 20 } = opts;

  console.log(`[discovery] Searching Gamma API for crypto markets (min liquidity: $${minLiquidity})...`);

  const markets = await fetchJson<GammaMarket[]>(
    `${GAMMA_API}/markets?active=true&closed=false&limit=100&order=liquidity&ascending=false`
  );

  // Filter for crypto price markets
  const cryptoPattern = new RegExp(tokens.join("|"), "i");
  const pricePattern = /price|above|below|close|reach|dip|between|up or down/i;

  const candidates = markets.filter(m =>
    m.active &&
    !m.closed &&
    m.conditionId &&
    cryptoPattern.test(m.question) &&
    pricePattern.test(m.question) &&
    parseFloat(m.liquidity) >= minLiquidity
  );

  console.log(`[discovery] Found ${candidates.length} crypto markets (from ${markets.length} total)`);

  // Extract token IDs from Gamma response (clobTokenIds field)
  const results: DiscoveredMarket[] = [];
  for (const c of candidates.slice(0, limit)) {
    try {
      let yesTokenId = "";
      let noTokenId = "";

      // Token IDs are embedded in Gamma response as JSON string
      if (c.clobTokenIds) {
        const tokenIds = JSON.parse(c.clobTokenIds);
        if (tokenIds.length >= 2) {
          yesTokenId = tokenIds[0];
          noTokenId = tokenIds[1];
        }
      }

      // Fallback: fetch from CLOB API
      if (!yesTokenId || !noTokenId) {
        const clobData = await fetchJson<ClobMarket>(`${CLOB_API}/markets/${c.conditionId}`);
        const yesToken = clobData.tokens?.find(t => t.outcome === "Yes");
        const noToken = clobData.tokens?.find(t => t.outcome === "No");
        if (yesToken) yesTokenId = yesToken.token_id;
        if (noToken) noTokenId = noToken.token_id;
      }

      if (!yesTokenId || !noTokenId) continue;

      // Parse prices from Gamma response
      let bestBid = 0, bestAsk = 0;
      if (c.outcomePrices) {
        const prices = JSON.parse(c.outcomePrices);
        bestBid = parseFloat(prices[0]) || 0;
        bestAsk = 1 - (parseFloat(prices[1]) || 0); // NO price complement
      }

      results.push({
        conditionId: c.conditionId,
        title: c.question,
        slug: c.slug,
        yesTokenId,
        noTokenId,
        endDate: c.endDate || c.endDateIso,  // prefer full ISO timestamp over date-only
        liquidity: parseFloat(c.liquidity),
        volume: parseFloat(c.volume || "0"),
        bestBid,
        bestAsk,
        lastPrice: bestBid,
      });
    } catch (err: any) {
      console.error(`[discovery] Failed to parse market ${c.conditionId}:`, err.message);
    }
  }

  // Sort by liquidity
  results.sort((a, b) => b.liquidity - a.liquidity);

  for (const r of results) {
    const hoursLeft = (new Date(r.endDate).getTime() - Date.now()) / 3600_000;
    console.log(`  ${r.title.slice(0, 60).padEnd(60)} | liq=$${r.liquidity.toFixed(0).padStart(8)} | ${hoursLeft.toFixed(1)}h left`);
  }

  return results;
}

/**
 * Discover 5-minute / 1-hour Up/Down crypto markets specifically.
 * These are the high-frequency markets ideal for the arena.
 */
export async function discoverUpDownMarkets(opts: {
  intervals?: string[];
  limit?: number;
} = {}): Promise<DiscoveredMarket[]> {
  const { intervals = ["5M", "1H", "4H", "daily"], limit = 20 } = opts;

  const allMarkets: DiscoveredMarket[] = [];

  for (const interval of intervals) {
    const tagSlug = interval === "daily" ? "daily-close"
      : interval === "1H" ? "1H"
      : interval === "4H" ? "4H"
      : interval;

    try {
      const events = await fetchJson<any[]>(
        `${GAMMA_API}/events?tag_slug=${tagSlug}&active=true&closed=false&limit=20`
      );

      for (const event of events) {
        const markets: GammaMarket[] = event.markets || [];
        for (const m of markets) {
          if (!m.active || m.closed || !m.conditionId) continue;

          try {
            let yesTokenId = "", noTokenId = "";
            if (m.clobTokenIds) {
              const ids = JSON.parse(m.clobTokenIds);
              if (ids.length >= 2) { yesTokenId = ids[0]; noTokenId = ids[1]; }
            }
            if (!yesTokenId || !noTokenId) continue;

            let bestBid = 0, bestAsk = 0;
            if (m.outcomePrices) {
              const prices = JSON.parse(m.outcomePrices);
              bestBid = parseFloat(prices[0]) || 0;
              bestAsk = 1 - (parseFloat(prices[1]) || 0);
            }

            allMarkets.push({
              conditionId: m.conditionId,
              title: m.question,
              slug: m.slug || "",
              yesTokenId,
              noTokenId,
              endDate: m.endDate || m.endDateIso,  // prefer full ISO timestamp over date-only
              liquidity: parseFloat(m.liquidity || "0"),
              volume: parseFloat(m.volume || "0"),
              bestBid,
              bestAsk,
              lastPrice: bestBid,
            });
          } catch { /* skip */ }
        }
      }
    } catch (err: any) {
      console.error(`[discovery] Failed to fetch ${interval} events:`, err.message);
    }
  }

  console.log(`[discovery] Found ${allMarkets.length} up/down markets across ${intervals.join(", ")}`);
  return allMarkets.slice(0, limit);
}

/**
 * Discover 5M BTC Up/Down markets via deterministic slug pattern.
 *
 * Gamma events API returns stale 5M data. The slug-based approach always works:
 *   GET /markets/slug/{token}-updown-5m-{unix_aligned_to_300s}
 *
 * Borrowed from: btcUpDownDiscovery.ts discover5mBySlugs()
 */
export async function discover5mMarkets(opts: {
  tokens?: string[];
  windowsAhead?: number;
} = {}): Promise<DiscoveredMarket[]> {
  const { tokens = ["btc", "eth", "xrp"], windowsAhead = 3 } = opts;
  const nowSec = Math.floor(Date.now() / 1000);
  const currentWindow = Math.floor(nowSec / 300) * 300; // align to 5-min boundary
  const results: DiscoveredMarket[] = [];

  for (const token of tokens) {
    for (let offset = 0; offset < windowsAhead; offset++) {
      const windowStart = currentWindow + offset * 300;
      const windowEnd = windowStart + 300;
      const timeLeftSec = windowEnd - nowSec;

      if (timeLeftSec < 120) continue;  // < 2 min left — too late
      if (timeLeftSec > 900) continue;  // > 15 min — too far

      const slug = `${token}-updown-5m-${windowStart}`;
      try {
        const market = await fetchJson<any>(`${GAMMA_API}/markets/slug/${slug}`);
        if (!market?.conditionId || !market.clobTokenIds || market.closed) continue;
        if (!market.acceptingOrders) continue;

        const tokenIds = typeof market.clobTokenIds === "string"
          ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
        if (!Array.isArray(tokenIds) || tokenIds.length < 2) continue;

        let bestBid = 0.50, bestAsk = 0.50;
        if (market.outcomePrices) {
          const prices = typeof market.outcomePrices === "string"
            ? JSON.parse(market.outcomePrices) : market.outcomePrices;
          bestBid = parseFloat(prices[0]) || 0.50;
          bestAsk = parseFloat(prices[1]) || 0.50;
        }

        const minsLeft = Math.round(timeLeftSec / 60);
        console.log(`[discovery] 5M: ${market.question || slug}  ${minsLeft}min left  prices=[${bestBid},${bestAsk}]`);

        results.push({
          conditionId: market.conditionId,
          title: market.question || `${token} Up or Down - 5M`,
          slug,
          yesTokenId: tokenIds[0],  // "Up" token
          noTokenId: tokenIds[1],   // "Down" token
          endDate: new Date(windowEnd * 1000).toISOString(),
          liquidity: parseFloat(market.liquidity || "0"),
          volume: parseFloat(market.volume || "0"),
          bestBid,
          bestAsk,
          lastPrice: bestBid,
        });
      } catch { /* slug doesn't exist yet — normal */ }
    }
  }

  console.log(`[discovery] Found ${results.length} active 5M markets across ${tokens.join(", ")}`);
  return results;
}

// ── Standalone Test ──────────────────────────────────────────────────────────

if (require.main === module) {
  (async () => {
    console.log("\n=== 5M Markets (slug-based) ===\n");
    const fiveMin = await discover5mMarkets();

    console.log("\n=== Crypto Markets ===\n");
    const crypto = await discoverCryptoMarkets();

    console.log("\n=== Up/Down Markets (tag-based) ===\n");
    const updown = await discoverUpDownMarkets({ intervals: ["1H", "4H"] });
  })().catch(console.error);
}
