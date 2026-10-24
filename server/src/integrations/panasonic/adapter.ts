import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { runDiagnostics } from "../diagnostics.js";
import type { BrandMeta, CameraBrandAdapter, CameraConfig, ConnectionResult, DeviceInfo, RecordingReading, StorageReading } from "../types.js";
import { parsePanasonicDeviceInfo, parsePanasonicRecording, parsePanasonicStorage } from "./parser.js";
import { fetchSnapshot } from "../snapshot.js";

export const PANASONIC_SDCARD_PATH = "/admin/setup_sdcard.html?Language=0";
export const PANASONIC_INFO_PATH = "/cgi-bin/getinfo?FILE=1";

export class PanasonicAdapter implements CameraBrandAdapter {
  readonly meta: BrandMeta = {
    key: "panasonic",
    displayName: "Panasonic / i-PRO",
    supportStatus: "supported",
    authMethods: ["digest", "basic (HTTPS only)"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "live-view", "multiple-storage-devices"],
    storageEndpoint: `GET ${PANASONIC_SDCARD_PATH}`,
    defaultTimeoutMs: 10000,
    notes:
      "SD card capacity is read from the camera's SD memory card setup page (values in MB), so the camera user needs " +
      "administrator rights. Model, serial, firmware and SD recording (SDrec) come from /cgi-bin/getinfo?FILE=1.",
    compatibility: "Confirmed on WV-S35402-F2L (firmware 3.50). i-PRO / Panasonic cameras with the same web interface.",
  };

  constructor(private readonly http: CameraHttpClient) {}

  /** Live video: the second (sub) stream, which is H.264 on most models. */
  readonly rtspPath = "/MediaInput/h264/stream_2";

  /** The current picture for the live view (JPEG at 1280 wide). */
  getSnapshot(camera: CameraConfig) {
    return fetchSnapshot(this.http, camera, "/cgi-bin/camera?resolution=1280");
  }

  private async getText(camera: CameraConfig, path: string): Promise<string> {
    return requireOk(await this.http.request(camera, { path, accept: "text/html, text/plain, */*" }), path);
  }

  async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    return parsePanasonicStorage(await this.getText(camera, PANASONIC_SDCARD_PATH));
  }

  async getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    return parsePanasonicDeviceInfo(await this.getText(camera, PANASONIC_INFO_PATH));
  }

  async getRecordingStatus(camera: CameraConfig): Promise<RecordingReading> {
    return parsePanasonicRecording(await this.getText(camera, PANASONIC_INFO_PATH));
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
