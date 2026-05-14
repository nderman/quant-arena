/**
 * WangXingYu activity cache + non-blocking poller.
 *
 * Singleton state shared across all WangXingYuCopyEngine instances (one per
 * BTC arena). On each engine tick we call `refreshIfStale()`; if the cache
 * is older than the poll interval AND no fetch is currently in flight, we
 * kick off a non-blocking fetch. The next tick sees the new signals.
 *
 * Discovered 2026-05-14: this wallet (`0x4c353dd3...`) shows 96% WR on 865
 * closed BTC candle positions, +$2,797,871 realized in 82 days, across all
 * 5m/15m/1h/4h resolutions. See `docs/whale_analysis_2026-05-13.md` (the
 * May 14 PM section) for the full decode.
 *
 * Why module-singleton not per-engine: each BTC arena (btc-5m / btc-15m /
 * btc-1h / btc-4h) runs its own WangXingYuCopyEngine instance, but they all
 * watch the same wallet. Putting the cache + fetcher at module level means
 * we poll the Activity API once per interval regardless of how many arenas
 * are listening. Saves rate limit and keeps signals consistent.
 *
 * The cache is keyed by tokenId (their `asset` field == the YES or NO ERC1155
 * token id of a specific candle). When our arena rotates to that token id,
 * we match and fire.
 */

const WALLET =
  process.env.WANGXINGYU_WALLET ??
  "0x4c353dd347c2e7d8bcdc5cd6ee569de7baf23e2f";
const POLL_INTERVAL_MS =
  (Number(process.env.WANGXINGYU_POLL_INTERVAL_SEC) || 60) * 1000;
const ACTIVITY_LIMIT = 200;

const API_BASE = "https://data-api.polymarket.com/activity";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; quant-farm/wangxingyu-copy)",
  Referer: "https://polymarket.com/",
  Accept: "application/json",
};

export interface CopySignal {
  /** Unix epoch seconds — their trade time on-chain */
  ts: number;
  /** ERC1155 token id (their `asset` field) */
  tokenId: string;
  slug: string;
  side: "BUY";
  price: number;
  size: number;
  title: string;
  /** Date.now() ms when we first observed this signal */
  fetchedAt: number;
}

interface ModuleState {
  lastSeenTs: number;
  /** tokenId → most recent BUY signal (their DCA collapses to latest) */
  signals: Map<string, CopySignal>;
  /** tokenIds we've already fired on (so multiple ticks don't double-fire) */
  consumed: Set<string>;
  inFlight: boolean;
  lastFetchAt: number;
  lastError: string | null;
  fetchCount: number;
}

const state: ModuleState = {
  lastSeenTs: 0,
  signals: new Map(),
  consumed: new Set(),
  inFlight: false,
  lastFetchAt: 0,
  lastError: null,
  fetchCount: 0,
};

/** Prune signals older than 2× maxSignalAgeSec (default 1200s = 20min) and
 *  consumed-tokenId entries whose signal was pruned. Bounded growth: signals
 *  Map and consumed Set both stay proportional to fetch window, not lifetime
 *  of the process. Called once per fetch cycle (~60s). */
function pruneStale(maxAgeSec: number): void {
  const cutoffTs = Math.floor(Date.now() / 1000) - maxAgeSec * 2;
  for (const [tokenId, sig] of state.signals) {
    if (sig.ts < cutoffTs) {
      state.signals.delete(tokenId);
      state.consumed.delete(tokenId);
    }
  }
}

async function fetchActivity(): Promise<unknown[]> {
  const url = `${API_BASE}?user=${WALLET}&limit=${ACTIVITY_LIMIT}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    throw new Error(`activity API ${res.status}: ${await res.text().catch(() => "")}`);
  }
  const body = await res.json();
  return Array.isArray(body) ? body : [];
}

/**
 * Kick off a non-blocking refresh if the cache is older than `intervalMs`
 * AND no fetch is currently running. Returns immediately. The caller does
 * NOT await; the next tick will see whatever the fetch produced.
 */
export function refreshIfStale(intervalMs: number = POLL_INTERVAL_MS): void {
  // Hermetic tests: set WANGXINGYU_DISABLE_FETCH=1 to skip network entirely.
  if (process.env.WANGXINGYU_DISABLE_FETCH === "1") return;
  const now = Date.now();
  if (state.inFlight) return;
  if (now - state.lastFetchAt < intervalMs) return;
  state.inFlight = true;
  state.lastFetchAt = now;
  void (async () => {
    try {
      const rows = await fetchActivity();
      state.fetchCount++;
      let added = 0;
      let latestTs = state.lastSeenTs;
      for (const row of rows as Array<Record<string, unknown>>) {
        if (row.type !== "TRADE" || row.side !== "BUY") continue;
        const ts = Number(row.timestamp ?? 0);
        if (!ts) continue;
        if (ts > latestTs) latestTs = ts;
        const tokenId = String(row.asset ?? "");
        if (!tokenId) continue;
        const existing = state.signals.get(tokenId);
        if (existing && existing.ts >= ts) continue;
        state.signals.set(tokenId, {
          ts,
          tokenId,
          slug: String(row.slug ?? ""),
          side: "BUY",
          price: Number(row.price ?? 0),
          size: Number(row.size ?? 0),
          title: String(row.title ?? ""),
          fetchedAt: now,
        });
        added++;
      }
      state.lastSeenTs = latestTs;
      state.lastError = null;
      // Bounded growth: prune signals + their consumed flags past 2× max age
      pruneStale(Number(process.env.WANGXINGYU_COPY_MAX_SIGNAL_AGE_SEC) || 600);
      if (added > 0) {
        console.log(
          `[wangxingyu] +${added} new signals (cache=${state.signals.size}, consumed=${state.consumed.size})`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      state.lastError = msg;
      console.error(`[wangxingyu] fetch failed: ${msg}`);
    } finally {
      state.inFlight = false;
    }
  })();
}

/**
 * Return the cached BUY signal for `tokenId` if one exists and hasn't been
 * consumed yet. Returns null otherwise.
 */
export function getSignalForToken(tokenId: string): CopySignal | null {
  if (!tokenId) return null;
  if (state.consumed.has(tokenId)) return null;
  return state.signals.get(tokenId) ?? null;
}

/** Mark this token's signal as consumed. Engine must call after firing. */
export function markConsumed(tokenId: string): void {
  if (tokenId) state.consumed.add(tokenId);
}

/** Stats for liveStatus / debugging */
export function getActivityStats() {
  return {
    wallet: WALLET,
    pollIntervalMs: POLL_INTERVAL_MS,
    lastFetchAt: state.lastFetchAt,
    lastSeenTs: state.lastSeenTs,
    inFlight: state.inFlight,
    cachedSignals: state.signals.size,
    consumed: state.consumed.size,
    fetchCount: state.fetchCount,
    lastError: state.lastError,
  };
}

/** Test helper — reset cache state (only meant for unit tests). */
export function _resetForTest(): void {
  state.lastSeenTs = 0;
  state.signals.clear();
  state.consumed.clear();
  state.inFlight = false;
  state.lastFetchAt = 0;
  state.lastError = null;
  state.fetchCount = 0;
}

/** Test helper — inject a signal without hitting the network. */
export function _injectSignalForTest(sig: CopySignal): void {
  state.signals.set(sig.tokenId, sig);
  if (sig.ts > state.lastSeenTs) state.lastSeenTs = sig.ts;
}

/** Test helper — exposed for prune behavior tests. */
export function _pruneStaleForTest(maxAgeSec: number): void {
  pruneStale(maxAgeSec);
}
