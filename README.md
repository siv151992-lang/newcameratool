# CCTV Storage Monitor

A web dashboard for monitoring the SD card / storage status of IP cameras across an office network,
regardless of manufacturer. The backend contacts each registered camera on a schedule, normalises its
storage data, tracks history, and raises alerts when storage fills up, a disk reports a fault, a camera
goes offline, or its credentials stop working.

**Hikvision (ISAPI) is fully implemented.** Other brands (Dahua, Axis, Uniview, ONVIF) are listed as
*planned* and can be added as separate adapter modules — see [Adding a brand](docs/architecture.md#adding-a-camera-brand).

| | |
|---|---|
| Frontend | React 18 + TypeScript, Tailwind CSS, TanStack Query, Recharts (`web/`) |
| Backend | Node.js 22 + TypeScript, Express 5, Zod validation (`server/`) |
| Database | PostgreSQL 16 with SQL migrations (`server/migrations/`) |
| Monitoring | Separate worker process with database leases (`server/src/worker.ts`) |
| Deployment | Docker Compose: Postgres, API (also serves the UI), worker, Caddy for HTTPS |

## What works

The five priority features are implemented end to end and covered by automated tests:

1. **Add a Hikvision camera** by IP/hostname and credentials (validated, password encrypted at rest).
2. **Test Connection** — step-by-step diagnostics (reachability → authentication → device API → storage)
   using the real ISAPI endpoint `GET /ISAPI/ContentMgmt/Storage` with HTTP Digest authentication.
3. **Dashboard** — summary cards (cameras, online/offline, warnings, critical, total/used/free capacity) and a
   camera table with search, sorting, pagination and filters (brand, status, location, usage).
4. **Automatic checks and alerts** — every 5 minutes by default, with concurrency limits, timeouts, bounded
   retries, offline detection after 3 consecutive failures, threshold alerts (80% / 90% / full), disk-health
   and read-only alerts, de-duplication, escalation and auto-resolve.
5. **Add, edit, enable/disable and remove cameras** (single and bulk), with **dark and light themes**.

Also included: CSV bulk import (parsed in the browser; preview, per-row validation, duplicate detection,
shared credentials, optional rate-limited connectivity tests), camera detail page with usage history chart,
alert center (acknowledge / resolve, history), brand integrations page, monitoring settings, email
notifications with cooldowns and recovery notices, users with roles (admin / operator / viewer), audit log,
and OpenAPI documentation at `/api/docs`.

## Quick start (development)

Prerequisites: Node.js 20+ and PostgreSQL 14+.

```bash
npm install
cp .env.example .env
# Edit .env:
#   CREDENTIAL_ENCRYPTION_KEY=$(openssl rand -base64 32)
#   DATABASE_URL=postgres://cctv:cctv@localhost:5432/cctv
#   COOKIE_SECURE=false            # plain HTTP during development only
createdb cctv                      # or create it with psql

npm run migrate                    # creates the schema (also runs automatically on start)
npm run create-admin -- --username admin   # prompts for a password (min. 10 characters)

npm run dev:api      # API on http://localhost:4000
npm run dev:worker   # background monitoring (separate terminal)
npm run dev:web      # UI on http://localhost:5173 (proxies /api to the API)
```

### Try it without real cameras

Simulated Hikvision cameras (digest auth, realistic ISAPI XML; they identify themselves as
`SIMULATED-HIKVISION`) are included for demos:

```bash
# in .env: CAMERA_ALLOW_LOOPBACK=true   (development only — refused in production)
npm run mock-camera -w server -- --port 8081 --count 4
```

Then add cameras with host `127.0.0.1`, ports `8081`–`8084`, user `admin`, password `Sim-Passw0rd!`.
The four simulate a healthy card, a nearly full card, a disk error and a two-disk camera.

## Production deployment (Docker Compose)

```bash
cp .env.example .env     # set CREDENTIAL_ENCRYPTION_KEY, POSTGRES_PASSWORD, SITE_ADDRESS, CAMERA_ALLOWED_NETWORKS
docker compose up -d --build
docker compose exec api node dist/cli/createAdmin.js --username admin
```

Open `https://<SITE_ADDRESS>`. Caddy terminates HTTPS (its own local CA by default — see
`deploy/Caddyfile`). Details, backups, upgrades and troubleshooting: **[docs/operations.md](docs/operations.md)**.

> **Keep `CREDENTIAL_ENCRYPTION_KEY` safe and backed up separately from the database.** Without it, the
> stored camera passwords cannot be decrypted and must be re-entered.

## Testing against a real Hikvision camera

Only do this on a network and camera you are authorised to access.

1. Confirm the API works from the server with the same request the app makes:
   ```bash
   curl --digest -u admin:'YourCameraPassword' "http://<CAMERA_IP>/ISAPI/ContentMgmt/Storage"
   ```
2. Make sure the camera's address is inside `CAMERA_ALLOWED_NETWORKS` (e.g. `10.10.15.0/24`).
3. In the UI choose **Add camera**, enter the IP and credentials and click **Test connection**.
   Each step reports separately, so you can tell an unreachable camera from wrong credentials, a missing
   storage API, or a disk fault.
4. Save, then press **Refresh now** on the camera page and compare the capacity figures with the camera's
   own web interface (*Configuration → Storage*).

**Units:** ISAPI reports `capacity` and `freeSpace` in megabytes (MiB). The app converts them to bytes and
displays decimal units (GB), so a card shown as 121942 MB by the camera appears as 128 GB.

## Commands

| Command | What it does |
|---|---|
| `npm test` | Server tests (unit + integration, needs PostgreSQL) and web tests |
| `npm run typecheck` | TypeScript checks for both packages |
| `npm run lint` | ESLint for both packages |
| `npm run build` | Compile the server and build the web app |
| `npm run migrate` | Apply database migrations |
| `npm run create-admin -- --username <name> [--role admin\|operator\|viewer]` | Create a user from the CLI |

Server integration tests use a separate database (default
`postgres://cctv:cctv@localhost:5432/cctv_test`, override with `TEST_DATABASE_URL`). The test run **drops and
recreates** that database's schema and refuses to run against a URL that does not contain `test`. No physical
cameras are needed: tests use the simulated camera and mocked responses.

## Known limitations

- **Hikvision is the only brand implemented.** It has been tested against simulated ISAPI responses modelled
  on real camera output (including the response format from this project's brief), not against physical
  hardware in this environment. Validate with **Test connection** on your camera models and firmware.
- Hikvision status strings beyond the common set (`ok`, `error`, `unformatted`, `smartFailed`, …) are shown
  as reported and treated as *unknown* health rather than guessed.
- Cameras that **overwrite** old recordings normally sit near 100% used. Turn off *Raise alerts for high
  storage usage* in **Settings → Monitoring** (or raise per-camera thresholds) so only real faults alert.
- Email is the only notification channel so far. The notifier has a driver interface ready for
  Slack/Teams/Telegram.
- CSV import only (no Excel yet), up to 500 rows per file.
- Docker images and the Compose file were written but could not be built in the development environment used
  to create this project; the compiled production build was run directly instead.

More: [Architecture and security](docs/architecture.md) · [Operations](docs/operations.md) · API docs at `/api/docs`.
