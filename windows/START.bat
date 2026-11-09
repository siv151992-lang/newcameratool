@echo off
rem Sets up (first time) and starts CCTV Storage Monitor. Right-click, Run as administrator.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0service\setup.ps1"
echo.
pause
