import { randomUUID } from "node:crypto";
import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { runDiagnostics } from "../diagnostics.js";
import {
  CameraApiError,
  type BrandMeta,
  type CameraBrandAdapter,
  type CameraConfig,
  type ConnectionResult,
  type DeviceInfo,
  type RecordingReading,
  type StorageReading,
} from "../types.js";
import {
  parseCameraTime,
  parseDeviceInfoXml,
  parseRecordingStatusXml,
  parseResponseStatus,
  parseSearchLatestEnd,
  parseStorageXml,
  parseTrackSchedule,
  RECORDING_RECENT_MINUTES,
  recordingFromSegments,
  searchRequestXml,
  type TrackSchedule,
} from "./parser.js";

export const HIKVISION_STORAGE_PATH = "/ISAPI/ContentMgmt/Storage";
export const HIKVISION_DEVICE_INFO_PATH = "/ISAPI/System/deviceInfo";
export const HIKVISION_RECORDING_PATH = "/ISAPI/ContentMgmt/Recording/status";
export const HIKVISION_TIME_PATH = "/ISAPI/System/time";
export const HIKVISION_SEARCH_PATH = "/ISAPI/ContentMgmt/search";
export const HIKVISION_TRACK_PATH = "/ISAPI/ContentMgmt/record/tracks/101";

/** Recordings are searched from this long before the camera's time now (a few minutes after, too). */
const SEARCH_WINDOW_MINUTES = 30;

export class HikvisionAdapter implements CameraBrandAdapter {
  readonly meta: BrandMeta = {
    key: "hikvision",
    displayName: "Hikvision",
    supportStatus: "supported",
    authMethods: ["digest", "basic (HTTPS only)"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "multiple-storage-devices", "nas"],
    storageEndpoint: `GET ${HIKVISION_STORAGE_PATH}`,
    defaultTimeoutMs: 10000,
    notes:
      "ISAPI storage status with HTTP Digest authentication. Recording comes from Recording/status where the " +
      "camera has it; otherwise from the newest recording on its storage (ContentMgmt/search), compared with " +
      "the camera's own clock, so it is shown as recording when a recording ended within the last 10 minutes.",
    compatibility: "Recording search confirmed on DS-2CD3563G2-IS.",
  };

  constructor(private readonly http: CameraHttpClient) {}

  private async getXml(camera: CameraConfig, path: string, body?: string): Promise<string> {
    const res = body === undefined
      ? await this.http.get(camera, path)
      : await this.http.request(camera, { method: "POST", path, body, contentType: "application/xml" });
    if (res.status >= 200 && res.status < 300) return res.body;
    // ISAPI usually explains failures in a <ResponseStatus> body.
    const described = parseResponseStatus(res.body);
    const notFound = res.status === 404 || res.status === 405 || res.status === 501;
    if (described) {
      throw new CameraApiError(notFound ? "API_UNAVAILABLE" : described.code, described.message, {
        httpStatus: res.status,
        transient: res.status >= 500,
      });
    }
    if (notFound) {
      throw new CameraApiError("API_UNAVAILABLE", `The camera does not provide ${path} (HTTP ${res.status})`, { httpStatus: res.status });
    }
    throw new CameraApiError("API_ERROR", `Camera returned HTTP ${res.status} for ${path}`, {
      httpStatus: res.status,
      transient: res.status >= 500,
    });
  }

  async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    return parseStorageXml(await this.getXml(camera, HIKVISION_STORAGE_PATH));
  }

  async getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    return parseDeviceInfoXml(await this.getXml(camera, HIKVISION_DEVICE_INFO_PATH));
  }

  /**
   * Live status from Recording/status when the camera provides it; otherwise (many IP cameras
   * answer it with 404) inferred from the newest recorded segment on the camera's storage.
   */
  async getRecordingStatus(camera: CameraConfig): Promise<RecordingReading> {
    try {
      const live = parseRecordingStatusXml(await this.getXml(camera, HIKVISION_RECORDING_PATH));
      if (live.state !== "unknown") return live;
    } catch (err) {
      if (!(err instanceof CameraApiError) || !["API_UNAVAILABLE", "INVALID_RESPONSE"].includes(err.code)) throw err;
    }
    return this.recordingFromSearch(camera);
  }

  private async recordingFromSearch(camera: CameraConfig): Promise<RecordingReading> {
    const { nowMs, offsetMinutes } = parseCameraTime(await this.getXml(camera, HIKVISION_TIME_PATH));
    const latestAround = async (now: number) =>
      parseSearchLatestEnd(
        await this.getXml(camera, HIKVISION_SEARCH_PATH, searchRequestXml(now - SEARCH_WINDOW_MINUTES * 60_000, now + 5 * 60_000, randomUUID().toUpperCase())),
      );
    let now = nowMs;
    let latest = await latestAround(now);
    // Search times are normally local time; some firmware uses real UTC. Try that before concluding.
    if (latest === undefined && offsetMinutes) {
      const utcNow = nowMs - offsetMinutes * 60_000;
      const utcLatest = await latestAround(utcNow);
      if (utcLatest !== undefined) [now, latest] = [utcNow, utcLatest];
    }
    // Only needed to explain a camera that is not recording.
    let schedule: TrackSchedule | undefined;
    if (latest === undefined || now - latest > RECORDING_RECENT_MINUTES * 60_000) {
      schedule = await this.getXml(camera, HIKVISION_TRACK_PATH).then(parseTrackSchedule, () => undefined);
    }
    return recordingFromSegments(now, latest, schedule);
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
