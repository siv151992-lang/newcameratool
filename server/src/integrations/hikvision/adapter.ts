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
import { parseDeviceInfoXml, parseRecordingStatusXml, parseResponseStatus, parseStorageXml } from "./parser.js";

export const HIKVISION_STORAGE_PATH = "/ISAPI/ContentMgmt/Storage";
export const HIKVISION_DEVICE_INFO_PATH = "/ISAPI/System/deviceInfo";
export const HIKVISION_RECORDING_PATH = "/ISAPI/ContentMgmt/Recording/status";

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

  private async getXml(camera: CameraConfig, path: string): Promise<string> {
    const res = await this.http.get(camera, path);
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

  async getRecordingStatus(camera: CameraConfig): Promise<RecordingReading> {
    return parseRecordingStatusXml(await this.getXml(camera, HIKVISION_RECORDING_PATH));
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
