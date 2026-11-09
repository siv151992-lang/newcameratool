@echo off
rem Stops CCTV Storage Monitor (it starts again with Windows, or with START.bat).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0service\stop.ps1"
echo.
pause
