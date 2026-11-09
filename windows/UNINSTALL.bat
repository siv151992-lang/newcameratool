@echo off
rem Removes CCTV Storage Monitor from Windows startup; deletes its data only if you type DELETE.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0service\uninstall.ps1"
echo.
pause
