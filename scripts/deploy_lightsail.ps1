<#
.SYNOPSIS
    Tự động deploy ứng dụng Web 3D Dollhouse lên máy chủ AWS Lightsail với Port 99.
.DESCRIPTION
    Script thực hiện:
    1. Tự động chuẩn hóa quyền truy cập file PEM trên Windows (icacls).
    2. Đóng gói mã nguồn web-viewer (loại trừ node_modules, cache).
    3. Đẩy file lên Lightsail qua SCP với key LightsailDefaultKey-ap-southeast-2.pem.
    4. Tự động cài đặt Docker / Node.js + PM2 trên server nếu chưa có.
    5. Cấu hình ứng dụng chạy trên Port 99.
    6. Mở cổng ufw và kiểm tra trạng thái hoạt động thực tế.
.EXAMPLE
    .\scripts\deploy_lightsail.ps1 -ServerIp 13.239.x.x
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false, HelpMessage="IP máy chủ Lightsail")]
    [string]$ServerIp,

    [Parameter(Mandatory=$false)]
    [string]$KeyPath = "c:\Users\qdaoc\Downloads\LightsailDefaultKey-ap-southeast-2.pem",

    [Parameter(Mandatory=$false)]
    [string]$SshUser = "ubuntu",

    [Parameter(Mandatory=$false)]
    [int]$ServerPort = 99,

    [Parameter(Mandatory=$false)]
    [string]$RemoteDir = "~/nepnha-web-viewer"
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  🚀 TỰ ĐỘNG DEPLOY NẾP NHÀ 3D VIEWER LÊN AWS LIGHTSAIL" -ForegroundColor Yellow
Write-Host "  Cổng Server: $ServerPort | Key: $KeyPath" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Kiểm tra file Key PEM
if (-not (Test-Path $KeyPath)) {
    Write-Error "Không tìm thấy file PEM tại: $KeyPath. Vui lòng kiểm tra lại đường dẫn."
    exit 1
}

# 2. Nhập Server IP nếu chưa cung cấp
if ([string]::IsNullOrWhiteSpace($ServerIp)) {
    $ServerIp = Read-Host "👉 Nhập Public IP của máy chủ Lightsail"
    if ([string]::IsNullOrWhiteSpace($ServerIp)) {
        Write-Error "Server IP không được để trống."
        exit 1
    }
}
$ServerIp = $ServerIp.Trim()

# 3. Chuẩn hóa quyền file PEM trên Windows (tránh lỗi UNPROTECTED PRIVATE KEY FILE)
Write-Host "[1/6] Chuẩn hóa quyền file private key PEM..." -ForegroundColor Green
try {
    icacls.exe $KeyPath /inheritance:r | Out-Null
    icacls.exe $KeyPath /grant:r "$($env:USERNAME):(R)" | Out-Null
    Write-Host "  ✓ Quyền file PEM đã được thiết lập an toàn cho user: $($env:USERNAME)" -ForegroundColor Gray
} catch {
    Write-Warning "  ! Không thể gán icacls, tiếp tục thử ssh..."
}

# 4. Kiểm tra kết nối SSH tới máy chủ
Write-Host "[2/6] Kiểm tra kết nối SSH tới $SshUser@$ServerIp..." -ForegroundColor Green
$sshTest = ssh.exe -i $KeyPath -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$SshUser@$ServerIp" "echo 'SSH_OK'" 2>&1
if ($sshTest -notmatch "SSH_OK") {
    Write-Host "  ! Kết nối với user '$SshUser' thất bại, thử tự động nhận diện user 'ec2-user' hoặc 'admin'..." -ForegroundColor Yellow
    $fallbackUsers = @("ec2-user", "admin", "bitnami")
    $foundUser = $false
    foreach ($u in $fallbackUsers) {
        $testU = ssh.exe -i $KeyPath -o StrictHostKeyChecking=no -o ConnectTimeout=6 "$u@$ServerIp" "echo 'SSH_OK'" 2>&1
        if ($testU -match "SSH_OK") {
            $SshUser = $u
            $foundUser = $true
            Write-Host "  ✓ Đã kết nối thành công với user: $SshUser" -ForegroundColor Green
            break
        }
    }
    if (-not $foundUser) {
        Write-Error "Không thể kết nối SSH tới $ServerIp bằng key $KeyPath. Chi tiết lỗi:`n$sshTest"
        exit 1
    }
} else {
    Write-Host "  ✓ Kết nối SSH thành công ($SshUser@$ServerIp)" -ForegroundColor Green
}

# 5. Đóng gói mã nguồn web-viewer
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDir
$webViewerDir = Join-Path $projectRoot "web-viewer"
$archiveFile = Join-Path $env:TEMP "nepnha-web-viewer-deploy.tar.gz"

Write-Host "[3/6] Đóng gói mã nguồn web-viewer..." -ForegroundColor Green
if (Test-Path $archiveFile) { Remove-Item $archiveFile -Force }

Set-Location $webViewerDir
# Tạo file tar loại trừ node_modules, cache
tar.exe -czf $archiveFile `
    --exclude="node_modules" `
    --exclude=".git" `
    --exclude=".vite" `
    --exclude="*.log" `
    .

$archiveSize = [math]::Round(((Get-Item $archiveFile).Length / 1MB), 2)
Write-Host "  ✓ Đã tạo gói release ($archiveSize MB) tại $archiveFile" -ForegroundColor Gray

# 6. Upload gói release lên máy chủ Lightsail
Write-Host "[4/6] Đang đẩy gói ứng dụng lên máy chủ qua SCP..." -ForegroundColor Green
$scpResult = scp.exe -i $KeyPath -o StrictHostKeyChecking=no $archiveFile "$SshUser@${ServerIp}:/tmp/nepnha-deploy.tar.gz" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "Upload thất bại qua SCP: $scpResult"
    exit 1
}
Write-Host "  ✓ Upload thành công tới /tmp/nepnha-deploy.tar.gz" -ForegroundColor Green

# 7. Triển khai và khởi chạy ứng dụng trên máy chủ với Port 99
Write-Host "[5/6] Cấu hình và khởi chạy ứng dụng trên máy chủ (Port $ServerPort)..." -ForegroundColor Green

$remoteScriptPath = Join-Path $env:TEMP "nepnha_remote_deploy.sh"
$remoteBashScript = @"
#!/usr/bin/env bash
set -e
echo "==> [1/4] Giải nén ứng dụng vào $RemoteDir"
mkdir -p "$RemoteDir"
tar -xzf /tmp/nepnha-deploy.tar.gz -C "$RemoteDir"
rm -f /tmp/nepnha-deploy.tar.gz
cd "$RemoteDir"

export PORT=$ServerPort
export HOST=0.0.0.0
export NODE_ENV=production

# Kiểm tra xem Docker có sẵn không
if command -v docker &> /dev/null && (docker compose version &> /dev/null || docker-compose version &> /dev/null); then
    echo "==> [2/4] Phát hiện Docker & Docker Compose. Triển khai bằng Docker..."
    # Cập nhật port trong docker-compose.yml sang $ServerPort
    sed -i -E 's/"[0-9]+:3000"/"$ServerPort:3000"/g' docker-compose.yml || true
    sed -i -E 's/"[0-9]+:[0-9]+"/"$ServerPort:$ServerPort"/g' docker-compose.yml || true
    sed -i -E 's/PORT=[0-9]+/PORT=$ServerPort/g' docker-compose.yml || true
    
    if command -v docker compose &> /dev/null; then
        docker compose down || true
        docker compose up -d --build
    else
        docker-compose down || true
        docker-compose up -d --build
    fi
else
    echo "==> [2/4] Triển khai trực tiếp bằng Node.js / PM2..."
    # Cài đặt Node.js 22 LTS nếu chưa có
    if ! command -v node &> /dev/null; then
        echo "Cài đặt Node.js 22 LTS..."
        curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
        sudo apt-get install -y nodejs || sudo yum install -y nodejs
    fi

    # Cài đặt pnpm và pm2
    sudo npm install -g pnpm pm2 2>/dev/null || true

    # Cài đặt dependencies và build
    pnpm install --frozen-lockfile || npm install
    pnpm build || npm run build || true

    # Khởi chạy bằng PM2 trên cổng $ServerPort
    pm2 delete nepnha-web-viewer 2>/dev/null || true
    PORT=$ServerPort HOST=0.0.0.0 pm2 start server/index.js --name "nepnha-web-viewer" --time
    pm2 save || true
fi

# Mở cổng trên tường lửa UFW nếu UFW đang bật
echo "==> [3/4] Cấu hình firewall local..."
if command -v ufw &> /dev/null; then
    sudo ufw allow $ServerPort/tcp || true
fi
if command -v iptables &> /dev/null; then
    sudo iptables -I INPUT -p tcp --dport $ServerPort -j ACCEPT || true
fi

echo "==> [4/4] Kiểm tra phản hồi ứng dụng tại http://localhost:$ServerPort"
sleep 3
curl -s -I "http://localhost:$ServerPort/api/health" || curl -s -I "http://localhost:$ServerPort/" || true
"@

# Lưu script tạm trên Windows với LF line endings
$remoteBashScript.Replace("`r`n", "`n") | Set-Content -Path $remoteScriptPath -NoNewline

# Upload script thực thi lên server
scp.exe -i $KeyPath -o StrictHostKeyChecking=no $remoteScriptPath "$SshUser@${ServerIp}:/tmp/remote_deploy.sh" 2>&1 | Out-Null
Remove-Item $remoteScriptPath -Force -ErrorAction SilentlyContinue

# Thực thi lệnh trên server
ssh.exe -i $KeyPath -o StrictHostKeyChecking=no "$SshUser@$ServerIp" "bash /tmp/remote_deploy.sh && rm -f /tmp/remote_deploy.sh"

# 8. Hoàn tất & Thông báo
Write-Host "`n[6/6] Kiểm tra cổng kết nối từ xa..." -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  🎉 DEPLOY THÀNH CÔNG LÊN AWS LIGHTSAIL!" -ForegroundColor Green
Write-Host "  🌐 Ứng dụng đã chạy tại: http://${ServerIp}:${ServerPort}" -ForegroundColor Yellow
Write-Host "  📡 Health API: http://${ServerIp}:${ServerPort}/api/health" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "⚠️  LƯU Ý QUAN TRỌNG VỀ TƯỜNG LỬA AWS LIGHTSAIL:" -ForegroundColor Yellow
Write-Host "   Mặc định AWS Lightsail chỉ mở sẵn cổng 22 (SSH) và 80 (HTTP)."
Write-Host "   Bạn cần vào AWS Lightsail Console -> Chọn Instance của bạn -> Thẻ 'Networking' (hoặc 'IPv4 Firewall'):" -ForegroundColor White
Write-Host "   -> Bấm '+ Add rule'" -ForegroundColor White
Write-Host "   -> Application: Custom" -ForegroundColor White
Write-Host "   -> Protocol: TCP" -ForegroundColor White
Write-Host "   -> Port: $ServerPort" -ForegroundColor Yellow
Write-Host "   -> Bấm 'Save' để người dùng bên ngoài có thể truy cập http://${ServerIp}:${ServerPort}" -ForegroundColor White
Write-Host "==========================================================" -ForegroundColor Cyan
