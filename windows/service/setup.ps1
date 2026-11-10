# Sets up and starts CCTV Storage Monitor on Windows WITHOUT Docker (run START.bat as administrator).
# First run: asks for this PC's address and the camera networks, picks free ports, registers the
# "CCTV Monitor" task that starts the app at Windows startup (as NETWORK SERVICE), starts it, creates
# the first administrator, trusts the dashboard certificate on this PC, opens the firewall ports and
# opens the dashboard. Later runs keep data\ and only (re)start the app: that is how an update is
# installed (STOP.bat, extract the new package over this folder, START.bat).

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Data = Join-Path $Root "data"
$Node = Join-Path $Root "runtime\node\node.exe"
$TaskName = "CCTV Monitor"

function Fail($message) { Write-Host ""; Write-Host $message -ForegroundColor Red; exit 1 }
function Step($message) { Write-Host ""; Write-Host "== $message" -ForegroundColor Cyan }
function Get-Setting($name) {
  $file = Join-Path $Data ".env"
  if (-not (Test-Path $file)) { return "" }
  $m = [regex]::Match((Get-Content $file -Raw), "(?m)^\s*$name=(.*)$")
  if ($m.Success) { return $m.Groups[1].Value.Trim() } else { return "" }
}
function Test-PortTaken([int]$port) {
  $listener = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $listener) { return $false }
  $path = (Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue).Path
  return -not ($path -and $path.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase))
}
function Select-Ports {
  foreach ($pair in @(@(80, 443), @(18080, 18443), @(28080, 28443))) {
    if (-not (Test-PortTaken $pair[0]) -and -not (Test-PortTaken $pair[1])) { return $pair }
  }
  return @(38080, 38443)
}

# ---------------------------------------------------------------------------------------- checks
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail "Right-click START.bat and choose 'Run as administrator'." }
if (-not (Test-Path $Node)) { Fail "runtime\node\node.exe is missing: extract the whole package again." }

# The app runs as NETWORK SERVICE, which cannot read inside a user's folders (Downloads, Desktop,
# Documents...): there it would not start at all. Install a copy in C:\cctv-monitor instead.
$usersDir = Join-Path $env:SystemDrive "Users"
if ($Root.StartsWith("$usersDir\", [StringComparison]::OrdinalIgnoreCase)) {
  $target = Join-Path $env:SystemDrive "cctv-monitor"
  Step "Copying the app to $target"
  Write-Host "It cannot run from $Root (a user's folder), so it is installed in $target."
  & (Join-Path $PSScriptRoot "stop.ps1") -Quiet
  $targetStop = Join-Path $target "service\stop.ps1"
  if (Test-Path $targetStop) { & $targetStop -Quiet }  # Its files must not be in use while replaced.
  $copyArgs = @($Root, $target, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1")
  # An existing installation keeps its own data; otherwise the data made here moves along.
  if (Test-Path (Join-Path $target "data\.env")) { $copyArgs += @("/XD", $Data) }
  robocopy @copyArgs | Out-Null
  if ($LASTEXITCODE -ge 8) { Fail "Could not copy the app to $target (robocopy error $LASTEXITCODE)." }
  Write-Host "Copied. From now on use the .bat files in $target; you can delete $Root." -ForegroundColor Green
  & (Join-Path $target "service\setup.ps1")
  exit $LASTEXITCODE
}
New-Item -ItemType Directory -Force $Data | Out-Null

# ------------------------------------------------------------------------------------- settings
$firstInstall = -not (Test-Path (Join-Path $Data ".env"))
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
  if (-not $nets) { $nets = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16" }
  $ports = Select-Ports
  $lines = @(
    "# CCTV Storage Monitor settings (Windows package). Change, then run STOP.bat and START.bat.",
    "SITE_ADDRESS=$site",
    "CAMERA_ALLOWED_NETWORKS=$($nets -replace '\s', '')",
    "HTTP_PORT=$($ports[0])",
    "HTTPS_PORT=$($ports[1])"
  )
  [System.IO.File]::WriteAllLines((Join-Path $Data ".env"), $lines)
  if ($ports[1] -ne 443) { Write-Host "Port 443 is used by another program on this PC: the dashboard uses port $($ports[1])." -ForegroundColor Yellow }
}

# The app runs as NETWORK SERVICE: it may read this folder and change data\. data\ holds the
# database, its password and the key to the camera passwords: only the app, SYSTEM and
# administrators may open it (not the other users of this PC, who could read C:\ subfolders).
icacls $Root /grant "*S-1-5-20:(OI)(CI)RX" /C /Q | Out-Null
icacls $Data /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-20:(OI)(CI)M" /C /Q | Out-Null
icacls "$Data\*" /reset /T /C /Q | Out-Null

# ------------------------------------------------------------------------------------ start task
Step "Starting the app"
& (Join-Path $PSScriptRoot "stop.ps1") -Quiet
$action = New-ScheduledTaskAction -Execute $Node -Argument "`"$(Join-Path $Root 'service\supervisor.mjs')`"" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\NETWORK SERVICE" -LogonType ServiceAccount -RunLevel Limited
# Priority 4 = normal. Task Scheduler's default (7) runs the app, the database and everything they
# start below normal, with low disk and memory priority: the dashboard and checks become very slow.
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -Priority 4
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Waiting for the app (the first start creates the database: up to 2 minutes)..."
$ready = $false
for ($i = 0; $i -lt 90 -and -not $ready; $i++) {
  Start-Sleep -Seconds 2
  try { $ready = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:4000/api/health").StatusCode -eq 200 } catch { $ready = $false }
}
if (-not $ready) {
  # Show why, so a screenshot of this window is enough for support.
  Write-Host ""
  Write-Host "The app did not start. Details for support:" -ForegroundColor Red
  $info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($info) { Write-Host ("Task: {0}, last run {1}, result 0x{2:X}" -f (Get-ScheduledTask -TaskName $TaskName).State, $info.LastRunTime, $info.LastTaskResult) }
  $logs = Join-Path $Data "logs"
  $found = $false
  foreach ($name in "supervisor.log", "postgres.log", "api.log", "worker.log") {
    $file = Join-Path $logs $name
    if (Test-Path $file) {
      $found = $true
      Write-Host ""; Write-Host "----- $name (last lines)" -ForegroundColor Yellow
      Get-Content $file -Tail 15 | ForEach-Object { Write-Host $_ }
    }
  }
  if (-not $found) { Write-Host "No log files in $logs`: the app could not run at all (the task did not start node.exe, or it may not write to data\)." -ForegroundColor Yellow }
  Fail "Send a screenshot of this window (or the files in $logs) to support."
}
Write-Host "The app is running." -ForegroundColor Green

# --------------------------------------------------------------------------------- administrator
$users = (& $Node (Join-Path $PSScriptRoot "db-users.mjs") 2>$null | Out-String).Trim()
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
    break
  }
  $env:NODE_ENV = "production"
  $env:DATABASE_URL = "postgres://cctv@127.0.0.1:54329/postgres"
  $env:DATABASE_PASSWORD_FILE = Join-Path $Data "db_password"
  $env:CREDENTIAL_KEY_FILE = Join-Path $Data "credential.key"
  $env:ADMIN_PASSWORD = $a
  Push-Location (Join-Path $Root "app\server")
  & $Node "dist\cli\createAdmin.js" --username $name
  $created = $LASTEXITCODE -eq 0
  Pop-Location
  Remove-Item Env:\ADMIN_PASSWORD
  $a = $null; $b = $null
  if (-not $created) { Fail "The administrator could not be created (see above). Run START.bat again to retry." }
  Write-Host ""
  Write-Host "Keep a copy of data\credential.key somewhere safe: it decrypts the stored camera passwords." -ForegroundColor Yellow
}

# ------------------------------------------------------------------------- certificate, firewall
Step "Certificate and firewall"
$ca = Join-Path $Data "caddy\pki\authorities\local\root.crt"
for ($i = 0; $i -lt 30 -and -not (Test-Path $ca); $i++) { Start-Sleep -Seconds 1 }
if (Test-Path $ca) {
  Copy-Item $ca (Join-Path $Root "root.crt") -Force
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $ca
  if (-not (Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Thumbprint -eq $cert.Thumbprint })) {
    Write-Host "Trusting the dashboard's certificate on this PC (Windows asks you to confirm: choose Yes)."
    try { Import-Certificate -FilePath $ca -CertStoreLocation Cert:\CurrentUser\Root | Out-Null } catch { Write-Host "Not trusted: the browser will warn until it is." -ForegroundColor Yellow }
  }
  Write-Host "root.crt is in this folder: double-click it on other PCs to trust the dashboard there too."
}
$httpPort = Get-Setting "HTTP_PORT"; if (-not $httpPort) { $httpPort = "80" }
$httpsPort = Get-Setting "HTTPS_PORT"; if (-not $httpsPort) { $httpsPort = "443" }
Remove-NetFirewallRule -DisplayName $TaskName -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName $TaskName -Direction Inbound -Protocol TCP -LocalPort $httpPort, $httpsPort -Action Allow | Out-Null
Write-Host "Firewall: ports $httpPort and $httpsPort are open for other PCs."

$site = Get-Setting "SITE_ADDRESS"
$url = if ($httpsPort -ne "443") { "https://${site}:$httpsPort" } else { "https://$site" }
Write-Host ""
Write-Host "Ready. Open: $url" -ForegroundColor Green
Write-Host "It starts by itself with Windows. Stop: STOP.bat. Update: STOP.bat, extract the new package here, START.bat."
Start-Process $url
