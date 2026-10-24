import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { runDiagnostics } from "../diagnostics.js";
import type { BrandMeta, CameraBrandAdapter, CameraConfig, ConnectionResult, DeviceInfo, RecordingReading, StorageReading } from "../types.js";
import { parseDahuaDeviceInfo, parseDahuaError, parseDahuaRecording, parseDahuaStorage } from "./parser.js";
import { fetchSnapshot } from "../snapshot.js";

export const DAHUA_STORAGE_PATH = "/cgi-bin/storageDevice.cgi?action=getDeviceAllInfo";
export const DAHUA_DEVICE_INFO_PATH = "/cgi-bin/magicBox.cgi?action=getSystemInfo";
export const DAHUA_RECORDING_PATH = "/cgi-bin/record.cgi?action=getRecordStatus";

export class DahuaAdapter implements CameraBrandAdapter {
  readonly meta: BrandMeta = {
    key: "dahua",
    displayName: "Dahua (incl. CP Plus, Amcrest)",
    supportStatus: "unverified",
    authMethods: ["digest", "basic (HTTPS only)"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "live-view", "multiple-storage-devices"],
    storageEndpoint: `GET ${DAHUA_STORAGE_PATH}`,
    defaultTimeoutMs: 10000,
    notes:
      "CGI storage device list with HTTP Digest authentication; sizes in bytes, partitions summed per disk. " +
      "Empty drive bays are ignored. Not yet tested on real hardware; confirm with Test Connection.",
  };

  constructor(private readonly http: CameraHttpClient) {}

  /** Live video: the second (sub) stream, which is H.264 on most models. */
  readonly rtspPath = "/cam/realmonitor?channel=1&subtype=1";

  /** The current picture for the live view (Channel 1). */
  getSnapshot(camera: CameraConfig) {
    return fetchSnapshot(this.http, camera, "/cgi-bin/snapshot.cgi?channel=1");
  }

  private async getText(camera: CameraConfig, path: string): Promise<string> {
    return requireOk(await this.http.request(camera, { path, accept: "text/plain, */*" }), path, parseDahuaError);
  }

  async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    return parseDahuaStorage(await this.getText(camera, DAHUA_STORAGE_PATH));
  }

  async getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    return parseDahuaDeviceInfo(await this.getText(camera, DAHUA_DEVICE_INFO_PATH));
  }

  async getRecordingStatus(camera: CameraConfig): Promise<RecordingReading> {
    return parseDahuaRecording(await this.getText(camera, DAHUA_RECORDING_PATH));
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
