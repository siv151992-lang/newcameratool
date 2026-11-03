# Installing CCTV Storage Monitor on Windows

1. Install **Docker Desktop** (docker.com, keep "Use WSL 2"), restart, open it and wait for *Engine running*.
2. Extract the package to `C:\` so that you have the folder `C:\cctv-monitor`.
3. Right-click `C:\cctv-monitor\INSTALL.bat` → **Run as administrator**. Answer two questions (this PC's
   address and the camera networks) and create the administrator. The dashboard opens when it is ready.

**Update:** extract the new package to `C:\` again (replace the files when asked) and run `INSTALL.bat` again.
Settings and data are kept.

**Start over:** `UNINSTALL.bat` (Run as administrator) removes every copy of the app on the PC, with its data, after
you type DELETE; then run `INSTALL.bat`.

Guide: `Quick-Install-Guide.pdf` in the package. Other setups (Linux, without Docker): [docs/operations.md](docs/operations.md).
