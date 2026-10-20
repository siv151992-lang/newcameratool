import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { runDiagnostics } from "../diagnostics.js";
import type { BrandMeta, CameraBrandAdapter, CameraConfig, ConnectionResult, DeviceInfo, StorageReading } from "../types.js";
import { parseAxisDeviceInfo, parseAxisError, parseAxisStorage } from "./parser.js";

export const AXIS_STORAGE_PATH = "/axis-cgi/param.cgi?action=list&group=root.Storage";
export const AXIS_DEVICE_INFO_PATH = "/axis-cgi/param.cgi?action=list&group=root.Brand,root.Properties";

export class AxisAdapter implements CameraBrandAdapter {
  readonly meta: BrandMeta = {
    key: "axis",
    displayName: "Axis",
    supportStatus: "unverified",
    authMethods: ["digest", "basic (HTTPS only)"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "device-info", "connection-test", "multiple-storage-devices"],
    storageEndpoint: `GET ${AXIS_STORAGE_PATH}`,
    defaultTimeoutMs: 10000,
    notes:
      "VAPIX parameter list with HTTP Digest authentication. Sizes are read as MiB. Many models only report " +
      "total size, in which case usage cannot be shown. Not yet tested on real hardware; confirm with Test Connection.",
  };

  constructor(private readonly http: CameraHttpClient) {}

  private async getText(camera: CameraConfig, path: string): Promise<string> {
    return requireOk(await this.http.request(camera, { path, accept: "text/plain, */*" }), path, parseAxisError);
  }

  async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    return parseAxisStorage(await this.getText(camera, AXIS_STORAGE_PATH));
  }

  async getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    return parseAxisDeviceInfo(await this.getText(camera, AXIS_DEVICE_INFO_PATH));
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
