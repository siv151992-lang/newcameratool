CCTV Storage Monitor for Windows - without Docker
===================================================

This package runs on its own: it includes everything it needs (Node.js, PostgreSQL, the HTTPS
web server and live video). Nothing is downloaded during installation, so it also works on
networks that block downloads.

INSTALL
1. Extract this zip to C:\  (you get the folder C:\cctv-monitor).
2. Right-click C:\cctv-monitor\START.bat -> Run as administrator.
3. Answer: this PC's address (Enter accepts the suggested one), the camera networks,
   and the administrator's user name and password. When Windows asks whether to install
   a certificate, choose Yes.
4. The dashboard opens in the browser. Use exactly the address the window shows,
   e.g. https://10.71.122.109 or https://10.71.122.109:18443

The app starts by itself whenever Windows starts (it runs in the background as a
scheduled task named "CCTV Monitor"; no one needs to be signed in).

KEEP SAFE
- data\credential.key   decrypts the stored camera passwords: keep a copy elsewhere.
- root.crt              the dashboard's certificate: double-click it on other PCs ->
                        Install Certificate -> Local Machine -> Trusted Root Certification
                        Authorities, so their browsers do not warn.

STOP / START
- STOP.bat  (Run as administrator) stops the app.
- START.bat (Run as administrator) starts it again.

UPDATE (from the dashboard, version 1.1.0 and later)
- Settings > Updates > Check for updates > Download > Install. Or, without internet on the
  server: download cctv-monitor-windows.zip on another PC and use "Install from a file".
- Only packages signed with the CCTV Monitor release key are installed; every file is checked.
- The app stops for 1-2 minutes. If the new version does not start, the previous one is put back
  by itself. The previous version is kept in C:\cctv-monitor\update-backup until the next update.
- The "CCTV Monitor Updater" task (as SYSTEM) does the installing; its log is data\logs\updater.log.

UPDATE (by hand, always works)
1. STOP.bat (Run as administrator).
2. Extract the new cctv-monitor-windows.zip to C:\ and replace the files.
   (Your data is in C:\cctv-monitor\data and is kept.)
3. START.bat (Run as administrator), then Ctrl+F5 in the browser.

WINDOWS SERVER (2016, 2019, 2022, 2025 - 64-bit)
- Install exactly as above, signed in as an administrator (Remote Desktop is fine).
- If IIS or another web server already uses ports 80/443, the app uses 18080/18443:
  use the address the window shows.
- Server Core / no browser on the server: open the address from another PC.
- If the server has Internet Explorer Enhanced Security, use Edge or another PC.
- The firewall rule is added for you; a hardware firewall between the server and the
  users' PCs must allow the same port.

REMOVE
- UNINSTALL.bat (Run as administrator). Data is deleted only if you type DELETE.

SETTINGS
- C:\cctv-monitor\data\.env holds the address, camera networks and ports.
  Change it with Notepad, then STOP.bat and START.bat.

LOGS (send these to support if something does not work)
- C:\cctv-monitor\data\logs\  supervisor.log, api.log, worker.log, postgres.log, caddy.log

BACKUP AND RESTORE
- The app backs up all its data every night to C:\cctv-monitor\data\backups (Settings -> Backups:
  time, how many days to keep, another folder such as a network share, and "Back up now").
- To restore one: RESTORE.bat (Run as administrator), choose the backup, type RESTORE. The app
  restarts with the backup's data; everyone signs in again. A backup file from elsewhere can be
  dragged onto RESTORE.bat.
- Keep a copy of data\credential.key somewhere safe, apart from the backups: it is needed to read
  the camera passwords after restoring on another server.
- Settings -> System health shows whether backups, disk space, the database and monitoring work.

Adding cameras: in the dashboard (Cameras -> Add camera / Scan network / Import CSV),
see CCTV-Monitor-Guide.pdf.
