# CCTV Storage Monitor

A web dashboard for monitoring IP cameras and NVRs across an office network, regardless of
manufacturer. The backend contacts each registered camera on a schedule, normalises its storage and
recording data, tracks history, and raises alerts when storage fills up, a disk reports a fault, a camera
goes offline or stops recording, or its credentials stop working. Cameras can also be watched live and
their recordings played back from the dashboard.

**Hikvision / Prama (ISAPI) is fully implemented and used on real cameras.** Dahua / CP Plus / Amcrest (CGI), Axis (VAPIX), Uniview (LAPI) and
generic ONVIF (SOAP, WS-Security), Hanwha Vision / Wisenet (SUNAPI), Panasonic / i-PRO, Reolink (JSON API, HTTPS) and Bosch (ONVIF Profile S/G) adapters are also available, marked
*unverified* until they have been confirmed on real hardware — use Test Connection when adding such a camera. Prama (Hikvision India) is
supported, and brands sold on Hikvision or Dahua firmware (HiLook, HiWatch, Annke, LTS; Lorex, IC Realtime, Imou) use those adapters;
Vivotek, Sony, Avigilon, Milesight, Tiandy, TP-Link VIGI and Mobotix cameras are read over ONVIF.
**Milestone XProtect** is supported through its Open Network Bridge: the bridge is added once, as an NVR, and
each XProtect camera is one of its channels (see [docs/nvrs-and-recordings.md](docs/nvrs-and-recordings.md)).

**New brands without code changes:** in **Settings → Camera brands → Add brand**, give the brand's name and one of
its cameras: the app tries the ways it already knows (Hikvision, Dahua, … ONVIF) and adds the brand working like
the one that reads the camera. For a brand with an API of its own, administrators can describe it when its
storage API is a single HTTP request returning JSON or XML (Basic, Digest, API key, bearer token or no
authentication). A wizard maps the response onto the common storage model, tests it against a real camera on the
server, and only a tested configuration can be enabled. Brands with other APIs need a custom adapter in code.
See **[docs/brand-integrations.md](docs/brand-integrations.md)**. Developers adding a brand in code: **[docs/adding-a-camera-brand.md](docs/adding-a-camera-brand.md)**.

| | |
|---|---|
| Frontend | React 18 + TypeScript, Tailwind CSS, TanStack Query, Recharts (`web/`) |
| Backend | Node.js 22 + TypeScript, Express 5, Zod validation (`server/`) |
| Database | PostgreSQL 16 with SQL migrations (`server/migrations/`) |
| Monitoring | Separate worker process with database leases (`server/src/worker.ts`) |
| Video | go2rtc (live view and playback in the browser, MSE over WebSocket), with an RTSP replay relay in the API |
| Deployment | Docker Compose: Postgres, API (also serves the UI), worker, go2rtc, Caddy for HTTPS |

## What works

The five priority features are implemented end to end and covered by automated tests:

1. **Add a Hikvision camera** by IP/hostname and credentials (validated, password encrypted at rest).
2. **Test Connection** — step-by-step diagnostics (reachability → authentication → device API → storage)
   using the real ISAPI endpoint `GET /ISAPI/ContentMgmt/Storage` with HTTP Digest authentication.
3. **Dashboard** — summary cards (cameras, online/offline, warnings, critical, total/used/free capacity) that
   open the camera list filtered to those cameras, plus open alerts. The **Cameras** page has the camera table
   with search, sorting, pagination and filters (brand, status, location, usage).
4. **Automatic checks and alerts** — every 5 minutes by default, with concurrency limits, timeouts, bounded
   retries, offline detection after 3 consecutive failures, threshold alerts (80% / 90% / full), disk-health
   and read-only alerts, de-duplication, escalation and auto-resolve.
5. **Add, edit, enable/disable and remove cameras** (single and bulk), with **dark and light themes**.

**Recording status:** each check also asks the camera whether it is recording right now. The camera table
and detail page show *Recording*, *Not recording*, *Recording error* or *Unknown*; the dashboard counts cameras
that are not recording, and an alert is raised when a camera stops (turn it off in **Settings → Thresholds**
for cameras that only record on motion or a schedule). Endpoints: Hikvision `/ISAPI/ContentMgmt/Recording/status`, or, on cameras without it (most IP cameras), inferred
from the newest recording found by `/ISAPI/ContentMgmt/search` compared with the camera's own clock (`/ISAPI/System/time`), with the
`record/tracks/101` schedule explaining a camera that is not recording,
Axis `Storage.S<n>.RecordingStatus` parameters, Hanwha (inferred from `recording.cgi` storage settings, `storageinfo` and `eventstatus`, as the camera has no live recording flag), Uniview `/LAPI/V1.0/Storage/Status`, Dahua
`/cgi-bin/record.cgi?action=getRecordStatus`, ONVIF `GetRecordingJobs` on `/onvif/recording_service`. A failed
recording read never fails the storage check; the state just shows as *Unknown*.

**Live view and recordings:** live video of any camera or NVR channel, a 2×2 / 3×3 / 4×4 live grid, and a
recordings player modelled on Milestone XProtect's: a timeline with a centred playhead and a date band, day
calendar, speeds, zoom, playback buffer, save picture, export a clip as MP4, and full screen. Seeks reuse the
camera's open playback session where the camera confirms it, and end sessions properly otherwise, so cameras
with few connections are not exhausted. See [docs/nvrs-and-recordings.md](docs/nvrs-and-recordings.md).

**NVRs:** their hard disks and every channel (video, recording), with dashboard tiles and per-channel live view
and recordings.

**Picture health:** a snapshot every 30 minutes, checked for a black, blank or covered, blurred or frozen
picture, or a camera turned away from its view, each judged against the camera's own usual picture. See
[docs/picture-health.md](docs/picture-health.md).

**Network scan:** **Cameras → Scan network** finds cameras in an address range (up to 1024 addresses, inside the
allowed camera networks only), tells their brand from what they answer without a login and from ONVIF discovery,
marks the ones already added, and hands the chosen ones to the import, where shared credentials are entered and
tested. No passwords are sent during the scan.

**Camera events:** the worker keeps each Hikvision / Prama (and Dahua) camera's event stream open, so
tampering, video loss, storage and network faults and failed logins on the camera raise an alert the moment the
camera reports them, not at the next check. **Firmware:** every camera's model and firmware version by model,
with the cameras still on older firmware than others of their model (CSV). See
[docs/camera-events.md](docs/camera-events.md).

**More checks and reports:** recording retention (days stored against a required number), camera clock drift,
camera password policy, an uptime report (% online per camera and site, CSV), maintenance mode (silence a camera's
alerts during planned work), a **Ping** button (ICMP and the camera's web and RTSP ports, from the server), and
sorting of the camera list by any status.

**Notifications:** email, webhooks (Microsoft Teams, Slack, Google Chat or any URL), and an alert sound in the
browser while the dashboard is open (all alerts, critical only, or off). See [docs/notifications.md](docs/notifications.md).

**Accounts:** several organizations with their own cameras, roles (Org Admin, Operator, Viewer), invitations,
email verification and password reset, and sign-in with Google or Zoho. See [docs/accounts-and-sign-in.md](docs/accounts-and-sign-in.md).

Also included: bulk import from CSV, Excel or Bosch Project Assistant lists (parsed in the browser; preview, per-row validation, duplicate detection,
shared credentials, optional rate-limited connectivity tests), camera detail page with usage history chart,
alert center (acknowledge / resolve, history), brand integrations page, monitoring settings, email
notifications with cooldowns and recovery notices, users with roles (admin / operator / viewer), audit log,
and OpenAPI documentation at `/api/docs`.

## AI Mode

An optional intelligence layer on top of the rule-based monitoring (**AI Mode** in the sidebar; an
administrator can switch it off in **Settings → AI Mode**). Checks, alerts, camera management and
scheduled monitoring never depend on it.

- **Storage forecasts** — for each camera: current usage, growth per day, estimated days to the warning
  and critical thresholds, projected usage in 24 h / 7 d / 30 d, a confidence level, the period used and the
  latest measurement, with a chart that shows measured usage solid and the projection dashed. Forecasts are
  a straight-line trend through recent history (up to 14 days, since the last card format or swap); they are
  withheld when the history is too short instead of being guessed.
- **Anomaly detection** — sudden consumption spikes, sharp usage drops (possible footage loss), capacity
  changes, usage unchanged for 24 hours while the camera says it records, repeated disconnections and stale
  data, each with an explanation and the evidence.
- **Camera health scores** and **recommended actions** — a 0–100 score with the reasons behind each
  deduction, and prioritised actions (e.g. "free space before 2026-10-24", "check PoE power").
- **Reports** — last 24 hours or 7 days: fleet status, incidents, cameras needing attention, forecasts,
  anomalies and actions, downloadable as Markdown.
- **AI Monitoring Assistant** — ask questions such as *"Which cameras may run out of storage in the next
  seven days?"*. Claude answers by calling a fixed set of read-only lookups (no SQL access), only those the
  signed-in user is allowed to use; answers link to the camera pages and separate observations, estimates
  and recommendations. Requires `ANTHROPIC_API_KEY` (see `.env.example`); reports can then also get an
  AI-written summary.

Forecasts, anomalies, health scores and actions are computed locally by transparent rules and work without
any AI service or internet access.

## Quick start (development)

Prerequisites: Node.js 20+ and PostgreSQL 14+.

```bash
npm install
cp .env.example .env
# Edit .env:
#   DATABASE_URL=postgres://cctv:cctv@localhost:5432/cctv
#   (CREDENTIAL_ENCRYPTION_KEY may stay empty: a key is generated in server/data/credential.key)
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
cp .env.example .env     # set SITE_ADDRESS; camera networks are set in Settings → Camera networks
docker compose up -d --build
docker compose exec api node dist/cli/createAdmin.js --username admin
```

The secrets are generated on the first start when `.env` leaves them empty: a random database password
(in the `secrets` volume) and the camera-password encryption key (in the `app-data` volume,
`/app/server/data/credential.key`). Values you set in `.env` always take priority.

Open `https://<SITE_ADDRESS>`. Caddy terminates HTTPS (its own local CA by default — see
`deploy/Caddyfile`). Details, backups, upgrades and troubleshooting: **[docs/operations.md](docs/operations.md)**.

> **Back up the encryption key separately from the database.** Without it, the stored camera passwords
> cannot be decrypted and must be re-entered. If it was generated, copy it out with
> `docker compose cp api:/app/server/data/credential.key ./credential.key` and store that file somewhere
> safe (or put its contents in `CREDENTIAL_ENCRYPTION_KEY`).

## Testing against a real Hikvision camera

Only do this on a network and camera you are authorised to access.

1. Confirm the API works from the server with the same request the app makes:
   ```bash
   curl --digest -u admin:'YourCameraPassword' "http://<CAMERA_IP>/ISAPI/ContentMgmt/Storage"
   ```
2. Make sure the camera's address is inside an allowed network in **Settings → Camera networks** (e.g. `10.10.15.0/24`).
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
| `npm run create-admin -- --username <name> [--email <address>]` | Create a system administrator (Org Admin of the first organization) from the CLI |
| `npm run status` | Print every camera's status (online/offline, storage used/free, last error) in the terminal |
| `npm run status -- --check` | Check all monitored cameras now, then print the table (`--json` for machine-readable output) |

Server integration tests use a separate database (default
`postgres://cctv:cctv@localhost:5432/cctv_test`, override with `TEST_DATABASE_URL`). The test run **drops and
recreates** that database's schema and refuses to run against a URL that does not contain `test`. No physical
cameras are needed: tests use the simulated camera and mocked responses.

## Known limitations

- **Only Hikvision / Prama has been confirmed on real cameras.** The other brands, and Milestone's Open Network
  Bridge, are tested against simulated devices and marked *unverified* until confirmed. Validate with
  **Test connection** on your camera models and firmware.
- **AI Mode forecasts are straight-line trends.** They do not model schedules (e.g. weekday-only recording)
  and are shown with a confidence level; the assistant needs `ANTHROPIC_API_KEY` and internet access, and
  its answers should be checked on the camera pages before acting on them.
- Hikvision status strings beyond the common set (`ok`, `error`, `unformatted`, `smartFailed`, …) are shown
  as reported and treated as *unknown* health rather than guessed.
- Cameras that **overwrite** old recordings normally sit near 100% used. Turn off *Raise alerts for high
  storage usage* in **Settings → Thresholds** (or raise per-camera thresholds) so only real faults alert.
- The alert sound plays only while the dashboard is open in a browser tab that is not muted, and only after the
  page has been clicked once (a browser rule).
- Camera events come only from Hikvision / Prama and Dahua (Dahua unverified), and only for the events enabled on
  the camera itself (Video Tampering, exceptions); each camera keeps one extra connection open to the worker.
- Playback depends on the camera's RTSP service (port 554) and its limit on simultaneous connections.
- Import from CSV, Excel (.xlsx) or tab-separated text (including Bosch Project Assistant lists), up to 500 rows per file.
- Updating a running installation: `git pull`, then `docker compose up -d --build` (the images are built from the
  code on the server), and reload the browser with Ctrl+F5.

In Docker, run the status command with `docker compose exec api node dist/cli/status.js` (add `--check` to refresh first).

More: [Accounts, organizations and sign-in](docs/accounts-and-sign-in.md) · [Live view, recordings and NVRs](docs/nvrs-and-recordings.md) · [Alert notifications](docs/notifications.md) · [Uptime report](docs/uptime.md) · [Camera events and firmware](docs/camera-events.md) · [Architecture and security](docs/architecture.md) · [Operations](docs/operations.md) · [Adding a camera brand](docs/adding-a-camera-brand.md) · API docs at `/api/docs`.
