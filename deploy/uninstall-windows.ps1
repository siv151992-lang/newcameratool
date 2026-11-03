# Removes every copy of CCTV Storage Monitor from this PC (for a fresh installation).
# Start it by double-clicking UNINSTALL.bat. It deletes the app's containers AND its data (cameras,
# users, history, the encryption key) for every copy found, after you type DELETE to confirm.
# The folders themselves are left: delete old ones by hand afterwards.

$ErrorActionPreference = "Continue"
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Host "Docker Desktop is not installed: nothing to remove."; exit 0 }
docker info *> $null
if ($LASTEXITCODE -ne 0) { Write-Host "Start Docker Desktop first (wait for 'Engine running'), then run UNINSTALL.bat again." -ForegroundColor Red; exit 1 }

# Copies of the app: Docker Compose projects running the app's image, or named cctv-monitor...
# (Read as JSON: Windows PowerShell 5 drops inner quotes from arguments like --format '{{.Label "x"}}'.)
$found = @{}
docker ps -a --format "{{json .}}" 2>$null | ForEach-Object {
  $row = $_ | ConvertFrom-Json
  $labels = @{}
  foreach ($pair in ($row.Labels -split ",")) { $kv = $pair -split "=", 2; if ($kv.Count -eq 2) { $labels[$kv[0]] = $kv[1] } }
  $project = $labels["com.docker.compose.project"]
  if ($project -and ($row.Image -like "cctv-storage-monitor*" -or $project -like "cctv-monitor*")) {
    $found[$project] = $labels["com.docker.compose.project.working_dir"]
  }
}

if ($found.Count -eq 0) { Write-Host "No copy of CCTV Storage Monitor was found on this PC." -ForegroundColor Green; exit 0 }

Write-Host ""
Write-Host "Found these copies of CCTV Storage Monitor:" -ForegroundColor Cyan
foreach ($p in $found.Keys) { Write-Host "  - $p   ($($found[$p]))" }
Write-Host ""
Write-Host "This deletes them AND their data: cameras, users, alerts, history and the encryption key." -ForegroundColor Yellow
Write-Host "To keep the data of one of them, back it up first (see the guide: Move from an old server)." -ForegroundColor Yellow
$answer = Read-Host "Type DELETE to remove them all"
if ($answer -cne "DELETE") { Write-Host "Nothing was removed."; exit 0 }

foreach ($p in $found.Keys) {
  Write-Host "Removing $p ..."
  $ids = docker ps -aq --filter "label=com.docker.compose.project=$p"
  if ($ids) { docker rm -f $ids *> $null }
  $volumes = docker volume ls -q --filter "label=com.docker.compose.project=$p"
  if ($volumes) { docker volume rm -f $volumes *> $null }
  $networks = docker network ls -q --filter "label=com.docker.compose.project=$p"
  if ($networks) { docker network rm $networks *> $null }
}
docker image rm -f cctv-storage-monitor:latest *> $null
Remove-NetFirewallRule -DisplayName "CCTV Monitor" -ErrorAction SilentlyContinue
# Its certificates, trusted on this PC by INSTALL.bat (a new installation makes a new one).
Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -match "Caddy Local Authority" } | Remove-Item -ErrorAction SilentlyContinue
# This folder starts over: the next INSTALL.bat asks the questions again.
foreach ($f in @(".env", "credential.key", "root.crt")) { if (Test-Path $f) { Remove-Item $f -Force } }

Write-Host ""
Write-Host "Done. To install fresh, run INSTALL.bat (right-click, Run as administrator)." -ForegroundColor Green
Write-Host "Old app folders (for example in Downloads) can now be deleted."
