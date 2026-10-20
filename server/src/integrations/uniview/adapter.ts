import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { runDiagnostics } from "../diagnostics.js";
import type { BrandMeta, CameraBrandAdapter, CameraConfig, ConnectionResult, DeviceInfo, StorageReading } from "../types.js";
import { parseUniviewDeviceInfo, parseUniviewError, parseUniviewStorage } from "./parser.js";

export const UNIVIEW_STORAGE_PATH = "/LAPI/V1.0/Storage/Disks";
export const UNIVIEW_DEVICE_INFO_PATH = "/LAPI/V1.0/System/DeviceInfo";

export class UniviewAdapter implements CameraBrandAdapter {
  readonly meta: BrandMeta = {
    key: "uniview",
    displayName: "Uniview",
    supportStatus: "unverified",
    authMethods: ["digest", "basic (HTTPS only)"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "device-info", "connection-test", "multiple-storage-devices"],
    storageEndpoint: `GET ${UNIVIEW_STORAGE_PATH}`,
    defaultTimeoutMs: 10000,
    notes:
      "LAPI JSON with HTTP Digest authentication; capacities read as MiB. The storage endpoint path still " +
      "needs confirming on real hardware; use Test Connection to check your firmware.",
  };

  constructor(private readonly http: CameraHttpClient) {}

  private async getJson(camera: CameraConfig, path: string): Promise<string> {
    return requireOk(await this.http.request(camera, { path, accept: "application/json, */*" }), path, parseUniviewError);
  }

  async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    return parseUniviewStorage(await this.getJson(camera, UNIVIEW_STORAGE_PATH));
  }

  async getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    return parseUniviewDeviceInfo(await this.getJson(camera, UNIVIEW_DEVICE_INFO_PATH));
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
