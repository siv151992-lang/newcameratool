@echo off
rem Removes every copy of CCTV Storage Monitor from this PC, with its data, after you type DELETE.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\uninstall-windows.ps1"
echo.
pause
