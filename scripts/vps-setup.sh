#!/bin/bash
set -e

echo "=== Quant Arena VPS Setup ==="

# 1. Swap (4GB safety net)
if [ ! -f /swapfile ]; then
  echo "[1/5] Creating 4GB swap..."
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
else
  echo "[1/5] Swap already exists, skipping"
fi

# 2. System packages
echo "[2/5] Installing system packages..."
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential ufw

# 3. Node.js 22 LTS
if ! command -v node &>/dev/null; then
  echo "[3/5] Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
else
  echo "[3/5] Node.js already installed: $(node -v)"
fi

# 4. PM2
echo "[4/5] Installing PM2..."
sudo npm install -g pm2
pm2 startup systemd -u $USER --hp $HOME 2>/dev/null || true

# 5. Firewall
echo "[5/5] Configuring firewall..."
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow ssh
sudo ufw --force enable

echo ""
echo "=== Setup Complete ==="
echo "Node: $(node -v)"
echo "NPM: $(npm -v)"
echo "PM2: $(pm2 -v)"
echo ""
echo "Next: run 'npm run deploy' from your local machine"
