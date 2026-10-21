import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { runDiagnostics } from "../diagnostics.js";
import type { BrandMeta, CameraBrandAdapter, CameraConfig, ConnectionResult, DeviceInfo, RecordingReading, StorageReading } from "../types.js";
import { parseHanwhaDeviceInfo, parseHanwhaRecording, parseHanwhaStorage, parseSunapiError } from "./parser.js";

export const HANWHA_STORAGE_PATH = "/stw-cgi/system.cgi?msubmenu=storageinfo&action=view";
export const HANWHA_DEVICE_INFO_PATH = "/stw-cgi/system.cgi?msubmenu=deviceinfo&action=view";
export const HANWHA_RECORDING_SETTINGS_PATH = "/stw-cgi/recording.cgi?msubmenu=storage&action=view";
export const HANWHA_EVENT_STATUS_PATH = "/stw-cgi/eventstatus.cgi?msubmenu=eventstatus&action=check";

export class HanwhaAdapter implements CameraBrandAdapter {
  readonly meta: BrandMeta = {
    key: "hanwha",
    displayName: "Hanwha Vision (Wisenet)",
    supportStatus: "supported",
    authMethods: ["digest", "basic (HTTPS only)"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "multiple-storage-devices"],
    storageEndpoint: `GET ${HANWHA_STORAGE_PATH}`,
    defaultTimeoutMs: 10000,
    notes:
      "SUNAPI (stw-cgi) with HTTP Digest authentication; key=value and JSON replies are both read, sizes in MB. " +
      "Recording status is inferred from the recording settings, storage status and storage events, because the " +
      "camera does not report live recording.",
    compatibility: "Confirmed on QND-7012R. Wisenet cameras with SUNAPI (stw-cgi); formerly Samsung Techwin / Hanwha Techwin.",
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

  async getRecordingStatus(camera: CameraConfig): Promise<RecordingReading> {
    const [storage, settings] = await Promise.all([
      this.getText(camera, HANWHA_STORAGE_PATH),
      this.getText(camera, HANWHA_RECORDING_SETTINGS_PATH),
    ]);
    // Storage events refine the result (card failed, missing or full) but are optional.
    const events = await this.getText(camera, HANWHA_EVENT_STATUS_PATH).catch(() => undefined);
    return parseHanwhaRecording(storage, settings, events);
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
