# Installs (or updates) CCTV Storage Monitor on Windows with Docker Desktop.
# Run it from the extracted folder, in PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\deploy\install-windows.ps1
# The first run asks for the dashboard address and the camera networks and writes .env; later runs
# keep .env (and the database) and only rebuild and restart, which is how an update is installed.

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Fail($message) {
  Write-Host ""
  Write-Host $message -ForegroundColor Red
  exit 1
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Fail "Docker Desktop is not installed. Install it from https://www.docker.com/products/docker-desktop/ (WSL 2), start it, then run this again."
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail "Docker Desktop is not running. Start it, wait until it says 'Engine running', then run this again." }

function Get-EnvValue($name) {
  $m = [regex]::Match((Get-Content ".env" -Raw), "(?m)^$name=(.*)$")
  if ($m.Success) { return $m.Groups[1].Value.Trim() }
  return ""
}

function Set-EnvValue($name, $value) {
  $text = Get-Content ".env" -Raw
  if ($text -match "(?m)^$name=") { $text = $text -replace "(?m)^$name=.*$", "$name=$value" }
  else { $text = $text.TrimEnd() + "`n$name=$value`n" }
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) ".env"), $text)
}

# A port another program on this PC already listens on (IIS, VMware, Skype …): ask for another.
function Confirm-Port($name, $default, $suggestion) {
  $port = Get-EnvValue $name
  if (-not $port) { $port = $default }
  $listener = Get-NetTCPConnection -State Listen -LocalPort ([int]$port) -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listener) { return }
  $process = (Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue).ProcessName
  if ($process -match "docker|wslrelay|vpnkit") { return }  # the app itself, from an earlier run
  Write-Host "Port $port is already used on this PC by '$process'." -ForegroundColor Yellow
  $choice = Read-Host "Port to use instead [$suggestion]"
  if (-not $choice) { $choice = $suggestion }
  Set-EnvValue $name $choice
}

$firstInstall = -not (Test-Path ".env")
if ($firstInstall) {
  Write-Host "First installation: a few questions (press Enter to keep the value in brackets)." -ForegroundColor Cyan
  $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.InterfaceAlias -notmatch "vEthernet|WSL|Loopback" } |
    Select-Object -First 1).IPAddress
  if (-not $ip) { $ip = "localhost" }
  $site = Read-Host "Address people will open the dashboard at (this PC's IP or name) [$ip]"
  if (-not $site) { $site = $ip }
  $nets = Read-Host "Camera networks, comma-separated, e.g. 10.10.6.0/24 [10.0.0.0/8,172.16.0.0/12,192.168.0.0/16]"
  $httpPort = Read-Host "HTTP port [80]"
  $httpsPort = Read-Host "HTTPS port (use 18443 if 443 is taken on this PC) [443]"

  $text = Get-Content ".env.example" -Raw
  $text = $text -replace "(?m)^SITE_ADDRESS=.*$", "SITE_ADDRESS=$site"
  if ($nets) { $text = $text -replace "(?m)^CAMERA_ALLOWED_NETWORKS=.*$", "CAMERA_ALLOWED_NETWORKS=$($nets -replace '\s', '')" }
  if ($httpPort) { $text += "`nHTTP_PORT=$httpPort" }
  if ($httpsPort) { $text += "`nHTTPS_PORT=$httpsPort" }
  # UTF-8 without a byte order mark (Docker Compose reads it as is).
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) ".env"), $text)
  Write-Host "Saved the settings in .env" -ForegroundColor Green
} else {
  Write-Host "Keeping the existing .env and data: rebuilding and restarting (update)." -ForegroundColor Cyan
}

Confirm-Port "HTTP_PORT" "80" "18080"
Confirm-Port "HTTPS_PORT" "443" "18443"

Write-Host "Building and starting (the first time takes a few minutes)..."
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { Fail "Docker Compose could not start the app. See the messages above." }

Write-Host "Waiting for the app to start..."
$ready = $false
for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
  Start-Sleep -Seconds 3
  docker compose exec -T api node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" *> $null
  $ready = $LASTEXITCODE -eq 0
}
if (-not $ready) { Fail "The app did not start. Look at: docker compose logs --tail 100 api" }

# No users yet (a first installation, or one that stopped before this step): create the administrator.
$dbUser = Get-EnvValue "POSTGRES_USER"; if (-not $dbUser) { $dbUser = "cctv" }
$dbName = Get-EnvValue "POSTGRES_DB"; if (-not $dbName) { $dbName = "cctv" }
$users = (docker compose exec -T db psql -U $dbUser -d $dbName -tAc "SELECT count(*) FROM users" 2>$null | Out-String).Trim()
if ($users -eq "0") {
  $create = Read-Host "Create the first administrator now? (Y/n)"
  if ($create -notmatch "^[nN]") {
    $user = Read-Host "Administrator user name [admin]"
    if (-not $user) { $user = "admin" }
    docker compose exec api node dist/cli/createAdmin.js --username $user
  }
  Write-Host ""
  Write-Host "Back up the encryption key (it decrypts the stored camera passwords): copying it to credential.key here." -ForegroundColor Yellow
  docker compose cp api:/app/server/data/credential.key .\credential.key
  Write-Host "Keep credential.key somewhere safe, apart from database backups, then delete it from this folder."
}

$envText = Get-Content ".env" -Raw
$site = ([regex]::Match($envText, "(?m)^SITE_ADDRESS=(.*)$")).Groups[1].Value.Trim()
$port = ([regex]::Match($envText, "(?m)^HTTPS_PORT=(\d+)")).Groups[1].Value
$url = if ($port -and $port -ne "443") { "https://${site}:$port" } else { "https://$site" }
Write-Host ""
Write-Host "Ready: open $url" -ForegroundColor Green
Write-Host "(Open it by this address exactly: the dashboard answers HTTPS for SITE_ADDRESS in .env.)"
