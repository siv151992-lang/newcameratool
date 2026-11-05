# Saves the built app and the images it runs with into one file, cctv-monitor-images.tar, for a PC
# whose network blocks the downloads the build needs (npm, Docker Hub). Run it (EXPORT-IMAGES.bat) on
# a PC where INSTALL.bat works, copy the file into C:\cctv-monitor on the other PC, and run INSTALL.bat
# there: it loads the file instead of downloading and building.

$ErrorActionPreference = "Continue"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Fail($message) { Write-Host ""; Write-Host $message -ForegroundColor Red; exit 1 }

docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail "Start Docker Desktop first (wait for 'Engine running'), then run EXPORT-IMAGES.bat again." }

Write-Host "Building the app from this folder (uses what is already built where it can)..." -ForegroundColor Cyan
docker compose build
if ($LASTEXITCODE -ne 0) { Fail "The app could not be built here. Run this on a PC where INSTALL.bat works." }

$images = @("cctv-storage-monitor:latest", "postgres:16-alpine", "caddy:2-alpine", "alexxit/go2rtc:1.9.4")
Write-Host "Making sure all images are here..." -ForegroundColor Cyan
foreach ($image in $images[1..($images.Count - 1)]) {
  docker image inspect $image *> $null
  if ($LASTEXITCODE -ne 0) {
    docker pull $image
    if ($LASTEXITCODE -ne 0) { Fail "Could not download $image." }
  }
}

$file = Join-Path (Get-Location) "cctv-monitor-images.tar"
Write-Host "Saving them to cctv-monitor-images.tar (a few hundred MB; takes a minute)..." -ForegroundColor Cyan
docker save -o $file $images
if ($LASTEXITCODE -ne 0) { Fail "Saving the images failed." }

$size = [math]::Round((Get-Item $file).Length / 1MB)
Write-Host ""
Write-Host "Done: $file ($size MB)" -ForegroundColor Green
Write-Host "On the other PC: extract the same cctv-monitor.zip to C:\, copy this file into C:\cctv-monitor,"
Write-Host "then run INSTALL.bat there (Run as administrator). It installs without downloading anything."
