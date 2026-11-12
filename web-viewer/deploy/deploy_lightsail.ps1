<#
.SYNOPSIS
    Tự động build và deploy Nếp Nhà 3D Architectural Web Viewer lên AWS Lightsail (Port 99).
.DESCRIPTION
    Sử dụng SSH Key LightsailDefaultKey-ap-southeast-2.pem, đóng gói mã nguồn và bản build Vite,
    upload lên máy chủ Lightsail, tự động cài Node.js, cấu hình systemd service chạy port 99,
    và mở firewall.
.PARAMETER ServerIp
    Địa chỉ IP Public (IPv4) của máy chủ AWS Lightsail.
.PARAMETER KeyPath
    Đường dẫn tới file khóa SSH .pem.
.PARAMETER Port
    Cổng máy chủ lắng nghe (mặc định 99).
.PARAMETER RemoteUser
    Tên người dùng SSH (mặc định 'ubuntu', có thể là 'bitnami' hoặc 'ec2-user').
.EXAMPLE
    .\deploy_lightsail.ps1 -ServerIp "54.252.xxx.xxx"
#>

[CmdletBinding()]
param(
    [Parameter(Position=0, Mandatory=$false, HelpMessage="Nhập địa chỉ IP Public của máy chủ Lightsail:")]
    [string]$ServerIp,

    [Parameter(Position=1)]
    [string]$KeyPath = "C:\Users\qdaoc\Downloads\LightsailDefaultKey-ap-southeast-2.pem",

    [Parameter(Position=2)]
    [int]$Port = 99,

    [Parameter(Position=3)]
    [string]$RemoteUser = "ubuntu"
)

$ErrorActionPreference = "Stop"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " NẾP NHÀ 3D VIEWER - TỰ ĐỘNG DEPLOY AWS LIGHTSAIL (PORT $Port)" -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor Cyan

# 1. Kiểm tra IP máy chủ
if (-not $ServerIp) {
    $ServerIp = Read-Host "Nhập địa chỉ Public IP của máy chủ AWS Lightsail"
}

if (-not $ServerIp) {
    Write-Error "Địa chỉ IP máy chủ không được để trống!"
    exit 1
}

# 2. Kiểm tra file khóa SSH .pem
if (-not (Test-Path $KeyPath)) {
    Write-Error "Không tìm thấy file khóa SSH tại: $KeyPath"
    exit 1
}

Write-Host "[1/6] Kiểm tra và thiết lập quyền bảo mật cho SSH Key..." -ForegroundColor Green
try {
    # Fix Windows OpenSSH permission error: "Permissions for private-key are too open"
    $acl = Get-Acl $KeyPath
    $acl.SetAccessRuleProtection($true, $false)
    $accessRule = New-Object System.Security.AccessControl.FileSystemAccessRule($env:USERNAME, "FullControl", "Allow")
    $acl.ResetAccessRule($accessRule)
    Set-Acl -Path $KeyPath -AclObject $acl
    Write-Host "   ✓ Quyền bảo mật SSH Key đã được tối ưu." -ForegroundColor Gray
} catch {
    Write-Warning "Không thể đổi ACL cho file pem, tiếp tục: $($_.Exception.Message)"
}

# 3. Build Frontend Production Assets
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ViewerDir = Split-Path -Parent $ScriptDir

Write-Host "`n[2/6] Biên dịch ứng dụng Frontend (pnpm build)..." -ForegroundColor Green
Push-Location $ViewerDir
try {
    pnpm build
    if ($LASTEXITCODE -ne 0) {
        throw "Lỗi khi chạy pnpm build!"
    }
    Write-Host "   ✓ Build thành công vào thư mục dist/" -ForegroundColor Gray
} finally {
    Pop-Location
}

# 4. Đóng gói mã nguồn & server thành file tar.gz
Write-Host "`n[3/6] Đóng gói các tệp triển khai..." -ForegroundColor Green
$ArchiveFile = Join-Path $env:TEMP "nepnha-deploy.tar.gz"
if (Test-Path $ArchiveFile) {
    Remove-Item -Force $ArchiveFile
}

Push-Location $ViewerDir
try {
    tar -czf $ArchiveFile `
        --exclude="node_modules" `
        --exclude=".git" `
        --exclude="target" `
        index.html package.json css js vendor server dist data deploy
    Write-Host "   ✓ Đã tạo gói lưu trữ: $ArchiveFile ($( [math]::Round((Get-Item $ArchiveFile).Length / 1MB, 2) ) MB)" -ForegroundColor Gray
} finally {
    Pop-Location
}

# 5. Upload gói lên máy chủ Lightsail qua scp
Write-Host "`n[4/6] Đang tải mã nguồn lên máy chủ $RemoteUser@$ServerIp ..." -ForegroundColor Green
$sshOptions = @(
    "-i", $KeyPath,
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null"
)

& scp @sshOptions $ArchiveFile "$RemoteUser@${ServerIp}:/tmp/nepnha-deploy.tar.gz"
if ($LASTEXITCODE -ne 0) {
    Write-Error "Không thể tải file lên máy chủ qua SCP! Vui lòng kiểm tra lại IP và trạng thái instance."
    exit 1
}

# 6. Kích hoạt cài đặt và khởi động dịch vụ qua SSH
Write-Host "`n[5/6] Cấu hình máy chủ và khởi động dịch vụ port $Port qua SSH..." -ForegroundColor Green

$remoteCmd = @"
sudo mkdir -p /var/www/nepnha-viewer
tar -xzf /tmp/nepnha-deploy.tar.gz -C /tmp/
chmod +x /tmp/deploy/setup_remote.sh
PORT=$Port /tmp/deploy/setup_remote.sh
rm -f /tmp/nepnha-deploy.tar.gz
"@

$remoteCmd | & ssh @sshOptions "$RemoteUser@$ServerIp" "bash -s"

Write-Host "`n============================================================" -ForegroundColor Green
Write-Host " DEPLOY THÀNH CÔNG!" -ForegroundColor Yellow
Write-Host " Website kiến trúc 3D đang hoạt động tại:" -ForegroundColor Cyan
Write-Host "   http://$ServerIp`:$Port/" -ForegroundColor White -BackgroundColor DarkGreen
Write-Host " API Kiểm tra hệ thống:" -ForegroundColor Cyan
Write-Host "   http://$ServerIp`:$Port/api/health" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor Green
Write-Host " LƯU Ý QUAN TRỌNG:" -ForegroundColor Yellow
Write-Host " 1. Trên giao diện AWS Lightsail Console:" -ForegroundColor Gray
Write-Host "    Vào Instance -> tab 'Networking' -> mục 'IPv4 Firewall'" -ForegroundColor Gray
Write-Host "    Bấm '+ Add rule' -> Chọn Custom -> TCP -> nhập Port: $Port -> Bấm 'Create'" -ForegroundColor Gray
Write-Host " 2. Sau khi mở firewall, bạn có thể truy cập ngay trên trình duyệt." -ForegroundColor Gray
Write-Host "============================================================" -ForegroundColor Green
