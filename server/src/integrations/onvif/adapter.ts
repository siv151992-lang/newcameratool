import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { runDiagnostics } from "../diagnostics.js";
import {
  CameraApiError,
  type BrandMeta,
  type CameraBrandAdapter,
  type CameraConfig,
  type ConnectionResult,
  type DeviceInfo,
  type RecordedSegment,
  type RecordingRange,
  type RecordingList,
  type RecordingReading,
  type StorageReading,
} from "../types.js";
import {
  parseOnvifDeviceInfo,
  parseOnvifFault,
  parseOnvifLocalOffset,
  parseOnvifRecording,
  parseOnvifRecordingSummary,
  parseOnvifServices,
  parseOnvifStorage,
  parseOnvifSystemTime,
  parseOnvifMediaUri,
  parseOnvifProfileToken,
  parseOnvifRecordingResults,
  parseOnvifSearchToken,
} from "./parser.js";
import { escapeXml, NS, soapEnvelope } from "./soap.js";
import { COMMON_ONVIF_ENDPOINTS, probeOnvifEndpoint, type OnvifEndpoint } from "./discovery.js";
import { hostGuard } from "../../security/hostGuardInstance.js";
import { fetchSnapshot } from "../snapshot.js";

export const ONVIF_DEVICE_SERVICE_PATH = "/onvif/device_service";
export const ONVIF_RECORDING_SERVICE_PATH = "/onvif/recording_service";
export const ONVIF_SEARCH_SERVICE_PATH = "/onvif/search_service";
export const ONVIF_REPLAY_SERVICE_PATH = "/onvif/replay_service";

/** Clock differences below this are within what cameras accept for a WS-Security timestamp. */
const MAX_CLOCK_SKEW_MS = 5000;
const MAX_CACHED_OFFSETS = 1000;

interface SoapAction {
  path: string;
  action: string;
  body: string;
  auth: boolean;
}

const ACTIONS = {
  storage: { path: ONVIF_DEVICE_SERVICE_PATH, action: `${NS.tst}/GetStorageDevices`, body: "<tst:GetStorageDevices/>", auth: true },
  deviceInfo: { path: ONVIF_DEVICE_SERVICE_PATH, action: `${NS.tds}/GetDeviceInformation`, body: "<tds:GetDeviceInformation/>", auth: true },
  recording: { path: ONVIF_RECORDING_SERVICE_PATH, action: `${NS.trc}/GetRecordingJobs`, body: "<trc:GetRecordingJobs/>", auth: true },
  services: { path: ONVIF_DEVICE_SERVICE_PATH, action: `${NS.tds}/GetServices`, body: "<tds:GetServices><tds:IncludeCapability>false</tds:IncludeCapability></tds:GetServices>", auth: true },
  summary: { path: ONVIF_SEARCH_SERVICE_PATH, action: `${NS.tse}/GetRecordingSummary`, body: "<tse:GetRecordingSummary/>", auth: true },
  profiles: { path: "/onvif/media_service", action: `${NS.trt}/GetProfiles`, body: "<trt:GetProfiles/>", auth: true },
  // ONVIF requires GetSystemDateAndTime to work without credentials.
  systemTime: { path: ONVIF_DEVICE_SERVICE_PATH, action: `${NS.tds}/GetSystemDateAndTime`, body: "<tds:GetSystemDateAndTime/>", auth: false },
} satisfies Record<string, SoapAction>;

export class OnvifAdapter implements CameraBrandAdapter {
  readonly meta: BrandMeta = {
    key: "onvif",
    displayName: "Generic ONVIF",
    supportStatus: "unverified",
    authMethods: ["ws-security (UsernameToken digest)", "digest"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "live-view", "playback", "multiple-storage-devices"],
    storageEndpoint: `POST ${ONVIF_DEVICE_SERVICE_PATH} (GetStorageDevices)`,
    defaultTimeoutMs: 10000,
    notes:
      "SOAP over the ONVIF device service with WS-Security, correcting for the camera's clock. ONVIF has no " +
      "universal storage-capacity call, so storage only works on devices implementing GetStorageDevices; " +
      "confirm with Test Connection.",
  };

  /** Service paths per camera (from GetServices), so recording and search work where they are not at the usual path. */
  private readonly servicePaths = new Map<string, Map<string, string>>();
  /** Camera clock minus our clock, per camera, learned after a rejected token. */
  private readonly clockOffsets = new Map<string, number>();
  /**
   * Where each camera's ONVIF service really is, when not at its configured protocol, port and
   * /onvif/device_service (found by discovery or by trying the usual ports), and when to look again.
   */
  private readonly endpoints = new Map<string, OnvifEndpoint>();
  private readonly searchedAt = new Map<string, number>();

  /** The camera as ONVIF must be contacted: its own address, at the ONVIF service's protocol and port. */
  private target(camera: CameraConfig): { camera: CameraConfig; devicePath: string } {
    const ep = this.endpoints.get(cameraKey(camera));
    return ep ? { camera: { ...camera, protocol: ep.protocol, port: ep.port }, devicePath: ep.path } : { camera, devicePath: ONVIF_DEVICE_SERVICE_PATH };
  }

  /**
   * Finds the camera's ONVIF service when it is not at the configured address: asks the camera
   * (WS-Discovery), then tries the usual ONVIF ports with GetSystemDateAndTime, which every ONVIF
   * device answers without a login. At most once an hour per camera.
   */
  private async findEndpoint(camera: CameraConfig): Promise<boolean> {
    const key = cameraKey(camera);
    if (Date.now() - (this.searchedAt.get(key) ?? 0) < 3_600_000) return false;
    if (this.searchedAt.size > MAX_CACHED_OFFSETS) this.searchedAt.clear();
    this.searchedAt.set(key, Date.now());
    const answers = async (ep: OnvifEndpoint) => {
      try {
        const res = await this.http.request({ ...camera, protocol: ep.protocol, port: ep.port, timeoutMs: Math.min(camera.timeoutMs, 4000) }, {
          method: "POST",
          path: ep.path,
          body: soapEnvelope(ACTIONS.systemTime.body),
          contentType: `application/soap+xml; charset=utf-8; action="${ACTIONS.systemTime.action}"`,
          accept: "application/soap+xml, text/xml, */*",
          auth: "none",
        });
        // A SOAP answer, or a login challenge (some cameras ask for one even here).
        return /SystemDateAndTime|Envelope/i.test(res.body) && res.status < 500 ? ep : undefined;
      } catch (err) {
        return err instanceof CameraApiError && err.code === "AUTH_FAILED" ? ep : undefined;
      }
    };
    let found: OnvifEndpoint | undefined;
    try {
      // The address the camera announces itself is used as it is.
      found = await probeOnvifEndpoint((await hostGuard.resolve(camera.host)).address);
    } catch {
      // discovery is optional
    }
    if (!found) {
      const others = COMMON_ONVIF_ENDPOINTS.filter((ep) => !(ep.protocol === camera.protocol && ep.port === camera.port));
      found = (await Promise.all(others.map(answers))).find(Boolean);
    }
    if (!found) return false;
    this.endpoints.set(key, found);
    this.servicePaths.delete(key);
    return true;
  }

  constructor(private readonly http: CameraHttpClient) {}

  private async call(camera: CameraConfig, op: SoapAction, now = Date.now() + this.offsetFor(camera)): Promise<string> {
    const body = soapEnvelope(op.body, op.auth ? { username: camera.username, password: camera.password, now } : undefined);
    const t = this.target(camera);
    const res = await this.http.request(t.camera, {
      method: "POST",
      path: op.path === ONVIF_DEVICE_SERVICE_PATH ? t.devicePath : op.path,
      body,
      contentType: `application/soap+xml; charset=utf-8; action="${op.action}"`,
      accept: "application/soap+xml, text/xml, */*",
    });
    return requireOk(res, op.path, parseOnvifFault);
  }

  /**
   * Calls an authenticated action, retrying once with the camera's clock if the token was rejected,
   * and once at the camera's real ONVIF address if it is not at the configured one.
   */
  private async authenticated(camera: CameraConfig, op: SoapAction): Promise<string> {
    try {
      return await this.signedIn(camera, op);
    } catch (err) {
      const elsewhere = err instanceof CameraApiError &&
        (err.code === "API_UNAVAILABLE" || err.code === "UNREACHABLE" || err.code === "TIMEOUT" || err.code === "TLS_ERROR" || err.options.httpStatus === 302);
      if (!elsewhere || this.endpoints.has(cameraKey(camera))) throw err;
      const searched = !this.searchedAt.has(cameraKey(camera)) || Date.now() - this.searchedAt.get(cameraKey(camera))! >= 3_600_000;
      if (!(await this.findEndpoint(camera))) {
        if (!searched) throw err;
        const ports = [...new Set(COMMON_ONVIF_ENDPOINTS.map((e) => e.port))].join(", ");
        throw new CameraApiError(err.code, `${err.message}. No ONVIF service answered on the camera's other usual ports (${ports}), and it did not answer an ONVIF discovery request`, err.options);
      }
      const t = this.target(camera);
      return this.signedIn(camera, op).catch((again) => {
        throw again instanceof CameraApiError
          ? new CameraApiError(again.code, `${again.message} (ONVIF found at ${t.camera.protocol}://${camera.host}:${t.camera.port}${t.devicePath})`, again.options)
          : again;
      });
    }
  }

  private async signedIn(camera: CameraConfig, op: SoapAction): Promise<string> {
    try {
      return await this.call(camera, op);
    } catch (err) {
      if (!(err instanceof CameraApiError) || err.code !== "AUTH_FAILED") throw err;
      const offset = await this.learnClockOffset(camera);
      if (offset === undefined) throw err;
      return this.call(camera, op, Date.now() + offset);
    }
  }

  /** Reads the camera clock; returns the new offset only if it differs enough to matter. */
  private async learnClockOffset(camera: CameraConfig): Promise<number | undefined> {
    let deviceNow: number | undefined;
    try {
      deviceNow = parseOnvifSystemTime(await this.call(camera, ACTIONS.systemTime));
    } catch {
      return undefined;
    }
    if (deviceNow === undefined) return undefined;
    const offset = deviceNow - Date.now();
    const key = cameraKey(camera);
    const previous = this.clockOffsets.get(key) ?? 0;
    if (Math.abs(offset - previous) < MAX_CLOCK_SKEW_MS) return undefined;
    if (this.clockOffsets.size >= MAX_CACHED_OFFSETS) this.clockOffsets.clear();
    this.clockOffsets.set(key, offset);
    return offset;
  }

  private offsetFor(camera: CameraConfig) {
    return this.clockOffsets.get(cameraKey(camera)) ?? 0;
  }

  async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    return parseOnvifStorage(await this.authenticated(camera, ACTIONS.storage));
  }

  async getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    return parseOnvifDeviceInfo(await this.authenticated(camera, ACTIONS.deviceInfo));
  }

  /** An action sent to the path the camera lists for its service, when it lists one. */
  private async atService(camera: CameraConfig, op: SoapAction, ns: string): Promise<SoapAction> {
    const key = cameraKey(camera);
    let paths = this.servicePaths.get(key);
    if (!paths) {
      paths = await this.authenticated(camera, ACTIONS.services).then(parseOnvifServices, () => new Map<string, string>());
      if (this.servicePaths.size >= MAX_CACHED_OFFSETS) this.servicePaths.clear();
      this.servicePaths.set(key, paths);
    }
    const path = paths.get(ns);
    return path ? { ...op, path } : op;
  }

  async getRecordingStatus(camera: CameraConfig): Promise<RecordingReading> {
    return parseOnvifRecording(await this.authenticated(camera, await this.atService(camera, ACTIONS.recording, NS.trc)));
  }

  /**
   * Days of recordings from GetRecordingSummary (Profile G): DataFrom, the oldest recording, against
   * the camera's clock; the oldest recording is shown in the camera's local time.
   */
  async getRecordingRange(camera: CameraConfig): Promise<RecordingRange | null> {
    const summary = parseOnvifRecordingSummary(await this.authenticated(camera, await this.atService(camera, ACTIONS.summary, NS.tse)));
    if (summary.from === undefined || summary.recordings === 0) return null;
    const { now, shiftMs } = await this.cameraClock(camera);
    const days = Math.max(0, Math.round(((now - summary.from) / 86_400_000) * 100) / 100);
    return { oldest: new Date(summary.from + shiftMs).toISOString().slice(0, 19), days };
  }

  /** The media profile to stream (H.264 where there is one), per camera. */
  private async profileToken(camera: CameraConfig): Promise<string> {
    return parseOnvifProfileToken(await this.authenticated(camera, await this.atService(camera, ACTIONS.profiles, NS.trt)));
  }

  private async mediaUri(camera: CameraConfig, kind: "Stream" | "Snapshot"): Promise<string> {
    const token = escapeXml(await this.profileToken(camera));
    const body = kind === "Stream"
      ? `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${token}</trt:ProfileToken></trt:GetStreamUri>`
      : `<trt:GetSnapshotUri><trt:ProfileToken>${token}</trt:ProfileToken></trt:GetSnapshotUri>`;
    const op = await this.atService(camera, { ...ACTIONS.profiles, action: `${NS.trt}/Get${kind}Uri`, body }, NS.trt);
    return parseOnvifMediaUri(await this.authenticated(camera, op), kind === "Stream" ? "GetStreamUriResponse" : "GetSnapshotUriResponse");
  }

  /** Live video: the RTSP address the camera gives for its H.264 profile (Media service, GetStreamUri). */
  liveRtspUrl(camera: CameraConfig): Promise<string> {
    return this.mediaUri(camera, "Stream");
  }

  /**
   * The current picture (GetSnapshotUri), fetched from the camera's own address only: the host in
   * the reply is ignored, its port, path and query are used.
   */
  async getSnapshot(camera: CameraConfig) {
    const uri = new URL(await this.mediaUri(camera, "Snapshot"));
    const protocol = uri.protocol === "https:" ? "https" : "http";
    const port = uri.port ? Number(uri.port) : protocol === "https" ? 443 : 80;
    return fetchSnapshot(this.http, { ...camera, protocol, port }, `${uri.pathname}${uri.search}`);
  }

  /** The camera's clock and its local time zone offset (shiftMs: local minus UTC). */
  private async cameraClock(camera: CameraConfig): Promise<{ now: number; shiftMs: number }> {
    let now = Date.now() + this.offsetFor(camera);
    let localOffsetMin = 0;
    try {
      const xml = await this.call(camera, ACTIONS.systemTime);
      now = parseOnvifSystemTime(xml) ?? now;
      localOffsetMin = parseOnvifLocalOffset(xml) ?? 0;
    } catch {
      // the camera's clock is optional here: our clock and UTC are used instead
    }
    return { now, shiftMs: localOffsetMin * 60_000 };
  }

  /**
   * The span the recordings cover (GetRecordingSummary: DataFrom to DataUntil), in the camera's
   * local time, as one period: Profile G's summary does not list gaps. shiftMs turns local times
   * into UTC for playback.
   */
  async recordedSpan(camera: CameraConfig): Promise<RecordingList> {
    const summary = parseOnvifRecordingSummary(await this.authenticated(camera, await this.atService(camera, ACTIONS.summary, NS.tse)));
    const { now, shiftMs } = await this.cameraClock(camera);
    const segments = summary.from === undefined || summary.recordings === 0 ? [] : [{ start: summary.from + shiftMs, end: (summary.until ?? now) + shiftMs }];
    return { segments, nowMs: now + shiftMs, shiftMs };
  }

  /** The recordings on the camera (Search service: FindRecordings, then its results), in UTC. */
  private async findRecordings(camera: CameraConfig): Promise<{ token: string; from: number; until: number }[]> {
    const find = await this.atService(
      camera,
      { ...ACTIONS.summary, action: `${NS.tse}/FindRecordings`, body: "<tse:FindRecordings><tse:Scope/><tse:MaxMatches>100</tse:MaxMatches><tse:KeepAliveTime>PT10S</tse:KeepAliveTime></tse:FindRecordings>" },
      NS.tse,
    );
    const searchToken = escapeXml(parseOnvifSearchToken(await this.authenticated(camera, find)));
    const results = {
      ...find,
      action: `${NS.tse}/GetRecordingSearchResults`,
      body: `<tse:GetRecordingSearchResults><tse:SearchToken>${searchToken}</tse:SearchToken><tse:MaxResults>100</tse:MaxResults><tse:WaitTime>PT2S</tse:WaitTime></tse:GetRecordingSearchResults>`,
    };
    const recordings: { token: string; from: number; until: number }[] = [];
    try {
      for (let i = 0; i < 10; i++) {
        const page = parseOnvifRecordingResults(await this.authenticated(camera, results));
        recordings.push(...page.recordings);
        if (page.done) return recordings;
      }
      return recordings;
    } finally {
      const end = { ...find, action: `${NS.tse}/EndSearch`, body: `<tse:EndSearch><tse:SearchToken>${searchToken}</tse:SearchToken></tse:EndSearch>` };
      await this.authenticated(camera, end).catch(() => undefined);
    }
  }

  /**
   * Recordings for playback (Profile G): each recording on the camera with the period it covers, in
   * the camera's local time. Where the search is not supported, the recording summary's span.
   */
  async listRecordings(camera: CameraConfig): Promise<RecordingList> {
    let found: { token: string; from: number; until: number }[];
    try {
      found = await this.findRecordings(camera);
    } catch (err) {
      if (err instanceof CameraApiError && err.code === "AUTH_FAILED") throw err;
      return this.recordedSpan(camera);
    }
    const { now, shiftMs } = await this.cameraClock(camera);
    const segments = found.map((r) => ({ start: r.from + shiftMs, end: Math.min(r.until, now) + shiftMs, ref: r.token })).sort((a, b) => a.start - b.start);
    return { segments, nowMs: now + shiftMs, shiftMs };
  }

  /** The replay address of the recording holding `segment` (Replay service: GetReplayUri). */
  async replayRtspUrl(camera: CameraConfig, segment?: RecordedSegment): Promise<string> {
    const token = segment?.ref ?? (await this.findRecordings(camera))[0]?.token;
    if (!token) throw new CameraApiError("API_UNAVAILABLE", "The camera has no recordings to play");
    const body =
      `<trp:GetReplayUri><trp:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trp:StreamSetup>` +
      `<trp:RecordingToken>${escapeXml(token)}</trp:RecordingToken></trp:GetReplayUri>`;
    const op = await this.atService(camera, { path: ONVIF_REPLAY_SERVICE_PATH, action: `${NS.trp}/GetReplayUri`, body, auth: true }, NS.trp);
    return parseOnvifMediaUri(await this.authenticated(camera, op), "GetReplayUriResponse");
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}

const cameraKey = (c: CameraConfig) => `${c.protocol}://${c.host}:${c.port}`;
