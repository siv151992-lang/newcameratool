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
  type RecordingRange,
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
} from "./parser.js";
import { NS, soapEnvelope } from "./soap.js";

export const ONVIF_DEVICE_SERVICE_PATH = "/onvif/device_service";
export const ONVIF_RECORDING_SERVICE_PATH = "/onvif/recording_service";
export const ONVIF_SEARCH_SERVICE_PATH = "/onvif/search_service";

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
    capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "multiple-storage-devices"],
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

  constructor(private readonly http: CameraHttpClient) {}

  private async call(camera: CameraConfig, op: SoapAction, now = Date.now() + this.offsetFor(camera)): Promise<string> {
    const body = soapEnvelope(op.body, op.auth ? { username: camera.username, password: camera.password, now } : undefined);
    const res = await this.http.request(camera, {
      method: "POST",
      path: op.path,
      body,
      contentType: `application/soap+xml; charset=utf-8; action="${op.action}"`,
      accept: "application/soap+xml, text/xml, */*",
    });
    return requireOk(res, op.path, parseOnvifFault);
  }

  /** Calls an authenticated action, retrying once with the camera's clock if the token was rejected. */
  private async authenticated(camera: CameraConfig, op: SoapAction): Promise<string> {
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
    let now = Date.now() + this.offsetFor(camera);
    let localOffsetMin = 0;
    try {
      const xml = await this.call(camera, ACTIONS.systemTime);
      now = parseOnvifSystemTime(xml) ?? now;
      localOffsetMin = parseOnvifLocalOffset(xml) ?? 0;
    } catch {
      // the camera's clock is optional here: our clock and UTC are used instead
    }
    const days = Math.max(0, Math.round(((now - summary.from) / 86_400_000) * 100) / 100);
    return { oldest: new Date(summary.from + localOffsetMin * 60_000).toISOString().slice(0, 19), days };
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}

const cameraKey = (c: CameraConfig) => `${c.protocol}://${c.host}:${c.port}`;
