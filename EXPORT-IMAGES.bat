@echo off
rem Saves the built app into cctv-monitor-images.tar, to install it on a PC whose network blocks downloads.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\export-images.ps1"
echo.
pause
