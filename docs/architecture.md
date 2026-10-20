# Architecture and security

## Components

```
Browser ──HTTPS──> Caddy ──> API (Express)  ──┐
                                             ├──> PostgreSQL
                    Monitoring worker  ──────┘
                         │
                         └──HTTP(S) + Digest──> Cameras (only registered, allow-listed addresses)
```

- **API** (`server/src/index.ts`): authentication, camera management, Test Connection, manual checks,
  alerts, settings, import, OpenAPI docs. In production it also serves the built web app (same origin).
- **Worker** (`server/src/worker.ts`): scheduled storage checks and retention housekeeping.
- **Browser**: never talks to cameras. It receives normalised data only; passwords are write-only.

## Code layout (server)

| Path | Responsibility |
|---|---|
| `integrations/types.ts` | Vendor-neutral types: `CameraBrandAdapter`, `StorageReading`, error codes |
| `integrations/registry.ts` | Brand registry: implemented adapters + planned brands |
| `integrations/http/cameraHttpClient.ts` | HTTP client with Digest (MD5/SHA-256, `-sess`) and Basic auth, timeouts, size limits |
| `integrations/hikvision/` | Hikvision adapter and ISAPI XML parsing |
| `integrations/{axis,uniview,dahua,onvif}/` | Adapters and parsers for Axis VAPIX text, Uniview LAPI JSON, Dahua/CP Plus CGI lists and ONVIF SOAP (`onvif/soap.ts`: WS-Security envelopes) |
| `integrations/http/responses.ts` | Shared classification of non-2xx camera responses |
| `integrations/parsing.ts` | Shared parser helpers: strict byte counts, `key=value` lines, status mapping |
| `integrations/diagnostics.ts` | Generic step-by-step Test Connection |
| `monitoring/checkService.ts` | One check: lease → adapter call with retries → persist → evaluate alerts |
| `monitoring/evaluate.ts` | Pure functions: storage health and alert conditions |
| `monitoring/scheduler.ts` | Claims due cameras (`FOR UPDATE SKIP LOCKED`) within the concurrency limit |
| `services/` | Cameras, alerts, import, settings, users, audit, notifications |
| `security/` | AES-256-GCM cipher, password hashing, SSRF host guard, redaction |
| `routes/` | HTTP endpoints, validation and permission checks |

## Adding a camera brand

1. Create `server/src/integrations/<brand>/adapter.ts` implementing `CameraBrandAdapter`:
   - `meta`: display name, `supportStatus`, auth methods, default ports, capabilities, storage endpoint,
     timeout, notes.
   - `getStorageStatus(camera)`: call the vendor's **verified** storage API through `CameraHttpClient` and
     return a `StorageReading` in bytes (use `aggregate()` from `storageMath.ts`).
   - `getDeviceInfo(camera)`: model / serial / firmware if the device exposes it.
   - `getRecordingStatus(camera)` (optional): whether the camera records now, as a `RecordingReading`
     (`recording` / `idle` / `error` / `unknown`; use `combineRecording()` from `recording.ts`). The monitor calls
     it once per successful check without retries; a failure only makes the state `unknown`.
   - `testConnection(camera)`: usually `runDiagnostics(this, camera)`.
   - Throw `CameraApiError` with the right code (`AUTH_FAILED`, `API_UNAVAILABLE`, `INVALID_RESPONSE`, …)
     and `transient: true` only for retryable failures.
2. Register it in `createRegistry()` and remove the brand from the `PLANNED` list.
3. Add parser and adapter tests with recorded responses (see `test/unit/hikvisionParser.test.ts`).
4. Mark it `supported` only after testing on real devices; use `unverified` until then.

No other part of the application contains brand-specific logic. ONVIF has no universal storage-capacity
API: the ONVIF adapter calls `GetStorageDevices` on the device service, which only some devices implement.
It authenticates with a WS-Security UsernameToken and, if the token is rejected, reads the camera's clock
(`GetSystemDateAndTime`) and retries once with a corrected timestamp.

## Monitoring model

- Each camera has one `camera_status` row (current state) and many `storage_checks` rows (history).
- The scheduler claims due cameras with a time-limited lease (`check_lock_until`). A crashed worker's
  leases expire and the cameras are picked up again. Manual checks use the same lease, so a camera is never
  checked twice at once.
- Transient errors (timeouts, refused connections, HTTP 5xx) are retried with exponential backoff and
  jitter; authentication and parsing errors are not retried.
- **Offline** is declared only after `offlineFailureThreshold` consecutive network failures (default 3).
- Error categories stay distinct: network (offline), authentication, camera API, configuration, and disk
  health reported by the camera. A timeout never raises or clears a disk alert.
- Alerts: at most one open alert per camera and type (enforced by a unique partial index). Recurrences
  update `last_seen_at` and `occurrence_count`; severity changes are recorded as escalations; cleared
  conditions auto-resolve (usage alerts use a hysteresis margin).

## Security

| Concern | Implementation |
|---|---|
| Camera passwords at rest | AES-256-GCM with a random IV per secret; key from `CREDENTIAL_ENCRYPTION_KEY`; key versions allow rotation |
| Passwords in transit to cameras | HTTP Digest (never in URLs). Basic auth is refused over plain HTTP. HTTPS supported with certificate verification always on; a per-camera CA certificate can be trusted for self-signed cameras |
| Exposure | Passwords are write-only in the API, never logged, redacted from error messages, absent from history and audit tables. Removing a camera deletes its credentials |
| SSRF | Camera hosts must be IPs or hostnames (no URLs); every resolved address must be inside `CAMERA_ALLOWED_NETWORKS`; loopback, link-local/metadata (169.254.0.0/16), multicast and reserved ranges are always blocked; the connection is pinned to the checked address (no DNS rebinding); redirects are not followed; response size is capped |
| Users | scrypt password hashes, account lockout after 5 failures, sessions stored as SHA-256 hashes with expiry, httpOnly `SameSite=Strict` secure cookies |
| CSRF | Per-session token required in `X-CSRF-Token` on every state-changing request |
| Authorization | Roles and permissions in the `roles` table; every protected route checks a permission |
| Rate limiting | Login, device-contacting endpoints (test/check) and import are rate-limited |
| Input validation | Zod schemas on every request; parameterised SQL throughout |
| Headers | Helmet (CSP without inline scripts, HSTS, nosniff, frame protection) |
| Audit | Camera create/update/remove, credential changes, monitoring toggles, imports, alert acknowledge/resolve, settings, users, logins |
| Import | CSV parsed in the browser; the file is never uploaded; rows are processed in memory only |

Network recommendation: run the monitor on a trusted management network, restrict
`CAMERA_ALLOWED_NETWORKS` to the camera VLAN(s), and firewall the cameras so only the monitor can reach
their web ports.
