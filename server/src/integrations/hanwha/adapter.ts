import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { runDiagnostics } from "../diagnostics.js";
import type { BrandMeta, CameraBrandAdapter, CameraConfig, ConnectionResult, DeviceInfo, StorageReading } from "../types.js";
import { parseHanwhaDeviceInfo, parseHanwhaStorage, parseSunapiError } from "./parser.js";

export const HANWHA_STORAGE_PATH = "/stw-cgi/system.cgi?msubmenu=storageinfo&action=view";
export const HANWHA_DEVICE_INFO_PATH = "/stw-cgi/system.cgi?msubmenu=deviceinfo&action=view";

export class HanwhaAdapter implements CameraBrandAdapter {
  readonly meta: BrandMeta = {
    key: "hanwha",
    displayName: "Hanwha Vision (Wisenet)",
    supportStatus: "unverified",
    authMethods: ["digest", "basic (HTTPS only)"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "device-info", "connection-test", "multiple-storage-devices"],
    storageEndpoint: `GET ${HANWHA_STORAGE_PATH}`,
    defaultTimeoutMs: 10000,
    notes:
      "SUNAPI (stw-cgi) with HTTP Digest authentication; key=value and JSON replies are both read. Sizes without a unit " +
      "are read as MB. Recording status is not read. Not yet tested on real hardware; confirm with Test Connection.",
    compatibility: "Wisenet cameras with SUNAPI (stw-cgi). Formerly Samsung Techwin / Hanwha Techwin.",
  };

  constructor(private readonly http: CameraHttpClient) {}

  private async getText(camera: CameraConfig, path: string): Promise<string> {
    return requireOk(await this.http.request(camera, { path, accept: "application/json, text/plain, */*" }), path, parseSunapiError);
  }

  async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    return parseHanwhaStorage(await this.getText(camera, HANWHA_STORAGE_PATH));
  }

  async getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    return parseHanwhaDeviceInfo(await this.getText(camera, HANWHA_DEVICE_INFO_PATH));
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
