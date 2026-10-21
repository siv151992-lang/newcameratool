# Camera brand integrations

Every camera is monitored through a **brand integration**. There are two kinds:

| | Custom adapter (Mode B) | Configurable API (Mode A) |
|---|---|---|
| What it is | A trusted adapter in this code base (`server/src/integrations/<brand>/`) with automated tests | A validated, declarative configuration created in **Settings → Camera brands** |
| Brands today | Hikvision, Dahua / CP Plus / Amcrest, Axis, Uniview, Hanwha Vision (Wisenet), Generic ONVIF | Whatever an administrator adds |
| Changing it | A reviewed code change and a new release | In the UI: every change is a new configuration version that must pass a test before it monitors cameras |
| Can do | Anything (several requests, SOAP + WS-Security, key=value parsing, recording status, …) | One HTTP request returning JSON or XML, mapped onto the storage model |

Both kinds implement the same adapter interface (`CameraBrandAdapter`: test connection, device
information, storage status, error classification, capabilities) and return the same normalised
storage model, so the dashboard, alerts, history charts, reports and AI forecasts work the same for
every brand. No other part of the application contains brand-specific logic.

## Adding a brand in the UI (administrators)

Before you start, get the vendor's HTTP API documentation and one real camera of that brand with a
memory card or disk installed, on a network listed in **Settings → Camera networks**.

1. **Settings → Camera brands → Add brand.**
2. **Brand details.** Name (must be unique), manufacturer, description, models, default protocol
   and ports, and your version label. Choose **Configurable API**. If the API needs any of the things
   listed under [What needs a custom adapter](#what-needs-a-custom-adapter), stop here: the wizard
   explains that a developer must add an adapter.
3. **API configuration.**
   - Method (GET or POST) and the endpoint **path only**, e.g. `/api/v1/storage`. The camera's
     address, port and protocol come from each camera; full URLs are refused.
   - Fixed query parameters and headers (credential, cookie, host and framing headers cannot be
     set), an optional POST body, timeout and response format (JSON or XML).
   - Authentication: none, HTTP Basic, HTTP Digest, API key (header or query parameter) or bearer
     token. Basic, API key and bearer credentials are only ever sent over HTTPS; Digest also works
     over HTTP. The credentials themselves are entered **per camera** and stored encrypted.
   - Pagination, if the API returns devices in pages (`?page=1`, `?page=2`, … up to 20 pages). Paging
     stops at an empty page, a page identical to the previous one (cameras that ignore or clamp the
     parameter), a page that only repeats device IDs already seen, a short page (when a page size is
     set) or a 4xx answer after the first page — so a disk is never counted twice.
   - Header and query parameter **names** that look like secrets (token, key, auth, session,
     password, …) are refused: a secret belongs to each camera (API key or bearer authentication),
     where it is stored encrypted.
4. **Response mapping.** Tell the application where the values are:
   - **Storage device list**: path to the list of disks, e.g. `data.disks[*]` (JSON) or
     `StorageInfo.Disks.Disk` (XML). One element is treated as a one-disk list.
   - **Fields** (relative to each disk): device ID, name, **total capacity** (required), **free**
     and/or **used capacity**, each with its unit (B, KB, MB, GB, TB, KiB, MiB, GiB, TiB), disk
     health status and read/write status.
   - **Status values**: which vendor words mean healthy, degraded, unhealthy or "no disk installed"
     (such slots are skipped).
   - Optionally a second request for model, serial number and firmware.
   - Paste a sample response (from the documentation or a camera) and click **Preview mapping**, or
     use **Fetch a sample from a test camera**. The preview shows each disk's vendor values, the
     normalised result, missing required fields and validation errors. Nothing is sent to a camera
     when previewing a pasted sample.
5. **Test integration.** Enter a test camera's address and credentials (or pick a camera already
   using the brand) and click **Save and test API**. The test runs on the server and reports one of:
   storage retrieved, network failure, address not allowed, authentication failure, HTTP/API
   failure, invalid JSON/XML, mapping failure or no storage data — with a sanitised diagnostic and a
   redacted copy of the response.
6. **Review and publish.** Save it as a **Draft**, or **Enable for monitoring**. A configuration
   becomes **Tested** automatically when a test passes; only a tested configuration can be enabled.

The brand then appears in **Add camera**. Choosing it applies its default protocol and port and
shows the credentials it needs (username + password, an API key/token, or none).

### Path syntax

Paths are dotted names, not code: `data.disks[*].capacity`, `hddList.hdd`, `items[0].size`.
`[*]` keeps every element, `[n]` one element. XML attributes are `@name`, an element's text with
attributes is `#text`, and namespace prefixes are ignored. A leading `$.` is accepted. Only the
object's own properties are read; nothing is evaluated.

### Values and validation

Numbers must be plain, non-negative decimals (`1024`, `"119.2"`); signs, exponents and text are
rejected rather than guessed. Units are converted to bytes. Free capacity larger than total, or used
larger than total, is an error. When both used and free are mapped and do not add up to total (more
than 1 %), free capacity is used and a warning is shown. Free capacity is derived from total − used
only when the camera reports both.

## Lifecycle

| Status | Meaning |
|---|---|
| Draft | Saved, latest configuration not successfully tested |
| Tested | Latest configuration passed a test; not used for monitoring yet |
| Enabled | Used for monitoring and offered when adding cameras |
| Disabled | Not checked and not offered; cameras, history and alerts are kept |

- Every configuration change creates a new **version**. While a brand is enabled, monitoring keeps
  using the active version until the new one passes a test and is activated. Earlier tested
  versions can be **rolled back** to from the brand page.
- **Disable** shows how many cameras are affected, stops their scheduled checks and keeps
  everything else. Built-in adapters can be disabled too.
- **Delete** is only possible for configurable brands with no cameras. Use **Reassign cameras** to
  move cameras to another enabled integration first. Built-in adapters cannot be deleted.
- **Re-enabling** a disabled brand uses its newest configuration if that passed a test, otherwise the
  tested configuration that was in use before.
- Moving cameras to a brand with a different kind of login (username + password, API key/token,
  none) is refused by **Reassign cameras**; edit such cameras one by one and enter the new
  credentials (the camera form asks for them). Reassigning HTTP cameras to an integration that only
  sends credentials over HTTPS is refused too.
- Every create, change, test, enable, disable, rollback, reassignment and deletion is in the audit
  log. Test history is kept per brand; storage checks record the integration version that produced
  them (e.g. `1.0 (config 3)`).

## Security

- Integration management is administrator-only (`settings:write`); operators can view it.
- A configuration only describes a path on the camera: it cannot name a host. Every request goes
  through the same client as the built-in adapters: the camera address is resolved on the server
  and must be in **Settings → Camera networks**; loopback, link-local/cloud metadata, multicast and
  reserved ranges are always blocked; the connection is pinned to the checked address (no DNS
  rebinding); redirects are not followed; responses are capped at 2 MB; requests time out.
- TLS certificates are always verified. A camera with a self-signed certificate needs its CA
  certificate pasted on the camera's edit page; verification is never turned off.
- XML is parsed without DOCTYPE or entity declarations (refused outright); JSON is strict.
- No secrets are stored in configurations. Camera passwords, API keys and tokens are encrypted with
  the camera, never returned to the browser, and redacted from test results, logs and the stored
  test history. Sample responses shown in the UI have values of password/token/key/secret/session
  fields replaced with `[REDACTED]`.
- Test results are scrubbed of the camera's secret in every form (as is, URL-encoded, Basic-encoded)
  and of values mapped from sensitive-looking paths, wherever they appear. Tests are rate-limited (20 per minute) and each integration limits concurrent requests
  (`maxConcurrency`, default 5).

## What needs a custom adapter

The configurable framework deliberately supports only what has been implemented and reviewed. These
need a developer-built adapter (see [Adding a camera brand](architecture.md#adding-a-camera-brand)):

- Login flows that first obtain a session cookie or token (e.g. `POST /login`, then reuse it)
- OAuth, request signing (HMAC, AWS-style), challenge-response or other vendor cryptography
- SOAP with WS-Security (use the built-in ONVIF adapter) or several dependent requests
- Non-HTTP or proprietary binary protocols, websockets, and plain-text `key=value` replies
  (Dahua/Axis style — those brands already have adapters)
- Values that need calculation beyond unit conversion (e.g. blocks × block size)
- Recording status (configurable integrations report recording as *Unknown*)

The application never runs uploaded scripts, plugins or JavaScript expressions. Custom adapters are
ordinary reviewed code with metadata (version, capabilities, compatibility notes) and tests.

## Trying it without hardware

`npm run mock-camera -w server -- --port 8081 --count 4 --vendor` starts four simulated Hikvision
cameras and a simulated **Acme Vision** camera (an unknown brand) on port 8085, user `admin`,
password `Acme-Passw0rd!`, Digest authentication. It serves JSON at `/api/v1/storage` (paged with
`?page=`), XML at `/cgi-bin/storage.xml` and device information at `/api/v1/system`. With
`CAMERA_ALLOW_LOOPBACK=true` (development only), add it as a configurable brand with:

| Setting | Value |
|---|---|
| Path | `/api/v1/storage`, Digest, JSON, pagination by `page` |
| Storage device list | `storage.devices` |
| ID / name | `slot` / `label` |
| Total / free | `sizeMiB` / `freeMiB`, unit MiB |
| Disk status / read-write | `state` / `access`; "No disk installed": `nocard` |
| Device information | `/api/v1/system`: `system.model`, `system.serial`, `system.firmware` |
