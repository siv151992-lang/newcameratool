# Restores a backup made by CCTV Monitoring (Settings -> Backups), replacing all its data: cameras,
# users, settings, alerts and history go back to the moment of the backup. Run RESTORE.bat as
# administrator. The app restarts and restores the backup before it opens again; everyone signs in again.

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
$Data = Join-Path $Root "data"
$Backups = Join-Path $Data "backups"
$TaskName = "CCTV Monitor"
try { $Host.UI.RawUI.WindowTitle = "Zoho IBMS CCTV Monitoring - Restore a backup" } catch { }

function Fail($message) { Write-Host ""; Write-Host "  [FAILED] $message" -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host ("  " + ("=" * 66)) -ForegroundColor DarkCyan
Write-Host "    Zoho IBMS  |  CCTV Monitoring  |  Restore a backup" -ForegroundColor White
Write-Host ("  " + ("=" * 66)) -ForegroundColor DarkCyan

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail "Right-click RESTORE.bat and choose 'Run as administrator'." }
if (-not (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)) { Fail "The app is not installed here yet: run START.bat first." }

# Which backup: one of those in data\backups (newest first), or a file given on the command line.
$file = $args | Select-Object -First 1
if (-not $file) {
  $list = @(Get-ChildItem -Path $Backups -Filter "cctv-backup-*.json.gz" -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 15)
  if (-not $list.Count) { Fail "No backups in $Backups. Copy a backup file there, or drag it onto RESTORE.bat." }
  Write-Host ""
  Write-Host "  Backups in $Backups (newest first):"
  for ($i = 0; $i -lt $list.Count; $i++) {
    Write-Host ("    {0,2}. {1}   {2:yyyy-MM-dd HH:mm}   {3:N1} MB" -f ($i + 1), $list[$i].Name, $list[$i].LastWriteTime, ($list[$i].Length / 1MB))
  }
  $pick = Read-Host "  Number of the backup to restore [1]"
  if (-not $pick) { $pick = "1" }
  if (-not ($pick -match '^\d+$') -or [int]$pick -lt 1 -or [int]$pick -gt $list.Count) { Fail "Choose a number from the list." }
  $file = $list[[int]$pick - 1].FullName
}
if (-not (Test-Path $file)) { Fail "Not found: $file" }
$file = (Resolve-Path $file).Path
if ((Split-Path -Leaf $file) -notmatch '^cctv-backup-\d{8}-\d{6}\.json\.gz$') { Fail "This is not a CCTV Monitoring backup file: $file" }

# The app runs as NETWORK SERVICE, which reads data\backups: a file from elsewhere is copied there.
if (-not [string]::Equals((Split-Path -Parent $file).TrimEnd('\'), $Backups.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
  New-Item -ItemType Directory -Force $Backups | Out-Null
  Copy-Item $file $Backups -Force
  $file = Join-Path $Backups (Split-Path -Leaf $file)
}

Write-Host ""
Write-Host "  This replaces ALL current data (cameras, users, settings, alerts, history) with the backup:" -ForegroundColor Yellow
Write-Host "    $file" -ForegroundColor Yellow
Write-Host "  The app stops for a few minutes. Camera passwords are read with this server's data\credential.key." -ForegroundColor Yellow
$answer = Read-Host "  Type RESTORE to continue"
if ($answer -cne "RESTORE") { Write-Host "  Nothing changed."; exit 0 }

Remove-Item (Join-Path $Data "restore.result") -Force -ErrorAction SilentlyContinue
Set-Content -Path (Join-Path $Data "restore.request") -Value $file -Encoding ASCII
& (Join-Path $PSScriptRoot "stop.ps1") -Quiet
Write-Host "  Restarting the app; it restores the backup first..."
Start-ScheduledTask -TaskName $TaskName

$result = Join-Path $Data "restore.result"
for ($i = 0; $i -lt 900 -and -not (Test-Path $result); $i++) { Start-Sleep -Seconds 2 }
if (-not (Test-Path $result)) { Fail "No answer from the app after 30 minutes. See $(Join-Path $Data 'logs\supervisor.log')." }
$outcome = (Get-Content $result -Raw).Trim()
Remove-Item $result -Force -ErrorAction SilentlyContinue
if ($outcome -ne "ok") { Fail "$outcome`n  Details: $(Join-Path $Data 'logs\restore.log'). The data was left as it was before." }
Write-Host ""
Write-Host "      OK  Backup restored. The app is starting; sign in again in a minute." -ForegroundColor Green
