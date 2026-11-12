#!/usr/bin/env bash
set -e

echo "=== [1/5] Configuring Node.js 22 LTS on Lightsail Instance ==="
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 20 ]; then
  echo "Installing Node.js 22 LTS via NodeSource..."
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "Node.js already installed: $(node -v)"
fi

echo "=== [2/5] Setting up destination directory /var/www/nepnha-viewer ==="
sudo mkdir -p /var/www/nepnha-viewer
sudo chown -R $USER:$USER /var/www/nepnha-viewer

echo "Extracting deployment archive..."
tar -xzf /tmp/nepnha-deploy.tar.gz -C /var/www/nepnha-viewer
sudo mkdir -p /var/www/nepnha-viewer/data

echo "=== [3/5] Installing Systemd Service for Port 99 ==="
sudo cp /var/www/nepnha-viewer/deploy/nepnha-viewer.service /etc/systemd/system/nepnha-viewer.service
sudo systemctl daemon-reload
sudo systemctl enable nepnha-viewer.service

echo "=== [4/5] Configuring Firewall (UFW) for Port 99 ==="
if command -v ufw >/dev/null 2>&1; then
  sudo ufw allow 99/tcp comment 'Nep Nha 3D Viewer'
  sudo ufw allow 22/tcp comment 'SSH'
  sudo ufw reload || true
  echo "UFW rule for port 99/tcp enabled."
fi

echo "=== [5/5] Starting Nep Nha Service on Port 99 ==="
sudo systemctl restart nepnha-viewer.service
sleep 2

echo "Testing local endpoint http://localhost:99/api/health :"
curl -s http://localhost:99/api/health || true
echo ""

echo "=== Service Status ==="
sudo systemctl status nepnha-viewer.service --no-pager

echo ""
echo "============================================================"
echo " Deployment Complete! Service is running on Port 99."
echo " IMPORTANT: Ensure Port 99 is opened in AWS Lightsail Console:"
echo " Lightsail -> Networking -> IPv4 Firewall -> Add Rule -> Custom TCP 99"
echo "============================================================"
