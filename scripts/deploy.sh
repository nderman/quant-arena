#!/bin/bash
set -e

# Config — set your VPS IP here or via env
REMOTE_HOST="${VPS_HOST:-root@165.22.29.245}"
REMOTE_DIR="~/quant-arena"

echo "Deploying to $REMOTE_HOST..."

# 1. Build locally first
echo "[1/3] Building TypeScript..."
npm run build

# 2. Sync files (exclude dev stuff, local data, node_modules)
echo "[2/3] Syncing files..."
rsync -avz --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'data' \
  --exclude 'logs' \
  --exclude '.env' \
  --exclude 'src/engines/BredEngine_*' \
  --exclude 'dist/engines/BredEngine_*' \
  ./ "$REMOTE_HOST:$REMOTE_DIR/"

# 3. Remote: install deps and restart
echo "[3/3] Installing deps and restarting..."
ssh "$REMOTE_HOST" << 'EOF'
  cd ~/quant-arena
  mkdir -p data logs data/engines_archive
  npm install
  npx tsc
  pm2 restart ecosystem.config.js --env production 2>/dev/null || pm2 start ecosystem.config.js --env production
  pm2 save
EOF

echo ""
echo "Deploy complete. Check status: ssh $REMOTE_HOST 'pm2 logs quant-arena --lines 20'"
