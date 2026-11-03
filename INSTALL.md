# Installing CCTV Storage Monitor (Windows, from the package)

1. Install **Docker Desktop** (WSL 2) and start it; wait for *Engine running*.
2. Extract this package to `C:\cctv-monitor`.
3. In PowerShell:
   ```powershell
   cd C:\cctv-monitor
   powershell -ExecutionPolicy Bypass -File .\deploy\install-windows.ps1
   ```
   Answer the questions (dashboard address, camera networks, ports, first administrator).
4. Open the address it prints, e.g. `https://10.69.96.25`.

**Update:** extract the new package over the folder (your `.env` and data are kept) and run the same command.

The full guide, with moving from an existing server, backups and troubleshooting, is
`CCTV-Monitor-Installation-Guide.pdf` in the package. Linux and other setups: [docs/operations.md](docs/operations.md).
