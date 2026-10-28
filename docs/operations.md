# Operations guide

## Deploying with Docker Compose

1. Copy and edit the environment file:
   ```bash
   cp .env.example .env
   ```
   Set `SITE_ADDRESS` (e.g. `cctv.estancia.local`). The camera subnets the monitor may contact are set
   after sign-in in **Settings → Camera networks** (`CAMERA_ALLOWED_NETWORKS` is only the starting default). `CREDENTIAL_ENCRYPTION_KEY` and `POSTGRES_PASSWORD` can stay empty: on the first start the
   `init-secrets` step generates a database password (kept in the `secrets` volume) and the API generates
   the encryption key (kept in the `app-data` volume). To choose them yourself instead:
   `openssl rand -base64 32` for the key, `openssl rand -hex 24` for the password. If a database already
   exists, keep its `POSTGRES_PASSWORD` in `.env`: changing it does not change the existing database.
2. Start everything:
   ```bash
   docker compose up -d --build
   docker compose ps
   ```
   The API and worker apply database migrations automatically on start (serialised with an advisory lock).
3. Create the first administrator:
   ```bash
   docker compose exec api node dist/cli/createAdmin.js --username admin
   ```
   Alternatively set `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` for the first start only, then
   remove the password from `.env`.
4. Browse to `https://<SITE_ADDRESS>`.

### HTTPS

`deploy/Caddyfile` uses `tls internal`: Caddy issues a certificate from its own local CA. Install that root
certificate on admin PCs (`docker compose exec caddy cat /data/caddy/pki/authorities/local/root.crt`), or
replace the line with `tls /etc/caddy/cert.pem /etc/caddy/key.pem` and mount your company certificate.
For a publicly resolvable name, delete the `tls internal` line to use Let's Encrypt.

### Camera network access

The worker container must reach the cameras. Docker's default bridge network NATs outbound traffic and
usually works for LAN addresses. If cameras are on a VLAN the Docker host routes differently, run the worker
with `network_mode: host` and set its `DATABASE_URL` to the host-published database port.

## Running without Docker

```bash
npm ci && npm run build
cd server
NODE_ENV=production WEB_DIST_DIR=../web/dist node dist/index.js     # API + UI
NODE_ENV=production node dist/worker.js                              # monitoring worker
```

Run both under a process manager (systemd, pm2) and put a TLS reverse proxy in front of the API.
Set `TRUST_PROXY` to the proxy's address so client IPs in audit logs and rate limits are correct.

## Running on Windows

Both ways work from Command Prompt or PowerShell.

**Docker Desktop:** install Docker Desktop and Git, then use the Docker Compose steps above
(`copy .env.example .env`, edit it in Notepad, `docker compose build`, `docker compose up -d`).
Leave `CREDENTIAL_ENCRYPTION_KEY` and `POSTGRES_PASSWORD` empty to have them generated.

**Without Docker:** install Node.js 22 LTS and PostgreSQL 16, then:

```bat
psql -U postgres -c "CREATE USER cctv WITH PASSWORD 'ChooseAPassword123';"
psql -U postgres -c "CREATE DATABASE cctv OWNER cctv;"
copy .env.example .env
:: In .env set DATABASE_URL=postgres://cctv:ChooseAPassword123@localhost:5432/cctv,
:: CAMERA_ALLOWED_NETWORKS, WEB_DIST_DIR=../web/dist (the encryption key is generated in server\data)
:: and COOKIE_SECURE=false if you browse over plain http://
npm install
npm run build
npm run migrate
npm run create-admin -- --username admin
```

Start the API and the worker in two windows (`cd server`, then `node dist\index.js` and `node dist\worker.js`)
and open http://localhost:4000. Check camera status from any window with `npm run status`.

## AI Mode

AI Mode (forecasts, anomalies, health scores, recommendations, reports) is on by default and needs no
setup or internet access. Turn it off in **Settings → AI Mode**; monitoring is unaffected either way.

To enable the **assistant** and AI report summaries, add a Claude API key to `.env` and restart:

```bash
ANTHROPIC_API_KEY=sk-ant-...
docker compose up -d     # or restart the API process
```

The server then needs outbound HTTPS to `api.anthropic.com` (allow it in the office firewall/proxy). Each
question sends the question and the relevant monitoring data (camera names, IPs, storage values, alerts —
never passwords or keys) to Anthropic and is billed to the key's account; questions are limited to 20 per
minute. `AI_MODEL` (default `claude-opus-5-5`) and `AI_EFFORT` (default `medium`) can be changed in `.env`.

Forecasts improve with history: they need at least 6 hours of measurements, and 30-day projections need
about a week of steady data.

## Live view

Org Admins and Operators open a camera's live view from the camera list (video icon) or the camera
page. Every viewing is in the audit log; viewers cannot open it.

- **Video** (smooth, no sound): Docker Compose runs the `go2rtc` service and sets `LIVE_VIDEO_URL`.
  The api registers the camera's RTSP stream in go2rtc (port 554, the second stream, usually H.264)
  and relays the browser's WebSocket to it after checking the session. go2rtc publishes no host port.
  The camera must have RTSP turned on, and the camera user needs live view permission. Browsers play
  H.264; set the camera's second stream to H.264 if the video does not start.
- **Pictures** (about one a second): always available, also without go2rtc, through each brand's
  snapshot API (`GET /api/cameras/:id/snapshot`).

Nothing is recorded or stored. A live video connection closes after an hour.

## Upgrades

```bash
git pull
docker compose up -d --build
```

Migrations in `server/migrations/` run automatically and are recorded in `schema_migrations`.
Take a backup first.

## Backup and recovery

**What to back up**

| Item | Why | How |
|---|---|---|
| PostgreSQL database | Cameras, history, alerts, users, audit | `deploy/backup.sh` (pg_dump, custom format, keeps 14 days) |
| `CREDENTIAL_ENCRYPTION_KEY`, or the generated key file (and old keys during rotation) | Needed to decrypt camera passwords | Password manager / secrets vault, **separate from the database backups**. Copy a generated key out with `docker compose cp api:/app/server/data/credential.key ./credential.key` |
| `.env` | Configuration | Secrets vault |

Schedule the backup, e.g. with cron on the Docker host:

```cron
15 2 * * * cd /opt/cctv-storage-monitor && deploy/backup.sh /var/backups/cctv >> /var/log/cctv-backup.log 2>&1
```

**Restore**

```bash
docker compose stop api worker
docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < /var/backups/cctv/cctv-YYYYMMDD-HHMMSS.dump
docker compose start api worker
```

Make sure the same encryption key is in use as when the backup was taken: either in
`CREDENTIAL_ENCRYPTION_KEY`, or as the key file in the `app-data` volume
(`docker compose cp ./credential.key api:/app/server/data/credential.key`, then restart).
If the key is lost, the restored cameras show *Credentials unavailable*: edit each camera and re-enter its
password.

**Rotating the encryption key**

1. Generate a new key and set `CREDENTIAL_ENCRYPTION_KEYS=2:<new>,1:<old>` and `CREDENTIAL_KEY_VERSION=2`.
2. Restart. New and changed passwords are encrypted with key 2; existing ones still decrypt with key 1.
3. Re-enter (or re-import) camera passwords to move them to key 2, then remove key 1.

## Retention

Configured in **Settings → Retention**: monitoring history (default 90 days) and audit log / resolved alerts
(default 365 days). The worker purges older rows hourly.

**Keep a history point every** (default 15 minutes): a routine successful check is written to the
history at most this often per camera. Failures, changes of storage health or recording state,
reconnections and manual checks are always written. Charts and forecasts average history into
15-minute points, so 15 loses nothing visible; 0 keeps every check.

## Large fleets (thousands of cameras)

Measured with 20 000 simulated Hikvision cameras (100 ms network delay per request, the recording
search used by most IP cameras) on a 4-core, 16 GB machine:

| | Result |
|---|---|
| Checks needed at a 2-minute interval | 167 per second (10 000 per minute) |
| One worker, 10 concurrent checks (the default) | 430 checks per minute: a full round takes 47 minutes |
| One worker, 300 concurrent checks | ~9 000 per minute (the worker uses a full CPU core) |
| Two workers, 300 concurrent checks each | ~10 000–14 000 per minute: every camera checked every 2 minutes |
| History written, keeping every check | ~8 GB per day (14 million rows) |
| History written, one point per 15 minutes | ~1 GB per day |
| Camera list, filters, summary, camera page | 10–350 ms (also while a worker checks 11 000 cameras a minute) |
| "Select all N matching" (20 000 cameras) | 0.06 s |
| AI insights | first analysis after a restart ~15–25 s (in the background), then 0.03 s; refreshed every 10 minutes |
| One worker after a restart, 300 concurrent checks | caught up 20 000 cameras 5 days overdue in 3 minutes (8 400–11 600 checks per minute) |

Re-measured on 27 October 2026 with NVR channels, camera clock checks and recording days added. The
app turns off PostgreSQL's JIT compilation on its connections: it compiled the dashboard summary on
every call (0.5 s, up to 5 s while the worker was busy) for a query that runs in 0.1 s.

### Many people watching video at once

Recordings reach the browser through the app server twice (camera → the server's playback relay →
go2rtc → the server → browser); live video once (go2rtc → the server → browser). Measured on the
same machine with simulated cameras sending 6 Mbps recordings (a typical 1080p / 4 MP main stream),
while the dashboard was used:

| Simultaneous recordings playing | Video delivered | First picture after opening | Dashboard meanwhile | App server CPU |
|---|---|---|---|---|
| 10 | 100% | 0.07 s | 0.10 s | — |
| 50 | 100% | 0.12 s | 0.11 s | ~0.7 core |
| 100 | 100% | 0.16–0.23 s | 0.11 s | ~0.6–0.7 core |
| 150 | 99% | 0.26 s | 0.12 s | ~0.8 core |
| 200 | 96% (falls behind) | 0.34 s | 0.12 s | 1 core (the limit) |

So one app server carries about **100–150 simultaneous recordings** at 6 Mbps (about twice as many
live views, or recordings at a lower bitrate); the dashboard stays fast even at the limit. Network:
each 6 Mbps playback is 6 Mbps from the camera and 6 Mbps to the viewer. If video stalls for a while
(go2rtc overloaded or restarting), the relay stops reading the camera once 1 MB is waiting rather than
holding video in memory.

Recommended settings for 5 000+ cameras:

1. **Settings → Schedule → Concurrent checks: 300** (up to 1000). Raise it until *overdue* cameras
   stay near zero; real cameras that answer slowly need more.
2. **Polling interval**: 5 minutes halves the load of 2 minutes. Each check of a Hikvision camera
   makes 4–6 requests.
3. **Run two workers** and give each a larger database pool, in `.env`:
   ```
   WORKER_DATABASE_POOL_SIZE=30
   ```
   then `docker compose up -d --scale worker=2`. Workers share the cameras safely (each camera is
   claimed by one worker at a time).
4. **Database**: PostgreSQL allows 100 connections by default (API 15 + workers). For 20 000 cameras
   give it more memory, e.g. in `docker-compose.yml` under `db`:
   `command: ["postgres", "-c", "shared_buffers=1GB", "-c", "max_connections=150"]`.
5. **History**: keep a point every 15 minutes (default) or 60 minutes, and choose retention by disk:
   with 20 000 cameras, one point per 15 minutes for 90 days is about 90 GB; per 60 minutes, about 25 GB.
6. Bulk actions apply to any number of selected cameras (sent in batches of 500).

The load test can be repeated: `npm run mock-camera` has a `--search-recording` mode, and
`MockHikvisionCamera.latencyMs` adds a network delay.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Test connection: *Address … is outside the allowed camera networks* | Add the camera subnet in **Settings → Camera networks** (applies within 30 seconds, no restart) |
| A brand is missing from **Add camera** | Only enabled integrations are offered. Check **Settings → Camera brands**: a draft must pass **Test API** and be enabled |
| Many cameras show *No storage device* / *Not recording* although they record to an NVR | Cameras → status filter **No SD card detected** → select all → **No local storage**. They stay monitored for online/offline; storage and recording alerts stop |
| Cameras of one brand stopped being checked | The brand's integration was disabled (Settings → Camera brands; see the audit log). Enable it again; history was kept |
| Configurable brand test: *An API key / Basic / bearer token is only sent over HTTPS* | Use HTTPS for that camera (paste its CA certificate if self-signed), or Digest authentication if the camera supports it |
| *Camera unreachable (connection refused)* | Wrong port or protocol, or the camera's web service is disabled. Check the camera's *Network → Advanced → Integration protocol* and port settings |
| *Camera did not respond in time* | Routing/firewall issue, or camera overloaded. Try `curl` from the server host. Increase the request timeout in settings for slow links |
| *Authentication failed* | Wrong username/password, or the camera temporarily locked the account after repeated failed attempts (Hikvision cameras do this; the lock duration is set on the camera). Use a dedicated low-privilege user on the camera |
| *Camera only offers Basic authentication over plain HTTP* | Enable Digest authentication on the camera (*System → Security → Authentication*), or switch to HTTPS |
| *HTTPS connection failed (certificate…)* | The camera uses a self-signed certificate: paste its certificate (PEM) into the camera's *CA certificate* field. Verification is never disabled |
| *Storage API not available on this device* | The model or firmware does not expose `/ISAPI/ContentMgmt/Storage`, or the user lacks permission |
| *No storage device* alert | The camera reports no SD card: check it is inserted and formatted from the camera's storage page |
| Disk shows status `unformatted` / `error` | Reported by the camera: format or replace the card from the camera's web UI |
| Cameras near 100% are always critical | They overwrite old footage. Turn off *Raise alerts for high storage usage* or raise thresholds |
| Camera shows *Unknown* | Not checked yet, or failing but not yet past the offline threshold. See *Last error* |
| *Credentials unavailable* | The encryption key changed. Restore the original key or re-enter the camera password |
| Emails or chat messages not sent | Email: check the mail server; Teams / Slack / Google Chat: check outbound HTTPS. Then **Settings → Notifications → Send test**. Failures are listed with their error in `notification_deliveries` |
| `CSRF` / 403 errors after a deploy | Reload the page to get a fresh session token |
| `ports are not available: exposing port TCP 0.0.0.0:80` (or 443) | Another program or Windows already uses that port. Set `HTTP_PORT=8080` and `HTTPS_PORT=8443` in `.env`, run `docker compose up -d`, and open `https://localhost:8443` |
| API/worker keep restarting with `password authentication failed for user "cctv"` | The database was created with a different password than `.env` now gives (Postgres keeps its first password). Put the original `POSTGRES_PASSWORD` back in `.env` and run `docker compose up -d`; or, if the database holds nothing you need, `docker compose down -v` and start again |
| Logs | `docker compose logs -f api worker`. Logs never contain passwords or request bodies |
