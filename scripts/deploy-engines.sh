#!/bin/bash
set -e

# Surgical engine-only deploy — ships src/engines/*.ts changes to VPS WITHOUT
# disrupting in-flight rounds. Excludes BredEngine_* (those are managed
# server-side by the breeder). Touches a per-coin reload flag that the arena
# main loop checks at every round boundary; on the next round start, the
# arena clears its require cache and re-loads the engine roster.
#
# Use this for: hand-built engine additions/edits/deletions, base class
# tweaks that only affect engines.
#
# DO NOT use this for: arena.ts / referee.ts / pulse.ts changes — those
# need a full deploy.sh because they're not loaded via the engine cache
# clear path.
#
# Usage:
#   bash scripts/deploy-engines.sh             # all 3 coins
#   bash scripts/deploy-engines.sh btc         # only BTC
#   bash scripts/deploy-engines.sh btc eth     # BTC + ETH

REMOTE_HOST="${VPS_HOST:-root@165.232.84.91}"
REMOTE_DIR="~/quant-arena"

# Coins to flag for reload — defaults to all 3 if no arg given
COINS=("$@")
if [ ${#COINS[@]} -eq 0 ]; then
  COINS=(btc eth sol)
fi

echo "Surgical engine-only deploy → $REMOTE_HOST"
echo "Reload coins: ${COINS[*]}"

# 1. Local build — verify TypeScript compiles before shipping. Faster failure
#    than discovering it on the VPS after rsync.
echo "[1/4] Local TypeScript check..."
npx tsc --noEmit

# 2. Rsync ONLY src/engines (no --delete, no other files). BredEngine_* are
#    excluded so we don't clobber breeder output.
echo "[2/4] Rsync src/engines/ ..."
rsync -avz \
  --exclude 'BredEngine_*' \
  src/engines/ "$REMOTE_HOST:$REMOTE_DIR/src/engines/"

# 3. Remote tsc compile (only what's changed lands in dist/engines/)
echo "[3/4] Remote tsc..."
ssh "$REMOTE_HOST" "cd $REMOTE_DIR && npx tsc"

# 4. Touch reload flag for each arena instance per coin (4 instances each).
#    Per-instance flags fix starvation bug discovered Apr 27 — sibling
#    arenas used to fight over a shared per-coin flag.
echo "[4/4] Touching reload flags (4 arena instances per coin)..."
FLAG_PATHS=()
for coin in "${COINS[@]}"; do
  for suffix in "" "-15m" "-1h" "-4h"; do
    FLAG_PATHS+=("$REMOTE_DIR/data/reload_engines_${coin}${suffix}.flag")
  done
done
# Single ssh call for all flags — saves ~2s per deploy vs 12 round-trips.
ssh "$REMOTE_HOST" "touch ${FLAG_PATHS[*]}"
for p in "${FLAG_PATHS[@]}"; do echo "  → $(basename $p)"; done

echo ""
echo "Engine deploy complete."
echo "Reload happens at next round boundary for: ${COINS[*]}"
echo "Check: ssh $REMOTE_HOST 'pm2 logs quant-arena-btc --lines 30 --nostream | grep reload'"
