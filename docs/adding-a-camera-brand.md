# Adding a new camera brand

This guide shows where a new camera brand goes in the code and what each file does. There are two
ways to add a brand; pick the first one that fits.

| Way | When | Code? |
|---|---|---|
| **A. In the app** (Settings → Camera brands → Add brand) | The camera answers its storage with **one** HTTP request (JSON or XML), with Digest/Basic login, an API key or no login | No — see [brand-integrations.md](brand-integrations.md) |
| **B. Same firmware as a brand we have** | e.g. Prama = Hikvision, CP Plus / Amcrest = Dahua | A few lines (alias or small subclass) |
| **C. A new adapter** | Anything else: a login step first, signed requests, SOAP, several requests, recording status, live view, recordings, NVR channels | Yes — this guide |

Before you start, get **one real camera** of the brand, its admin login, and the vendor's API
documentation. If there is no documentation, open the camera's own web page, press **F12 →
Network**, and watch which requests the page makes (right-click → **Copy as cURL** gives the exact
request). That is how the CP Plus (`/cpapi2`, `user.signin`, `ETag`) and Prama (`/pramaAPI`) support
was found.

## Where things are

```
server/src/integrations/
  types.ts                 the CameraBrandAdapter interface every brand implements (read this first)
  registry.ts              the list of brands: register the new adapter here, plus name aliases
  http/cameraHttpClient.ts the only way to talk to a camera (login, HTTPS, time-outs, blocked addresses)
  http/responses.ts        requireOk(): turns HTTP errors into clear messages
  storageMath.ts           aggregate(): totals and percentages from the disks you return
  parsing.ts               helpers: byte counts with units, status words → health, key=value replies
  recording.ts             combineRecording(): recording status from per-channel states
  diagnostics.ts           runDiagnostics(): the "Test connection" checks, works for every brand
  snapshot.ts              fetchSnapshot(): the still picture for the live view
  onvif/                   ONVIF (storage, recording status, recordings, live address) — reuse it
  hikvision/ dahua/ uniview/ hanwha/ axis/ panasonic/ prama/   existing brands, copy from these
  <yourbrand>/adapter.ts   NEW: your adapter
  <yourbrand>/parser.ts    NEW: turns the camera's replies into the app's model

server/src/testing/        simulated cameras used by tests and the demo (mockHikvision.ts, mockVendor.ts)
server/test/unit/          parser tests with recorded camera replies
server/test/integration/   end-to-end tests against a simulated camera
```

Nothing outside `server/src/integrations/` knows about brands. Once the adapter is registered, the
camera form, dashboard, alerts, history charts, reports, AI, live view and recordings all work for
it automatically — the web app reads the brand list from the server (`GET /api/brands`), and the
brand is copied into the database on start-up (`syncBrands()` in `services/brandService.ts`). No
database migration and no web change is needed.

## B. A brand with the same firmware as one we have

- **Just another name for the same thing** (e.g. "Amcrest" is Dahua): add an alias in
  `resolveKey()` in `registry.ts`:

  ```ts
  amcrest: "dahua",
  ```

- **Its own name in the brand list, with small differences** (e.g. Prama): make a subclass, change
  `meta` and override only what differs. See `prama/adapter.ts`, which extends `HikvisionAdapter`
  and only changes the API path (`/pramaAPI` instead of `/ISAPI`). Then register it (step 3 below).

## C. A new adapter, step by step

The example is a made-up brand, **Acme Vision**, whose camera answers `GET /api/v1/storage` with:

```json
{ "disks": [ { "id": "sd1", "name": "SD card", "state": "ok", "totalMB": 244140, "freeMB": 100000 } ] }
```

### 1. The parser — `server/src/integrations/acme/parser.ts`

Turns the camera's reply into the app's model. Keep it free of network code so it can be tested with
recorded replies. Sizes are always **bytes**; health is one of `healthy`, `degraded`, `unhealthy`,
`unknown`.

```ts
import { aggregate } from "../storageMath.js";
import { parseByteCount, statusMapper } from "../parsing.js";
import { CameraApiError, type DeviceInfo, type StorageReading } from "../types.js";

/** The vendor's disk states, mapped to the app's four health states. */
const health = statusMapper({ healthy: ["ok", "normal"], degraded: ["formatting"], unhealthy: ["error", "broken"] });

/** Turns the camera's storage reply into the app's storage model (bytes). */
export function parseAcmeStorage(body: string): StorageReading {
  let json: { disks?: { id: string; name?: string; state?: string; totalMB?: number; freeMB?: number }[] };
  try {
    json = JSON.parse(body);
  } catch {
    throw new CameraApiError("INVALID_RESPONSE", "The camera's storage reply is not JSON");
  }
  return aggregate((json.disks ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    healthStatus: health(d.state),
    rawStatus: d.state,
    totalBytes: parseByteCount(d.totalMB, 1024 * 1024),
    freeBytes: parseByteCount(d.freeMB, 1024 * 1024),
  })));
}

export function parseAcmeDeviceInfo(body: string): DeviceInfo {
  const j = JSON.parse(body) as { model?: string; serial?: string; firmware?: string };
  return { model: j.model, serialNumber: j.serial, firmwareVersion: j.firmware };
}
```

### 2. The adapter — `server/src/integrations/acme/adapter.ts`

Only three methods are required: `getStorageStatus`, `getDeviceInfo`, `testConnection`.

```ts
import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { runDiagnostics } from "../diagnostics.js";
import type { BrandMeta, CameraBrandAdapter, CameraConfig, ConnectionResult, DeviceInfo, StorageReading } from "../types.js";
import { parseAcmeDeviceInfo, parseAcmeStorage } from "./parser.js";

export const ACME_STORAGE_PATH = "/api/v1/storage";

export class AcmeAdapter implements CameraBrandAdapter {
  readonly meta: BrandMeta = {
    key: "acme",                       // short, lower case, never changed later (cameras store it)
    displayName: "Acme Vision",        // what users see in the brand list
    supportStatus: "unverified",       // "supported" only after testing on a real camera
    authMethods: ["digest"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "device-info", "connection-test"],
    storageEndpoint: `GET ${ACME_STORAGE_PATH}`,
    defaultTimeoutMs: 10000,
    notes: "JSON API with HTTP Digest authentication; capacities in MB.",
  };

  constructor(private readonly http: CameraHttpClient) {}

  private async get(camera: CameraConfig, path: string): Promise<string> {
    // The shared client handles Digest/Basic login, HTTPS certificates, time-outs and blocked addresses.
    return requireOk(await this.http.request(camera, { path, accept: "application/json" }), path);
  }

  async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    return parseAcmeStorage(await this.get(camera, ACME_STORAGE_PATH));
  }

  async getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    return parseAcmeDeviceInfo(await this.get(camera, "/api/v1/system"));
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
```

Always talk to the camera through `this.http` (`CameraHttpClient`). It does the HTTP Digest/Basic
login, verifies HTTPS certificates (or the camera's pinned certificate), refuses addresses outside
**Settings → Camera networks**, and times out. Never use `fetch` or another HTTP library directly.

**Errors:** throw `CameraApiError` with the right code so the app shows the right message and
decides whether to retry:

| Code | Use when |
|---|---|
| `AUTH_FAILED` | wrong username/password, login refused |
| `API_UNAVAILABLE` | the camera has no such API (HTTP 404) — lets you fall back to another path or ONVIF |
| `INVALID_RESPONSE` | the reply cannot be read |
| `API_ERROR` | anything else the camera refused |

Add `{ transient: true }` only for failures worth retrying (time-outs, HTTP 5xx). `requireOk()`
already maps HTTP statuses for you.

### 3. Register it — `server/src/integrations/registry.ts`

```ts
import { AcmeAdapter } from "./acme/adapter.js";
...
export function createRegistry(http = new CameraHttpClient(hostGuard)): BrandRegistry {
  ...
  registry.register(new AcmeAdapter(http));
```

Optionally add aliases in `resolveKey()` (other spellings users may type, e.g. `acmevision: "acme"`).
The brand now appears in **Add camera** and in **Settings → Camera brands**.

### 4. Tests — `server/test/unit/acmeParser.test.ts`

Save real replies from the camera (remove serial numbers and anything private) and test the parser:

```ts
import { describe, expect, it } from "vitest";
import { parseAcmeStorage } from "../../src/integrations/acme/parser.js";

describe("Acme parser", () => {
  it("reads the SD card", () => {
    const r = parseAcmeStorage(JSON.stringify({ disks: [{ id: "sd1", state: "ok", totalMB: 1000, freeMB: 250 }] }));
    expect(r.devices[0]).toMatchObject({ id: "sd1", healthStatus: "healthy", totalBytes: 1000 * 1024 * 1024 });
    expect(r.usedPercentage).toBe(75);
  });
});
```

Also update the brand list in `test/unit/brandAdapters.test.ts` (it checks every registered brand).
For logins with several steps, test the adapter with a fake `CameraHttpClient`, as
`test/unit/dahuaRpc.test.ts` does for CP Plus.

Run everything before committing:

```
npm run typecheck -w server && npm run lint -w server && npm test -w server
```

### 5. Try it on the real camera

Start the app, add the camera with the new brand, and use **Test connection**, then **Check
storage**. When it works on real cameras, change `supportStatus` to `"supported"` and fill in
`compatibility` with the models and firmware you tested (shown in Settings → Camera brands).

## Optional features

Add these methods to the adapter when the camera supports them (all are in `types.ts`; the app hides
a feature for brands that don't have it). Copy from the brand named.

| Feature | Add | Example |
|---|---|---|
| Recording status (recording / idle) | `getRecordingStatus()` | `hikvision/adapter.ts` |
| Live video | `rtspPath` (sub stream, H.264), `rtspFallbacks`, or `liveRtspUrl()` via ONVIF | `uniview/adapter.ts` |
| Live picture (snapshot) | `getSnapshot()` with `fetchSnapshot()` | `uniview/adapter.ts` |
| Recordings: days and timeline | `getRecordingRange()`, `listRecordings()` | `hikvision/adapter.ts` |
| Recordings: playback | `playbackRtspPath()`, or `replayRtspUrl()` via ONVIF | `uniview/adapter.ts`, `onvif/adapter.ts` |
| NVR channels | `getChannels()`, `channelRtspPaths()`, and the `channel` argument on the methods above | `hikvision/adapter.ts` |
| Fallback to ONVIF when the brand API is missing | keep an `OnvifAdapter` and call it on `API_UNAVAILABLE` | `uniview/adapter.ts`, `prama/adapter.ts` |
| A login step / session first | a small client class that logs in, calls, logs out | `dahua/rpc.ts` (CP Plus) |

Also list the feature in `meta.capabilities` (`"recording-status"`, `"live-view"`, `"playback"`, …).

## Checklist

- [ ] `server/src/integrations/<brand>/parser.ts` and `adapter.ts`
- [ ] Registered in `createRegistry()` in `registry.ts` (+ aliases in `resolveKey()`)
- [ ] Parser tests with real replies; brand list updated in `test/unit/brandAdapters.test.ts`
- [ ] `typecheck`, `lint` and `test` pass
- [ ] Tested on a real camera; then `supportStatus: "supported"` and `compatibility` filled in
- [ ] A line about the brand in [brand-integrations.md](brand-integrations.md) (the table at the top)
