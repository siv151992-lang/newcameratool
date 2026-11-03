@echo off
rem Installs or updates CCTV Storage Monitor. Double-click this file (Docker Desktop must be running).
rem Right-click and choose "Run as administrator" to also open the Windows Firewall ports.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy\install-windows.ps1"
echo.
pause
