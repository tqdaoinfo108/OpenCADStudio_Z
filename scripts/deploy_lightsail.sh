#!/usr/bin/env bash
# ==============================================================================
# Tự động deploy ứng dụng Web 3D Dollhouse lên AWS Lightsail (Port 99)
# ==============================================================================

set -e

KEY_PATH="${KEY_PATH:-c/Users/qdaoc/Downloads/LightsailDefaultKey-ap-southeast-2.pem}"
SERVER_PORT="${SERVER_PORT:-99}"
SSH_USER="${SSH_USER:-ubuntu}"
REMOTE_DIR="${REMOTE_DIR:-~/nepnha-web-viewer}"
SERVER_IP="$1"

if [ -z "$SERVER_IP" ]; then
    read -p "👉 Nhập Public IP của máy chủ Lightsail: " SERVER_IP
fi

if [ -z "$SERVER_IP" ]; then
    echo "❌ Lỗi: Server IP không được để trống!"
    exit 1
fi

# Chuyển đổi đường dẫn Windows sang POSIX nếu cần
if [[ "$KEY_PATH" =~ ^[a-zA-Z]: ]]; then
    DRIVE=$(echo "$KEY_PATH" | cut -c1 | tr '[:upper:]' '[:lower:]')
    REST=$(echo "$KEY_PATH" | cut -c3- | tr '\\' '/')
    KEY_PATH="/$DRIVE$REST"
fi

chmod 400 "$KEY_PATH" 2>/dev/null || true

echo "==> [1/4] Đóng gói mã nguồn web-viewer..."
ARCHIVE_PATH="/tmp/nepnha-deploy.tar.gz"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR/web-viewer"
tar -czf "$ARCHIVE_PATH" \
    --exclude="node_modules" \
    --exclude=".git" \
    --exclude=".vite" \
    --exclude="*.log" \
    .

echo "==> [2/4] Upload gói ứng dụng lên $SERVER_IP..."
scp -i "$KEY_PATH" -o StrictHostKeyChecking=no "$ARCHIVE_PATH" "$SSH_USER@$SERVER_IP:/tmp/nepnha-deploy.tar.gz"

echo "==> [3/4] Cài đặt và khởi chạy trên server tại Port $SERVER_PORT..."
ssh -i "$KEY_PATH" -o StrictHostKeyChecking=no "$SSH_USER@$SERVER_IP" bash -s << REMOTE_EOF
set -e
mkdir -p "$REMOTE_DIR"
tar -xzf /tmp/nepnha-deploy.tar.gz -C "$REMOTE_DIR"
rm -f /tmp/nepnha-deploy.tar.gz
cd "$REMOTE_DIR"

export PORT=$SERVER_PORT
export HOST=0.0.0.0
export NODE_ENV=production

if command -v docker &> /dev/null && (docker compose version &> /dev/null || docker-compose version &> /dev/null); then
    echo "Deploying via Docker..."
    sed -i -E 's/"[0-9]+:3000"/"$SERVER_PORT:3000"/g' docker-compose.yml || true
    sed -i -E 's/"[0-9]+:[0-9]+"/"$SERVER_PORT:$SERVER_PORT"/g' docker-compose.yml || true
    sed -i -E 's/PORT=[0-9]+/PORT=$SERVER_PORT/g' docker-compose.yml || true
    docker compose up -d --build 2>/dev/null || docker-compose up -d --build
else
    echo "Deploying via Node.js PM2..."
    if ! command -v node &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs || sudo yum install -y nodejs
    fi
    sudo npm install -g pnpm pm2 2>/dev/null || true
    pnpm install --frozen-lockfile || npm install
    pnpm build || npm run build || true
    pm2 delete nepnha-web-viewer 2>/dev/null || true
    PORT=$SERVER_PORT HOST=0.0.0.0 pm2 start server/index.js --name "nepnha-web-viewer" --time
    pm2 save || true
fi

if command -v ufw &> /dev/null; then
    sudo ufw allow $SERVER_PORT/tcp || true
fi

sleep 3
curl -s -I "http://localhost:$SERVER_PORT/" || true
REMOTE_EOF

echo "=========================================================="
echo "🎉 DEPLOY THÀNH CÔNG!"
echo "🌐 URL: http://$SERVER_IP:$SERVER_PORT"
echo "⚠️  Lưu ý mở Port $SERVER_PORT (TCP) trong Firewall tab của AWS Lightsail Console."
echo "=========================================================="
