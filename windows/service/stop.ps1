# Stops CCTV Storage Monitor (Windows package): asks the supervisor to stop cleanly, then makes sure
# nothing from this folder is left running. The app starts again with Windows, or with START.bat.
param([switch]$Quiet)

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
$Data = Join-Path $Root "data"
$TaskName = "CCTV Monitor"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task -and $task.State -eq "Running") {
  if (-not $Quiet) { Write-Host "Stopping CCTV Storage Monitor..." }
  New-Item -ItemType File -Force (Join-Path $Data "stop.request") | Out-Null
  for ($i = 0; $i -lt 40 -and (Get-ScheduledTask -TaskName $TaskName).State -eq "Running"; $i++) { Start-Sleep -Seconds 1 }
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

# Anything still running from this folder (after a crash, or a stop that took too long).
$pgCtl = Join-Path $Root "runtime\pgsql\bin\pg_ctl.exe"
if ((Test-Path $pgCtl) -and (Test-Path (Join-Path $Data "pgdata\postmaster.pid"))) {
  & $pgCtl stop -D (Join-Path $Data "pgdata") -m fast -w -t 30 *> $null
}
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item (Join-Path $Data "stop.request") -Force -ErrorAction SilentlyContinue
if (-not $Quiet) { Write-Host "Stopped." -ForegroundColor Green }
