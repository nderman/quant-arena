#!/usr/bin/env python3
"""Auto-rotate live engines based on recent sim performance + regime fit.

Runs hourly via cron on VPS. Selects top SAFE engines, atomically updates
data/live_engines.json. The liveArena file-watcher reloads the roster
mid-round (no PM2 restart needed).

Selection score:
    score = recent_sharpe × regime_fit_mult

  recent_sharpe = mean PnL / stddev across last N firing rounds
  regime_fit_mult = 1.5 (positive cell), 0.5 (negative cell), 1.0 (no data)

Hard SAFE filters (all must pass):
  - >= MIN_ROUNDS firing rounds in this arena
  - worst round >= -bankroll * SAFE_LOSS_PCT
  - not in cooldown (recently swapped out)

Roster construction:
  - Top K (engine, arena) pairs by score
  - One engine per arena
  - Coin diversification target

Circuit breakers (data-driven from streak analysis):
  - 3-in-a-row: NOT a kill (happens to profitable engines every ~13 rounds)
  - 5-in-a-row: soft flag for hourly review
  - Bankroll drawdown > 20% in 1h: halt all
  - Per-engine cumulative loss > 50% allocated bankroll: rotate out

Safety:
  - data/auto_rotation.disabled file → exit early (manual stop)
  - data/auto_rotation.log: rolling decisions log
  - Min cash buffer: skip add if cash < $5 * roster size

Usage:
  python3 scripts/auto_rotate.py            # dry-run (prints plan, no change)
  python3 scripts/auto_rotate.py --commit   # actually swap

Phase 1a: dry-run only. Phase 1b: flip --commit on, wire cron.
"""
from __future__ import annotations
import argparse, functools, json, os, sys, time, datetime as dt, statistics
from pathlib import Path
from collections import defaultdict
from typing import Dict, List, Tuple, Any

# ── Config ───────────────────────────────────────────────────────────────────

DATA_DIR = Path(os.environ.get("QUANT_DATA_DIR", "data"))
LIVE_ENGINES_PATH = DATA_DIR / "live_engines.json"
DISABLED_FLAG = DATA_DIR / "auto_rotation.disabled"
ROTATION_LOG = DATA_DIR / "auto_rotation.log"
COOLDOWN_PATH = DATA_DIR / "auto_rotation_cooldown.json"
LAST_SEEN_ROSTER_PATH = DATA_DIR / "auto_rotation_last_seen.json"
SIM_UNRELIABLE_PATH = Path(os.environ.get("QUANT_CONFIG_DIR", "config")) / "sim_unreliable.json"
FUNDER_ADDRESS = os.environ.get("FUNDER", "")

ARENAS = [
    "btc", "eth", "sol",
    "btc-15m", "eth-15m", "sol-15m",
    "btc-1h", "eth-1h", "sol-1h",
    "btc-4h", "eth-4h", "sol-4h",
]

# Selection params
MIN_ROUNDS = 8              # need this many firing rounds — small N causes Sharpe inflation
RECENT_N = 10               # use last N firing rounds for sharpe
SAFE_LOSS_USD = 20.0        # worst round must be >= -this (40% of $50 sim bankroll, matches crossArenaAnalysis SAFE classification)
COOLDOWN_HOURS = 6          # how long swapped-out engine waits before re-entry
SWAP_THRESHOLD = 0.30       # only swap if proposed score is > current * (1 + this)
INCUMBENT_BONUS = 0.10      # was 0.20 — less sticky so winners can swap in faster
ROSTER_SIZE = 10            # top K. There are no "slots" — engines × arenas
                            # all compete; whatever passes SAFE+score+coin_cap
                            # goes live. Bumped from 5 (2026-05-07) after the
                            # small cap was masking strong candidates by
                            # forcing artificial scarcity.
LIVE_BANKROLL_USD = 25.0    # used for cash buffer check
MIN_CASH_PER_ENGINE = 5.0   # skip add if cash < this * roster size
SHRINKAGE_K = 5             # Bayesian-style shrinkage: sharpe *= n/(n+K)
LIVE_PNL_LOOKBACK_HOURS = 6 # window for live-PnL drift feedback
LIVE_PNL_LOSS_PENALTY = 0.5 # multiplier when an engine has bled live in lookback
LIVE_PNL_LOSS_THRESHOLD = -2.0  # USD — engine penalized if it's lost more than this
MIN_PENALTY_FLOOR = 0.5     # cap compound penalty; TREND(0.5) × LP(0.5) = 0.25 was killing chop-fader (proven winner)
ALLOW_MULTIPLE_PER_ARENA = True  # user prefers performance over arena diversification
STREAK_CULL_N = int(os.environ.get("STREAK_CULL_N", "5"))  # N most-recent sim rounds — all negative triggers auto-cull

# Trial gate (May 6 2026): new engine promotions use a small bankroll for
# their first N live fires before graduating to full size. Catches
# sim:live divergence at ~$3 loss instead of $13. After TRIAL_FIRE_COUNT
# settled fires, promote to full bankroll if net positive; demote (skip
# from candidates) if net negative.
TRIAL_BANKROLL_USD = float(os.environ.get("TRIAL_BANKROLL_USD", "5"))
TRIAL_FIRE_COUNT = int(os.environ.get("TRIAL_FIRE_COUNT", "5"))
LIVE_LEDGER_PATH = DATA_DIR / "live_trades.jsonl"

# Regime fit multipliers
REGIME_POSITIVE_MULT = 1.5
REGIME_NEGATIVE_MULT = 0.5
REGIME_NEUTRAL_MULT = 1.0

# ── Data loading ─────────────────────────────────────────────────────────────

@functools.lru_cache(maxsize=16)
def load_round_history(arena: str) -> List[dict]:
    """Cached per-arena loader. One main() invocation reads each arena file once,
    even if both detect_streak_culls and candidates() consult it.
    """
    p = DATA_DIR / f"round_history_{arena}.json"
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text())
    except Exception as e:
        log(f"warn: failed to parse {p}: {e}")
        return []


def load_live_engines() -> Dict[str, list]:
    if not LIVE_ENGINES_PATH.exists():
        return {}
    try:
        return json.loads(LIVE_ENGINES_PATH.read_text())
    except Exception:
        return {}


def load_sim_unreliable() -> set[tuple[str, str]]:
    """(engine, arena) pairs whose sim score is known not to translate to live.

    Format of sim_unreliable.json:
      {"pairs": [["chop-fader-v1", "eth"], ["stingo43-late-v1", "btc"]],
       "reason": "deep-price entries adversely selected; sim doesn't model"}

    These are excluded from candidate selection until the sim referee is
    fixed (typically: extreme-price adverse-selection penalty in walkBook).
    """
    if not SIM_UNRELIABLE_PATH.exists():
        return set()
    try:
        data = json.loads(SIM_UNRELIABLE_PATH.read_text())
    except json.JSONDecodeError:
        return set()
    return {(p[0], p[1]) for p in data.get("pairs", []) if isinstance(p, list) and len(p) >= 2}


def load_cooldown() -> Dict[str, float]:
    """Map of '<engine>:<arena>' -> unix timestamp when cooldown ends."""
    if not COOLDOWN_PATH.exists():
        return {}
    try:
        return json.loads(COOLDOWN_PATH.read_text())
    except Exception:
        return {}


def atomic_write_json(path: Path, data: Any) -> None:
    """Write JSON atomically — tmp file + os.replace. Critical for live_engines.json
    because liveArena.ts has a 30s file-watcher that reads it concurrently."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    os.replace(tmp, path)


def save_cooldown(cd: Dict[str, float]) -> None:
    """Prune expired entries before persisting — file would grow unbounded otherwise."""
    now = time.time()
    pruned = {k: v for k, v in cd.items() if v > now}
    atomic_write_json(COOLDOWN_PATH, pruned)


def fetch_live_pnl_by_coin(hours: float = LIVE_PNL_LOOKBACK_HOURS) -> Dict[str, float]:
    """Pull recent Polymarket activity, attribute by coin from market title.
    Returns coin -> net_usd_flow over the lookback window.

    Used as a "live drift" feedback signal: if an engine's coin has been
    bleeding cash in the last N hours, penalize that engine's score so
    auto-rotate doesn't keep re-adding it.
    """
    import urllib.request
    cutoff = time.time() - hours * 3600
    out: Dict[str, float] = defaultdict(float)
    try:
        url = f"https://data-api.polymarket.com/activity?user={FUNDER_ADDRESS}&limit=200"
        req = urllib.request.Request(url, headers={"User-Agent": "quant-farm/1.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
    except Exception as e:
        log(f"warn: activity API fetch failed: {e}")
        return {}
    for a in data:
        ts = a.get("timestamp", 0)
        if ts < cutoff:
            continue
        title = (a.get("title", "") or "")
        coin = "ETH" if "Ethereum" in title else ("SOL" if "Solana" in title else ("BTC" if "Bitcoin" in title else None))
        if not coin:
            continue
        try:
            usd = float(a.get("usdcSize", 0) or 0)  # API may return strings
        except (ValueError, TypeError):
            continue
        typ = (a.get("type", "") or "").upper()
        if typ == "TRADE" and a.get("side") == "BUY":
            out[coin] -= usd
        elif typ == "REDEEM":
            out[coin] += usd
        elif typ == "TRADE" and a.get("side") == "SELL":
            out[coin] += usd
    return dict(out)


def load_last_seen_roster() -> set:
    """Load the roster set as of the previous cron run, for manual-cull detection."""
    if not LAST_SEEN_ROSTER_PATH.exists():
        return set()
    try:
        d = json.loads(LAST_SEEN_ROSTER_PATH.read_text())
        return {tuple(pair) for pair in d.get("pairs", [])}
    except Exception:
        return set()


def save_last_seen_roster(pairs: set) -> None:
    atomic_write_json(LAST_SEEN_ROSTER_PATH, {"pairs": [list(p) for p in pairs], "ts": time.time()})


def detect_streak_culls(current_set: set, cooldown: Dict[str, float]) -> List[Tuple[str, str]]:
    """Auto-cull live engines on N consecutive sim losses.

    Memory rule (May 2 2026 incident): 5+ consecutive losing rounds is the
    kill threshold for an engine. Aggregate sharpe + incumbent bonus can hold
    a declining engine in roster long after its edge has evaporated; this
    pre-filter catches that before the score-based logic runs.

    Returns list of (engine, arena) pairs that should be removed + cooled.
    """
    now = time.time()
    cooldown_until = now + COOLDOWN_HOURS * 3600
    culls = []
    for engine_id, arena in current_set:
        cd_key = f"{engine_id}:{arena}"
        if cooldown.get(cd_key, 0) > now:
            continue  # already cooled, no need to re-flag
        rounds = gather_engine_rounds(arena).get(engine_id, [])
        if len(rounds) < STREAK_CULL_N:
            continue
        # Sort by timestamp ascending; check last N
        recent = sorted(rounds, key=lambda r: r[0])[-STREAK_CULL_N:]
        if all(pnl < 0 for _, pnl in recent):
            cooldown[cd_key] = cooldown_until
            culls.append((engine_id, arena))
    return culls


def detect_and_record_manual_culls(current_set: set, last_seen: set, cooldown: Dict[str, float]) -> int:
    """If an engine was in last_seen but is missing from current_set, the user
    manually removed it (since auto_rotate would have added cooldown via its
    own removal path). Add cooldown so we don't auto-readd it.

    Returns count of newly-cooled-down pairs.
    """
    now = time.time()
    cooldown_until = now + COOLDOWN_HOURS * 3600
    n = 0
    for pair in last_seen:
        if pair not in current_set:
            cd_key = f"{pair[0]}:{pair[1]}"
            existing = cooldown.get(cd_key, 0)
            if existing < cooldown_until:  # don't shorten an existing cooldown
                cooldown[cd_key] = cooldown_until
                n += 1
    return n


# ── Scoring ──────────────────────────────────────────────────────────────────

def gather_engine_rounds(arena: str) -> Dict[str, List[Tuple[float, float]]]:
    """Returns engine_id -> [(timestamp_unix, pnl), ...] for rounds where
    engine fired (tradeCount > 0 or pnl != 0)."""
    history = load_round_history(arena)
    out: Dict[str, List[Tuple[float, float]]] = defaultdict(list)
    for r in history:
        try:
            ts_ms = int(r["roundId"].split("-")[1])
        except Exception:
            continue
        ts = ts_ms / 1000
        for e in r.get("allResults", []):
            eid = e.get("engineId", "")
            if not eid:
                continue
            tr = e.get("tradeCount", 0)
            pnl = e.get("totalPnl", 0)
            if tr > 0 or pnl != 0:
                out[eid].append((ts, pnl))
    # Sort each chronologically
    for eid in out:
        out[eid].sort()
    return out


def recent_sharpe(pnls: List[float]) -> float:
    """Shrunken Sharpe ratio across last RECENT_N firing rounds.

    Bayesian-style shrinkage: multiply raw sharpe by n/(n+K). This pulls
    sharpe toward 0 for small samples — a 3-round engine with apparent
    Sharpe 7.4 gets shrunk to 7.4 * 3/8 = 2.78, while a 20-round engine
    keeps most of its score (20/25 = 0.80x).
    """
    if len(pnls) < 2:
        return 0.0
    recent = pnls[-RECENT_N:]
    m = statistics.mean(recent)
    sd = statistics.stdev(recent)
    if sd == 0:
        return m
    raw_sharpe = m / sd
    n = len(recent)
    return raw_sharpe * (n / (n + SHRINKAGE_K))


def passes_safe_filter(pnls: List[float]) -> bool:
    """Worst single firing round >= -SAFE_LOSS_USD (matches cross-arena
    classification: SAFE = worst > -$20 against $50 sim bankroll)."""
    if not pnls:
        return False
    return min(pnls) >= -SAFE_LOSS_USD


def loss_streak(pnls: List[float]) -> int:
    """Current trailing loss streak (consecutive negative rounds at end)."""
    n = 0
    for p in reversed(pnls):
        if p < 0:
            n += 1
        else:
            break
    return n


# ── Regime detection ─────────────────────────────────────────────────────────

def fetch_realized_vols() -> Dict[str, float]:
    """Direct fetch BTCUSDT realized vol from Binance klines.
    Computes 5m / 1h / 1d annualized vol from 1m candles.

    Avoids npm dependency in cron context. Falls back to cached file
    on network failure.
    """
    import urllib.request, urllib.error, math
    cache = DATA_DIR / "last_signals.json"

    def fetch_klines(interval: str, limit: int) -> List[float]:
        url = f"https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval={interval}&limit={limit}"
        req = urllib.request.Request(url, headers={"User-Agent": "quant-farm/1.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        # Each kline: [openTime, open, high, low, close, volume, ...]
        return [float(k[4]) for k in data]

    def annualized_vol(closes: List[float], periods_per_year: float) -> float:
        if len(closes) < 2: return 0.0
        rets = [math.log(closes[i]/closes[i-1]) for i in range(1, len(closes)) if closes[i-1] > 0]
        if len(rets) < 2: return 0.0
        m = sum(rets)/len(rets)
        var = sum((r-m)**2 for r in rets)/(len(rets)-1)
        return math.sqrt(var * periods_per_year) * 100  # percent

    try:
        # 5m window: 5 1m candles → 5m realized vol annualized via per-minute
        closes_5 = fetch_klines("1m", 6)  # need 6 to get 5 returns
        v5 = annualized_vol(closes_5, 525_600)  # 525_600 minutes/year
        # 1h window: 60 1m candles
        closes_60 = fetch_klines("1m", 60)
        v1h = annualized_vol(closes_60, 525_600)
        # 1d window: 24 1h candles
        closes_d = fetch_klines("1h", 24)
        v1d = annualized_vol(closes_d, 8_760)  # hours/year
        sig = {"vol5m": v5, "vol1h": v1h, "vol1d": v1d, "ts": time.time()}
        atomic_write_json(cache, sig)
        return sig
    except Exception as e:
        log(f"warn: realized vol fetch failed: {e}; falling back to cache")
        if cache.exists():
            try:
                return json.loads(cache.read_text())
            except Exception:
                pass
        return {}


def current_regime() -> str:
    """Classify current regime from realized BTCUSDT vol.

    Categories:
      SPIKE: realized 5m > 1h * 1.3 (short-term spikiness)
      QUIET: realized 5m < 1h * 0.7 (compression)
      TREND: 1h > 1d (medium-term elevated vol)
      CHOP: default
    """
    sig = fetch_realized_vols()
    if not sig:
        return "UNKNOWN"
    v5 = sig.get("vol5m", 0) or 0
    v1h = sig.get("vol1h", 0) or 0
    v1d = sig.get("vol1d", 0) or 0
    if v5 > v1h * 1.3 and v1h > 0:
        return "SPIKE"
    if v5 < v1h * 0.7 and v1h > 0:
        return "QUIET"
    if v1h > v1d and v1d > 0:
        return "TREND"
    return "CHOP"


def regime_fit_mult(engine_id: str, arena: str, regime: str) -> float:
    """How well does this engine fit the current regime? Phase 1a uses a simple
    hand-coded mapping based on engine semantics. Phase 2 will use
    engineRegimeReport.py output for data-driven fit.
    """
    if regime == "UNKNOWN":
        return REGIME_NEUTRAL_MULT

    # Hand-coded for Phase 1a — based on observed performance + thesis
    fits: Dict[str, Dict[str, float]] = {
        "signal-contrarian-v1": {  # F&G/funding extreme contrarian
            "SPIKE": REGIME_POSITIVE_MULT,
            "CHOP": REGIME_POSITIVE_MULT,
            "TREND": REGIME_NEGATIVE_MULT,
            "QUIET": REGIME_NEUTRAL_MULT,
        },
        "spread-compression-v1": {  # microstructure-based, regime-agnostic
            "SPIKE": REGIME_NEUTRAL_MULT,
            "CHOP": REGIME_POSITIVE_MULT,
            "TREND": REGIME_NEUTRAL_MULT,
            "QUIET": REGIME_POSITIVE_MULT,
        },
        "book-imbalance-v1": {  # microstructure, regime-orthogonal
            "SPIKE": REGIME_NEUTRAL_MULT,
            "CHOP": REGIME_NEUTRAL_MULT,
            "TREND": REGIME_NEUTRAL_MULT,
            "QUIET": REGIME_NEUTRAL_MULT,
        },
        "depth-drain-v1": {  # microstructure
            "SPIKE": REGIME_NEUTRAL_MULT,
            "CHOP": REGIME_POSITIVE_MULT,
            "TREND": REGIME_NEUTRAL_MULT,
            "QUIET": REGIME_NEUTRAL_MULT,
        },
        "momentum-settle-v1": {  # late-window directional
            "SPIKE": REGIME_NEGATIVE_MULT,
            "CHOP": REGIME_NEUTRAL_MULT,
            "TREND": REGIME_POSITIVE_MULT,
            "QUIET": REGIME_NEUTRAL_MULT,
        },
        "maker-momentum-v1": {  # directional maker
            "SPIKE": REGIME_NEGATIVE_MULT,
            "CHOP": REGIME_NEUTRAL_MULT,
            "TREND": REGIME_POSITIVE_MULT,
            "QUIET": REGIME_NEUTRAL_MULT,
        },
        "stingo43-late-v1": {  # late-window momentum
            "SPIKE": REGIME_NEGATIVE_MULT,
            "CHOP": REGIME_NEUTRAL_MULT,
            "TREND": REGIME_POSITIVE_MULT,
            "QUIET": REGIME_NEUTRAL_MULT,
        },
        "bred-jp1t": {  # mid-window pattern
            "SPIKE": REGIME_NEUTRAL_MULT,
            "CHOP": REGIME_POSITIVE_MULT,
            "TREND": REGIME_NEUTRAL_MULT,
            "QUIET": REGIME_NEUTRAL_MULT,
        },
        "bred-4h85-maker-v1": {  # high-variance directional maker
            "SPIKE": REGIME_NEGATIVE_MULT,
            "CHOP": REGIME_NEUTRAL_MULT,
            "TREND": REGIME_POSITIVE_MULT,
            "QUIET": REGIME_NEUTRAL_MULT,
        },
        "chop-fader-v1": {
            "SPIKE": REGIME_NEUTRAL_MULT,
            "CHOP": REGIME_POSITIVE_MULT,
            "TREND": REGIME_NEGATIVE_MULT,
            "QUIET": REGIME_POSITIVE_MULT,
        },
    }
    eng_fits = fits.get(engine_id, {})
    return eng_fits.get(regime, REGIME_NEUTRAL_MULT)


# ── Engine-class sim:live calibration ────────────────────────────────────────

# Empirical sim:live ratios observed over the past month (May 2026):
# - momentum-settle family @ sol-4h: ratio ~0.7-1.0 (sim slightly optimistic, close)
# - extreme-price contrarian (chop-fader, signal-contrarian): ratio ~ -0.5 (sim said +$15 → live -$7)
# - maker-fill heavy (maker-momentum, maker-merge-arb): ratio ~0.3 (sim too generous on fill prob)
# - regime-gated (vol-regime-gate family): TBD — never validated live, default conservative
# - bred-* engines: highly variable, default conservative until each is proven
# Haircut is applied as a multiplier on the score AFTER all other penalties.

CLASS_HAIRCUTS = {
    "momentum-settle": 1.0,        # proven family — momentum-settle-v1 + variants
    "vol-regime-gate": 0.6,        # gated, mid-price typically — modest haircut
    "rotation-fade": 0.6,          # modest haircut, mid-price hold pattern
    "baguette-drift": 0.6,         # similar
    "depth-drain": 0.4,            # one live test was a loss; conservative
    "spread-compression": 0.5,     # was live winning then bleeding; ambiguous
    "stingo43": 0.4,               # extreme entries documented
    "chop-fader": 0.0,             # blacklisted entirely — defensive belt
    "maker-momentum": 0.3,         # maker-stack class
    "maker-merge-arb": 0.3,
    "maker-settle": 0.3,
    "maker-queue-edge": 0.3,
    "dca-extreme": 0.2,            # name says "extreme" — adverse selection class
    "dca-native-tick": 0.2,        # high best/worst spread = extreme-price
    "dca-settle": 0.4,
    "bred-": 0.5,                  # all bred engines until individually proven
    "book-imbalance": 0.4,         # microstructure — typically diverges
    "trend-confirmer": 0.6,
    "adaptive-trend": 0.6,
}

DEFAULT_CLASS_HAIRCUT = 0.5


def engine_class_haircut(engine_id: str, arena: str, rounds: List[Tuple[float, float]]) -> float:
    """Returns multiplier in (0, 1] for sim:live calibration. Lower = less trust.

    Uses (engine_id, arena) blacklist first (hard-coded 0 for proven divergers),
    then engine prefix lookup, then a conservative default.

    If engine has 5+ live settles with positive realized PnL, bump back to 1.0
    (live-validated overrides the conservative default).
    """
    # Sim_unreliable check is upstream; engines getting here aren't blacklisted.
    # Live-validated takes precedence over class default.
    t_status, _realized = trial_status(engine_id, arena)
    if t_status == "validated_positive":
        return 1.0

    for prefix, mult in CLASS_HAIRCUTS.items():
        if engine_id.startswith(prefix):
            return mult
    return DEFAULT_CLASS_HAIRCUT


# ── Selection ────────────────────────────────────────────────────────────────

def candidates(
    regime: str,
    cooldown: Dict[str, float],
    current_set: set,
    live_pnl_by_coin: Dict[str, float],
    sim_unreliable: set[tuple[str, str]] | None = None,
) -> List[Dict[str, Any]]:
    """Build scored candidate list across all (engine, arena) pairs.

    Score = recent_sharpe × regime_fit × incumbent_bonus × live_pnl_penalty
    Hard filters: SAFE worst-round, MIN_ROUNDS, cooldown, sim-unreliable blacklist.
    """
    now = time.time()
    sim_unreliable = sim_unreliable or set()
    out = []
    for arena in ARENAS:
        coin_upper = arena.split("-")[0].upper()
        per_engine = gather_engine_rounds(arena)
        for engine_id, rounds in per_engine.items():
            if (engine_id, arena) in sim_unreliable:
                continue
            if len(rounds) < MIN_ROUNDS:
                continue
            pnls = [p for _, p in rounds]
            if not passes_safe_filter(pnls):
                continue
            cd_key = f"{engine_id}:{arena}"
            cd_until = cooldown.get(cd_key, 0)
            if cd_until > now:
                continue
            # Trial gate: if engine has TRIAL_FIRE_COUNT+ live settles AND net
            # negative realized PnL, exclude — sim signal didn't translate.
            t_status, _ = trial_status(engine_id, arena)
            if t_status == "validated_negative":
                continue
            sharpe = recent_sharpe(pnls)
            if sharpe <= 0:
                continue
            mult = regime_fit_mult(engine_id, arena, regime)
            incumbent = (engine_id, arena) in current_set
            inc_bonus = (1 + INCUMBENT_BONUS) if incumbent else 1.0
            # Live PnL drift penalty: if this engine's coin has bled below the
            # threshold in the last LIVE_PNL_LOOKBACK_HOURS, penalize.
            # Skip incumbents — they're holding positions and we already trust them.
            coin_drift = live_pnl_by_coin.get(coin_upper, 0)
            live_penalty = 1.0
            if not incumbent and coin_drift < LIVE_PNL_LOSS_THRESHOLD:
                live_penalty = LIVE_PNL_LOSS_PENALTY
            # Compound penalty floor: cap multiplicative penalties so a proven
            # winner with both regime + live-PnL penalties (0.5×0.5=0.25)
            # doesn't drop below 0.5×. Only applies on the multiplicative
            # penalty side, not the incumbent bonus.
            penalty_product = mult * live_penalty
            if penalty_product < MIN_PENALTY_FLOOR:
                penalty_product = MIN_PENALTY_FLOOR
            # Engine-class haircut: apply sim:live calibration multiplier based
            # on the engine's strategy class (extreme-price, maker-stack, etc).
            # Conservative defaults until live history validates each class.
            haircut = engine_class_haircut(engine_id, arena, rounds)
            score = sharpe * penalty_product * inc_bonus * haircut
            out.append({
                "engine_id": engine_id,
                "arena": arena,
                "coin": arena.split("-")[0],
                "n_rounds": len(rounds),
                "sharpe": sharpe,
                "mult": mult,
                "incumbent": incumbent,
                "live_penalty": live_penalty,
                "score": score,
                "worst": min(pnls),
                "best": max(pnls),
                "recent_pnl": sum(pnls[-RECENT_N:]),
                "loss_streak": loss_streak(pnls),
            })
    out.sort(key=lambda c: c["score"], reverse=True)
    return out


def construct_roster(cands: List[dict], k: int = ROSTER_SIZE) -> List[dict]:
    """Pick top K (engine, arena) candidates by score. There are no slots
    — each (engine, arena) pair stands on its own evidence.

    Dedup is on (engine_id, arena), not engine_id — the same engine_id
    CAN run on multiple arenas (different markets, independent state).
    Coin cap is the only diversification rule, to bound concentration risk.
    """
    chosen: List[dict] = []
    used_pairs: set = set()
    coin_counts: Dict[str, int] = defaultdict(int)
    max_per_coin = 5  # bumped from 3 along with ROSTER_SIZE → 10

    for c in cands:
        if len(chosen) >= k:
            break
        pair = (c["engine_id"], c["arena"])
        if pair in used_pairs:
            continue
        if coin_counts[c["coin"]] >= max_per_coin:
            continue
        chosen.append(c)
        used_pairs.add(pair)
        coin_counts[c["coin"]] += 1
    return chosen


# ── Roster diff + write ──────────────────────────────────────────────────────

def current_roster_set(live: Dict[str, list]) -> set:
    return {(r.get("engineId"), r.get("arenaInstanceId") or arena) for arena, recs in live.items() for r in recs}


@functools.lru_cache(maxsize=1)
def _read_live_ledger_cached() -> List[dict]:
    """Read live_trades.jsonl once per main() invocation."""
    if not LIVE_LEDGER_PATH.exists():
        return []
    rows = []
    with LIVE_LEDGER_PATH.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def trial_status(engine_id: str, arena: str) -> Tuple[str, float]:
    """Returns (status, realized_pnl) where status is one of:
      - 'trial' — < TRIAL_FIRE_COUNT settled live fires
      - 'validated_positive' — N+ settles, realized PnL >= 0
      - 'validated_negative' — N+ settles, realized PnL < 0
    Used to gate promotion sizing + filter candidates that have failed trial.
    """
    rows = _read_live_ledger_cached()
    fills = sum(1 for r in rows
                if r.get("type") == "FILL"
                and r.get("side") == "BUY"
                and r.get("engineId") == engine_id
                and r.get("arenaInstanceId") == arena)
    settles = [r for r in rows
               if r.get("type") == "SETTLE"
               and r.get("arenaInstanceId") == arena
               and r.get("engineId") == engine_id]
    realized = sum(r.get("pnl", 0) for r in settles)
    n_settled = len(settles)
    if n_settled < TRIAL_FIRE_COUNT:
        return ("trial", realized)
    return ("validated_positive" if realized >= 0 else "validated_negative", realized)


def proposed_roster_dict(chosen: List[dict], bankroll: float) -> Dict[str, list]:
    today = dt.date.today().isoformat()
    out: Dict[str, list] = {}
    for c in chosen:
        status, _realized = trial_status(c["engine_id"], c["arena"])
        # Trial engines run at small bankroll until proven; validated engines
        # get full bankroll. Negative-validated engines should have been
        # filtered upstream in candidates() — defensive double-check.
        if status == "validated_negative":
            continue
        actual_bankroll = TRIAL_BANKROLL_USD if status == "trial" else bankroll
        out[c["arena"]] = [{
            "engineId": c["engine_id"],
            "coin": c["coin"],
            "arenaInstanceId": c["arena"],
            "bankrollUsd": actual_bankroll,
            "trialStatus": status,
            "graduationRoundId": f"auto-{today}-{c['engine_id']}-{c['arena']}",
            "graduatedAt": today,
        }]
    return out


def score_for_pair(cands: List[dict], engine_id: str, arena: str) -> float:
    for c in cands:
        if c["engine_id"] == engine_id and c["arena"] == arena:
            return c["score"]
    return 0.0


def should_swap(current_set: set, proposed_set: set, cands: List[dict]) -> Tuple[bool, str]:
    """Should we swap? True if any new pair beats existing pair by SWAP_THRESHOLD."""
    if current_set == proposed_set:
        return False, "no-change"
    if not current_set:
        return True, "empty-current-roster"

    # Compute aggregate score of current vs proposed
    curr_score = sum(score_for_pair(cands, eng, arena) for eng, arena in current_set)
    prop_score = sum(score_for_pair(cands, eng, arena) for eng, arena in proposed_set)
    if curr_score == 0:
        return True, f"current score=0; proposed={prop_score:.2f}"
    ratio = prop_score / curr_score
    if ratio > 1 + SWAP_THRESHOLD:
        return True, f"score ratio {ratio:.2f} > 1+{SWAP_THRESHOLD}"
    return False, f"score ratio {ratio:.2f} below threshold"


# ── Logging ──────────────────────────────────────────────────────────────────

def log(msg: str) -> None:
    """Write to ROTATION_LOG file. Stdout is captured separately by cron via
    redirect — log() doesn't print() to avoid duplication when the script
    runs under cron with `>> data/auto_rotation.log 2>&1`.
    """
    line = f"[{dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S')}Z] {msg}"
    try:
        ROTATION_LOG.parent.mkdir(parents=True, exist_ok=True)
        with ROTATION_LOG.open("a") as f:
            f.write(line + "\n")
    except Exception:
        pass
    # Also print so interactive runs show output. Under cron, stdout redirects
    # to ROTATION_LOG would duplicate — but new crontab pipes stdout to
    # /dev/null and only relies on log() for persistent decisions.
    print(line)


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true",
                    help="actually swap (default is dry-run)")
    ap.add_argument("--bankroll", type=float, default=LIVE_BANKROLL_USD,
                    help="bankroll to use for SAFE filter")
    args = ap.parse_args()

    if DISABLED_FLAG.exists():
        log("auto_rotation.disabled exists — exiting without changes")
        return 0

    regime = current_regime()
    log(f"current regime: {regime}")

    cooldown = load_cooldown()
    current = load_live_engines()
    current_set = current_roster_set(current)

    # Manual-cull detection: anything in last_seen but missing from current
    # = user manually removed it. Apply cooldown so we don't re-add it.
    last_seen = load_last_seen_roster()
    n_culled = detect_and_record_manual_culls(current_set, last_seen, cooldown)
    if n_culled > 0:
        log(f"detected {n_culled} manual cull(s) — applied {COOLDOWN_HOURS}h cooldown")
        save_cooldown(cooldown)

    # Streak cull: any incumbent with N consecutive sim losses gets removed +
    # cooled, regardless of aggregate sharpe. Pre-filter before scoring.
    streak_culls = detect_streak_culls(current_set, cooldown)
    for engine_id, arena in streak_culls:
        log(f"[streak_cull] {engine_id}@{arena}: {STREAK_CULL_N}L sim streak — applied {COOLDOWN_HOURS}h cooldown")
        current_set.discard((engine_id, arena))
    if streak_culls:
        save_cooldown(cooldown)

    # Live-PnL drift feedback: penalize coins that have been bleeding live
    live_pnl = fetch_live_pnl_by_coin()
    if live_pnl:
        log(f"live PnL last {LIVE_PNL_LOOKBACK_HOURS}h: " + ", ".join(f"{c}=${v:+.2f}" for c, v in live_pnl.items()))

    sim_unreliable = load_sim_unreliable()
    if sim_unreliable:
        log(f"sim_unreliable blacklist: {len(sim_unreliable)} (engine, arena) pair(s) excluded")

    cands = candidates(regime, cooldown, current_set, live_pnl, sim_unreliable)
    log(f"candidates passing SAFE+cooldown: {len(cands)}")

    chosen = construct_roster(cands)
    log(f"proposed roster: {len(chosen)} engines")
    print()
    print(f"{'Rank':<5} {'Engine':<26} {'Arena':<10} {'N':<4} {'Sharpe':<7} {'Mult':<5} {'LP':<5} {'Score':<7} {'Worst':<7} {'Inc'}")
    print("-" * 100)
    for i, c in enumerate(chosen):
        inc = "★" if c["incumbent"] else ""
        print(f"{i+1:<5} {c['engine_id']:<26} {c['arena']:<10} {c['n_rounds']:<4} {c['sharpe']:<7.2f} {c['mult']:<5.1f} {c.get('live_penalty',1.0):<5.2f} {c['score']:<7.2f} ${c['worst']:<6.0f} {inc}")
    print()

    proposed = proposed_roster_dict(chosen, args.bankroll)
    proposed_set = current_roster_set(proposed)

    do_swap, reason = should_swap(current_set, proposed_set, cands)
    print(f"current: {sorted(current_set)}")
    print(f"proposed: {sorted(proposed_set)}")
    print(f"swap decision: {do_swap}  ({reason})")
    print()

    # Force swap if streak culls fired — they need to leave the roster even
    # if no replacement is compelling enough to pass the swap threshold.
    if streak_culls and not do_swap:
        do_swap, reason = True, f"forced by {len(streak_culls)} streak cull(s)"
        log(f"swap forced — {reason}")

    if not do_swap:
        log("no swap — current roster acceptable")
        save_last_seen_roster(current_set)
        return 0

    # Diff
    added = proposed_set - current_set
    removed = current_set - proposed_set
    print(f"adds:    {sorted(added)}")
    print(f"removes: {sorted(removed)}")
    print()

    if not args.commit:
        log("DRY RUN — would swap but --commit not set. No changes written.")
        save_last_seen_roster(current_set)  # track current state for next run's manual-cull detection
        return 0

    # Backup + atomic write. Keep last 10 backups to avoid unbounded growth.
    if LIVE_ENGINES_PATH.exists():
        bak = LIVE_ENGINES_PATH.with_suffix(f".json.bak.auto_{int(time.time())}")
        bak.write_text(LIVE_ENGINES_PATH.read_text())
        log(f"backup: {bak}")
        # Prune oldest auto-backups beyond the last 10
        backups = sorted(LIVE_ENGINES_PATH.parent.glob("live_engines.json.bak.auto_*"))
        for old in backups[:-10]:
            try: old.unlink()
            except Exception: pass
    atomic_write_json(LIVE_ENGINES_PATH, proposed)
    log(f"wrote new roster to {LIVE_ENGINES_PATH} (atomic)")

    # Update cooldown for removed pairs
    now = time.time()
    cooldown_until = now + COOLDOWN_HOURS * 3600
    for eng, arena in removed:
        cooldown[f"{eng}:{arena}"] = cooldown_until
    save_cooldown(cooldown)
    save_last_seen_roster(proposed_set)
    log(f"cooldown set on {len(removed)} swapped-out pairs until +{COOLDOWN_HOURS}h")

    return 0


if __name__ == "__main__":
    sys.exit(main())
