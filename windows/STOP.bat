@echo off
rem Stops CCTV Storage Monitor (it starts again with Windows, or with START.bat).
cd /d "%~dp0"
if not exist "%~dp0service\stop.ps1" (
  echo service\stop.ps1 is missing from this folder.
  echo Extract the whole zip again: right-click it, Properties, tick Unblock, OK; then right-click, Extract All.
  echo If it is still missing, antivirus removed it: Windows Security, Virus and threat protection,
  echo Protection history: allow or restore it, or ask IT to allow the cctv-monitor folder.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0service\stop.ps1"
echo.
pause
