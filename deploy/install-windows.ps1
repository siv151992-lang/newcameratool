# Installs or updates CCTV Storage Monitor on Windows with Docker Desktop.
# Start it by double-clicking INSTALL.bat in the app folder (or run this file in PowerShell).
#
# First run: asks for the dashboard address and the camera networks, picks free ports, builds and
# starts the app, creates the first administrator, saves the encryption key, trusts the dashboard's
# certificate on this PC, opens the firewall ports (when run as administrator) and opens the dashboard.
# Later runs (the folder has .env): keep the settings and data, rebuild and restart: an update.

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Fail($message) {
  Write-Host ""
  Write-Host $message -ForegroundColor Red
  exit 1
}
function Step($message) { Write-Host ""; Write-Host "== $message" -ForegroundColor Cyan }

function Get-EnvValue($name) {
  $m = [regex]::Match((Get-Content ".env" -Raw), "(?m)^\s*$name=(.*)$")
  if ($m.Success) { return $m.Groups[1].Value.Trim() }
  return ""
}
function Set-EnvValue($name, $value) {
  $text = Get-Content ".env" -Raw
  if ($text -match "(?m)^\s*$name=") { $text = $text -replace "(?m)^\s*$name=.*$", "$name=$value" }
  else { $text = $text.TrimEnd() + "`n$name=$value`n" }
  # UTF-8 without a byte order mark (what Docker Compose expects).
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) ".env"), $text)
}

# True when another program (not this app's Docker) listens on the port.
function Test-PortTaken([int]$port) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listener) { return $false }
  $process = (Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue).ProcessName
  return -not ($process -match "docker|wslrelay|vpnkit")
}
# The first free pair of ports among 80/443, 18080/18443, 28080/28443.
function Select-Ports {
  foreach ($pair in @(@(80, 443), @(18080, 18443), @(28080, 28443))) {
    if (-not (Test-PortTaken $pair[0]) -and -not (Test-PortTaken $pair[1])) { return $pair }
  }
  return @(38080, 38443)
}

# ---------------------------------------------------------------------------------------- checks
Step "Checking Docker"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Fail "Docker Desktop is not installed. Install it from https://www.docker.com/products/docker-desktop/ (keep 'Use WSL 2'), start it, then run INSTALL.bat again."
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail "Docker Desktop is not running. Open it, wait until it says 'Engine running', then run INSTALL.bat again." }
Write-Host "Docker is running."

# ------------------------------------------------------------------------------------- settings
$firstInstall = -not (Test-Path ".env")
if ($firstInstall) {
  Step "Settings (press Enter to accept the value in brackets)"
  $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and $_.InterfaceAlias -notmatch "vEthernet|WSL|Loopback|Bluetooth" } |
    Select-Object -First 1).IPAddress
  if (-not $ip) { $ip = "localhost" }
  $site = Read-Host "This PC's address, which people will open in the browser [$ip]"
  if (-not $site) { $site = $ip }
  $site = $site -replace "^https?://", "" -replace "[/:].*$", ""
  $nets = Read-Host "Camera networks, comma-separated, e.g. 10.10.6.0/24 [all private networks]"

  Copy-Item ".env.example" ".env"
  Set-EnvValue "SITE_ADDRESS" $site
  if ($nets) { Set-EnvValue "CAMERA_ALLOWED_NETWORKS" ($nets -replace "\s", "") }
  # A fixed name: an update extracted to another folder still finds this installation and its data.
  Set-EnvValue "COMPOSE_PROJECT_NAME" "cctv-monitor"
  $ports = Select-Ports
  Set-EnvValue "HTTP_PORT" $ports[0]
  Set-EnvValue "HTTPS_PORT" $ports[1]
  if ($ports[1] -ne 443) { Write-Host "Port 443 is used by another program on this PC: the dashboard uses port $($ports[1])." -ForegroundColor Yellow }
} else {
  Step "Updating (keeping the settings in .env and all data)"
  # An earlier run may have chosen ports another program has taken since.
  $httpsPort = Get-EnvValue "HTTPS_PORT"; if (-not $httpsPort) { $httpsPort = "443" }
  $httpPort = Get-EnvValue "HTTP_PORT"; if (-not $httpPort) { $httpPort = "80" }
  if ((Test-PortTaken ([int]$httpsPort)) -or (Test-PortTaken ([int]$httpPort))) {
    $ports = Select-Ports
    Set-EnvValue "HTTP_PORT" $ports[0]
    Set-EnvValue "HTTPS_PORT" $ports[1]
    Write-Host "Port $httpsPort or $httpPort is taken by another program: moved the dashboard to port $($ports[1])." -ForegroundColor Yellow
  }
}

# ------------------------------------------------------------------------------------ build/run
Step "Building and starting (the first time takes 5 to 15 minutes; do not close this window)"
docker compose up -d --build --remove-orphans
if ($LASTEXITCODE -ne 0) { Fail "The app could not be started: see the messages above, or send them to support." }
# The web server reads its configuration only when it starts: restart it so an update applies.
docker compose up -d --force-recreate --no-deps caddy *> $null

Write-Host "Waiting for the app..."
$ready = $false
for ($i = 0; $i -lt 80 -and -not $ready; $i++) {
  Start-Sleep -Seconds 3
  docker compose exec -T api node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" *> $null
  $ready = $LASTEXITCODE -eq 0
}
if (-not $ready) { Fail "The app did not start. Look at: docker compose logs --tail 100 api" }
Write-Host "The app is running." -ForegroundColor Green

# --------------------------------------------------------------------------------- administrator
$dbUser = Get-EnvValue "POSTGRES_USER"; if (-not $dbUser) { $dbUser = "cctv" }
$dbName = Get-EnvValue "POSTGRES_DB"; if (-not $dbName) { $dbName = "cctv" }
$users = (docker compose exec -T db psql -U $dbUser -d $dbName -tAc "SELECT count(*) FROM users" 2>$null | Out-String).Trim()
if ($users -eq "0") {
  Step "Create the administrator (the first user)"
  $name = Read-Host "User name [admin]"
  if (-not $name) { $name = "admin" }
  for (;;) {
    $p1 = Read-Host "Password (at least 10 characters; it is not shown)" -AsSecureString
    $p2 = Read-Host "Type it again" -AsSecureString
    $a = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1))
    $b = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2))
    if ($a -ne $b) { Write-Host "The two passwords differ. Try again." -ForegroundColor Yellow; continue }
    if ($a.Length -lt 10) { Write-Host "Use at least 10 characters." -ForegroundColor Yellow; continue }
    if ($a.Contains('"')) { Write-Host "Please do not use the double quote character in this password." -ForegroundColor Yellow; continue }
    break
  }
  # Given to the one command that creates the user (no prompt inside Docker, which some consoles hide).
  docker compose exec -T -e "ADMIN_PASSWORD=$a" api node dist/cli/createAdmin.js --username $name
  $created = $LASTEXITCODE -eq 0
  $a = $null; $b = $null
  if (-not $created) { Fail "The administrator could not be created (see above). Run INSTALL.bat again to retry." }

  Step "Saving the encryption key"
  docker compose cp api:/app/server/data/credential.key .\credential.key *> $null
  Write-Host "credential.key is in this folder. It decrypts the camera passwords: keep a copy somewhere safe (not with database backups)." -ForegroundColor Yellow
}

# ------------------------------------------------------------------------- certificate, firewall
Step "Certificate and firewall"
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .\root.crt *> $null
if (Test-Path ".\root.crt") {
  $trusted = Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -match "Caddy Local Authority" }
  if (-not $trusted) {
    Write-Host "Trusting the dashboard's certificate on this PC (Windows asks you to confirm: choose Yes)."
    try { Import-Certificate -FilePath ".\root.crt" -CertStoreLocation Cert:\CurrentUser\Root | Out-Null } catch { Write-Host "Not trusted: the browser will warn until it is." -ForegroundColor Yellow }
  }
  Write-Host "root.crt is in this folder: double-click it on other PCs to trust the dashboard there too."
}
$httpPort = Get-EnvValue "HTTP_PORT"; if (-not $httpPort) { $httpPort = "80" }
$httpsPort = Get-EnvValue "HTTPS_PORT"; if (-not $httpsPort) { $httpsPort = "443" }
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  if (-not (Get-NetFirewallRule -DisplayName "CCTV Monitor" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "CCTV Monitor" -Direction Inbound -Protocol TCP -LocalPort $httpPort, $httpsPort -Action Allow | Out-Null
  } else {
    Set-NetFirewallRule -DisplayName "CCTV Monitor" -LocalPort $httpPort, $httpsPort | Out-Null
  }
  Write-Host "Firewall: ports $httpPort and $httpsPort are open for other PCs."
} else {
  Write-Host "Firewall not changed (not run as administrator). If other PCs cannot open the dashboard, right-click INSTALL.bat and choose 'Run as administrator'." -ForegroundColor Yellow
}

# ------------------------------------------------------------------------------------------ done
$site = Get-EnvValue "SITE_ADDRESS"
$url = if ($httpsPort -ne "443") { "https://${site}:$httpsPort" } else { "https://$site" }
Write-Host ""
Write-Host "Ready. Open: $url" -ForegroundColor Green
Write-Host "(Always use this exact address. To update later: replace this folder's files with the new package and run INSTALL.bat again.)"
Start-Process $url
