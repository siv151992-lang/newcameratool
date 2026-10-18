# Operations guide

## Deploying with Docker Compose

1. Copy and edit the environment file:
   ```bash
   cp .env.example .env
   openssl rand -base64 32        # → CREDENTIAL_ENCRYPTION_KEY
   openssl rand -base64 24        # → POSTGRES_PASSWORD
   ```
   Set `SITE_ADDRESS` (e.g. `cctv.estancia.local`) and narrow `CAMERA_ALLOWED_NETWORKS` to your camera
   subnet(s).
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
| `CREDENTIAL_ENCRYPTION_KEY` (and old keys during rotation) | Needed to decrypt camera passwords | Password manager / secrets vault, **separate from the database backups** |
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

Make sure `.env` holds the same `CREDENTIAL_ENCRYPTION_KEY` that was in use when the backup was taken.
If the key is lost, the restored cameras show *Credentials unavailable*: edit each camera and re-enter its
password.

**Rotating the encryption key**

1. Generate a new key and set `CREDENTIAL_ENCRYPTION_KEYS=2:<new>,1:<old>` and `CREDENTIAL_KEY_VERSION=2`.
2. Restart. New and changed passwords are encrypted with key 2; existing ones still decrypt with key 1.
3. Re-enter (or re-import) camera passwords to move them to key 2, then remove key 1.

## Retention

Configured in **Settings → Monitoring**: monitoring history (default 90 days) and audit log / resolved alerts
(default 365 days). The worker purges older rows hourly.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Test connection: *Address … is outside the allowed camera networks* | Add the camera subnet to `CAMERA_ALLOWED_NETWORKS` and restart |
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
| Emails not sent | Check SMTP variables, then **Settings → Notifications → Send test**. Failures are listed with their error in `notification_deliveries` |
| `CSRF` / 403 errors after a deploy | Reload the page to get a fresh session token |
| Logs | `docker compose logs -f api worker`. Logs never contain passwords or request bodies |
