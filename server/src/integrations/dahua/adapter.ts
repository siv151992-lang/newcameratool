import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { runDiagnostics } from "../diagnostics.js";
import type { BrandMeta, CameraBrandAdapter, CameraConfig, ConnectionResult, DeviceInfo, StorageReading } from "../types.js";
import { parseDahuaDeviceInfo, parseDahuaError, parseDahuaStorage } from "./parser.js";

export const DAHUA_STORAGE_PATH = "/cgi-bin/storageDevice.cgi?action=getDeviceAllInfo";
export const DAHUA_DEVICE_INFO_PATH = "/cgi-bin/magicBox.cgi?action=getSystemInfo";

export class DahuaAdapter implements CameraBrandAdapter {
  readonly meta: BrandMeta = {
    key: "dahua",
    displayName: "Dahua (incl. CP Plus, Amcrest)",
    supportStatus: "unverified",
    authMethods: ["digest", "basic (HTTPS only)"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "device-info", "connection-test", "multiple-storage-devices"],
    storageEndpoint: `GET ${DAHUA_STORAGE_PATH}`,
    defaultTimeoutMs: 10000,
    notes:
      "CGI storage device list with HTTP Digest authentication; sizes in bytes, partitions summed per disk. " +
      "Empty drive bays are ignored. Not yet tested on real hardware; confirm with Test Connection.",
  };

  constructor(private readonly http: CameraHttpClient) {}

  private async getText(camera: CameraConfig, path: string): Promise<string> {
    return requireOk(await this.http.request(camera, { path, accept: "text/plain, */*" }), path, parseDahuaError);
  }

  async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    return parseDahuaStorage(await this.getText(camera, DAHUA_STORAGE_PATH));
  }

  async getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    return parseDahuaDeviceInfo(await this.getText(camera, DAHUA_DEVICE_INFO_PATH));
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
