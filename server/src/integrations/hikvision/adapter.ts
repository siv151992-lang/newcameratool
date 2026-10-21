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
  parseCameraTimeXml,
  parseDeviceInfoXml,
  parseRecordingSearchXml,
  parseRecordingStatusXml,
  parseResponseStatus,
  parseStorageXml,
  recordingSearchXml,
} from "./parser.js";

export const HIKVISION_STORAGE_PATH = "/ISAPI/ContentMgmt/Storage";
export const HIKVISION_DEVICE_INFO_PATH = "/ISAPI/System/deviceInfo";
export const HIKVISION_RECORDING_PATH = "/ISAPI/ContentMgmt/Recording/status";
export const HIKVISION_TIME_PATH = "/ISAPI/System/time";
export const HIKVISION_SEARCH_PATH = "/ISAPI/ContentMgmt/search";
/** Main-stream video track of channel 1. */
const MAIN_TRACK = "101";
/** How far back the recording search looks, and how recent a segment must end to count as live. */
const SEARCH_WINDOW_MS = 10 * 60_000;
const LIVE_WINDOW_MS = 3 * 60_000;

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
      "ISAPI storage status with HTTP Digest authentication. Tested against mocked ISAPI responses " +
      "modelled on real camera output; confirm with Test Connection on your firmware.",
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
   * Uses the recording status endpoint where the firmware has one. Most IP cameras do not, so
   * otherwise the camera's own recordings are searched: footage written in the last few minutes
   * (by the camera's clock) means it is recording.
   */
  async getRecordingStatus(camera: CameraConfig): Promise<RecordingReading> {
    try {
      return parseRecordingStatusXml(await this.getXml(camera, HIKVISION_RECORDING_PATH));
    } catch (err) {
      if (!(err instanceof CameraApiError) || (err.code !== "API_UNAVAILABLE" && err.code !== "INVALID_RESPONSE")) throw err;
    }
    const now = parseCameraTimeXml(await this.getXml(camera, HIKVISION_TIME_PATH));
    const query = recordingSearchXml(randomUUID().toUpperCase(), MAIN_TRACK, now - SEARCH_WINDOW_MS, now + 60_000);
    return parseRecordingSearchXml(await this.getXml(camera, HIKVISION_SEARCH_PATH, query), MAIN_TRACK, now, LIVE_WINDOW_MS);
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
