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

UPDATE
1. STOP.bat (Run as administrator).
2. Extract the new cctv-monitor-windows.zip to C:\ and replace the files.
   (Your data is in C:\cctv-monitor\data and is kept.)
3. START.bat (Run as administrator), then Ctrl+F5 in the browser.

REMOVE
- UNINSTALL.bat (Run as administrator). Data is deleted only if you type DELETE.

SETTINGS
- C:\cctv-monitor\data\.env holds the address, camera networks and ports.
  Change it with Notepad, then STOP.bat and START.bat.

LOGS (send these to support if something does not work)
- C:\cctv-monitor\data\logs\  supervisor.log, api.log, worker.log, postgres.log, caddy.log

BACKUP
- Stop the app (STOP.bat) and copy the whole C:\cctv-monitor\data folder.
  To restore: put it back, then START.bat.

Adding cameras: in the dashboard (Cameras -> Add camera / Scan network / Import CSV),
see CCTV-Monitor-Guide.pdf.
