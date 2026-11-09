# Removes CCTV Storage Monitor (Windows package): stops it, removes the startup task, the firewall
# rule and the trusted certificate. The data (data\ folder: cameras, users, history, the encryption
# key) is deleted only if you type DELETE.

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $PSScriptRoot
$Data = Join-Path $Root "data"
$TaskName = "CCTV Monitor"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host "Right-click UNINSTALL.bat and choose 'Run as administrator'." -ForegroundColor Red; exit 1 }

& (Join-Path $PSScriptRoot "stop.ps1")
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Remove-NetFirewallRule -DisplayName $TaskName -ErrorAction SilentlyContinue
Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -match "Caddy Local Authority" } | Remove-Item -ErrorAction SilentlyContinue
Write-Host "The app no longer starts with Windows." -ForegroundColor Green

if (Test-Path $Data) {
  Write-Host ""
  Write-Host "The data is still in $Data (cameras, users, history, the encryption key)." -ForegroundColor Yellow
  $answer = Read-Host "Type DELETE to delete it too, or press Enter to keep it"
  if ($answer -ceq "DELETE") { Remove-Item -Recurse -Force $Data; Write-Host "Data deleted." }
}
Write-Host "You can now delete the folder $Root."
