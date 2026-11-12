#!/usr/bin/env bash
set -e

KEY_PATH="${KEY_PATH:-c/Users/qdaoc/Downloads/LightsailDefaultKey-ap-southeast-2.pem}"
if [ ! -f "$KEY_PATH" ]; then
  KEY_PATH="${HOME}/Downloads/LightsailDefaultKey-ap-southeast-2.pem"
fi
PORT="${PORT:-99}"
REMOTE_USER="${REMOTE_USER:-ubuntu}"
SERVER_IP="$1"

if [ -z "$SERVER_IP" ]; then
  read -rp "Nhập địa chỉ Public IP của máy chủ AWS Lightsail: " SERVER_IP
fi

if [ -z "$SERVER_IP" ]; then
  echo "Lỗi: Địa chỉ IP không được để trống!"
  exit 1
fi

chmod 400 "$KEY_PATH" 2>/dev/null || true

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VIEWER_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== [1/4] Building Frontend Assets (pnpm build) ==="
cd "$VIEWER_DIR"
pnpm build

echo "=== [2/4] Packaging deployment archive ==="
ARCHIVE="/tmp/nepnha-deploy.tar.gz"
rm -f "$ARCHIVE"
tar -czf "$ARCHIVE" \
  --exclude="node_modules" \
  --exclude=".git" \
  --exclude="target" \
  index.html package.json css js vendor server dist data deploy

echo "=== [3/4] Uploading to Lightsail instance ($SERVER_IP) ==="
scp -i "$KEY_PATH" -o StrictHostKeyChecking=no "$ARCHIVE" "$REMOTE_USER@$SERVER_IP:/tmp/nepnha-deploy.tar.gz"

echo "=== [4/4] Executing remote setup on instance ==="
ssh -i "$KEY_PATH" -o StrictHostKeyChecking=no "$REMOTE_USER@$SERVER_IP" "bash -s" << 'EOF'
sudo mkdir -p /var/www/nepnha-viewer
tar -xzf /tmp/nepnha-deploy.tar.gz -C /tmp/
chmod +x /tmp/deploy/setup_remote.sh
/tmp/deploy/setup_remote.sh
EOF

echo ""
echo "============================================================"
echo " DEPLOY HOÀN TẤT!"
echo " Truy cập ứng dụng tại: http://${SERVER_IP}:${PORT}/"
echo " Đảm bảo đã mở Custom TCP Port ${PORT} trên AWS Lightsail Firewall!"
echo "============================================================"
