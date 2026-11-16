@echo off
rem Restores a backup (Settings - Backups), replacing all data. Right-click, Run as administrator.
rem A backup file can also be dragged onto this file.
cd /d "%~dp0"
if not exist "%~dp0service\restore.ps1" (
  echo service\restore.ps1 is missing from this folder. Extract the whole zip again.
  echo.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0service\restore.ps1" %*
echo.
pause
