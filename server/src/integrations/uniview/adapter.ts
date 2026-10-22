import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { runDiagnostics } from "../diagnostics.js";
import { CameraApiError, type BrandMeta, type CameraBrandAdapter, type CameraConfig, type ConnectionResult, type DeviceInfo, type RecordingRange, type RecordingReading, type StorageReading } from "../types.js";
import { OnvifAdapter } from "../onvif/adapter.js";
import { parseUniviewContainers, parseUniviewDeviceInfo, parseUniviewError, parseUniviewRecording, parseUniviewStorage } from "./parser.js";

/** Storage on current firmware (confirmed on IPC815SB-ADF14K-I0); older firmware uses Storage/Disks. */
export const UNIVIEW_STORAGE_PATH = "/LAPI/V1.0/Storage/Containers/DetailInfos";
export const UNIVIEW_LEGACY_STORAGE_PATH = "/LAPI/V1.0/Storage/Disks";
export const UNIVIEW_DEVICE_INFO_PATH = "/LAPI/V1.0/System/DeviceInfo";
export const UNIVIEW_RECORDING_PATH = "/LAPI/V1.0/Storage/Status";

export class UniviewAdapter implements CameraBrandAdapter {
  readonly meta: BrandMeta = {
    key: "uniview",
    displayName: "Uniview",
    supportStatus: "unverified",
    authMethods: ["digest", "basic (HTTPS only)"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "multiple-storage-devices"],
    storageEndpoint: `GET ${UNIVIEW_STORAGE_PATH}`,
    defaultTimeoutMs: 10000,
    notes:
      "LAPI JSON with HTTP Digest authentication; capacities in MiB. Storage from Storage/Containers/DetailInfos " +
      "(Storage/Disks on older firmware). Recording status from Storage/Status, or over ONVIF (GetRecordingJobs) " +
      "on models without it; days of recordings from ONVIF GetRecordingSummary. ONVIF must be on in the camera.",
    compatibility: "Storage confirmed on IPC815SB-ADF14K-I0 (firmware GIPC-B6203.15.6.241115).",
  };

  /** LAPI has no recording status or recording search on some models (IPC815SB-ADF14K-I0); ONVIF does. */
  private readonly onvif: OnvifAdapter;

  constructor(private readonly http: CameraHttpClient) {
    this.onvif = new OnvifAdapter(http);
  }

  private async getJson(camera: CameraConfig, path: string): Promise<string> {
    return requireOk(await this.http.request(camera, { path, accept: "application/json, */*" }), path, parseUniviewError);
  }

  async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    try {
      return parseUniviewContainers(await this.getJson(camera, UNIVIEW_STORAGE_PATH));
    } catch (err) {
      if (!(err instanceof CameraApiError) || err.code !== "API_UNAVAILABLE") throw err;
    }
    return parseUniviewStorage(await this.getJson(camera, UNIVIEW_LEGACY_STORAGE_PATH));
  }

  async getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    return parseUniviewDeviceInfo(await this.getJson(camera, UNIVIEW_DEVICE_INFO_PATH));
  }

  async getRecordingStatus(camera: CameraConfig): Promise<RecordingReading> {
    try {
      return parseUniviewRecording(await this.getJson(camera, UNIVIEW_RECORDING_PATH));
    } catch (err) {
      if (!(err instanceof CameraApiError) || err.code !== "API_UNAVAILABLE") throw err;
    }
    const viaOnvif = await this.onvif.getRecordingStatus(camera);
    return { ...viaOnvif, detail: `${viaOnvif.detail ? `${viaOnvif.detail}; ` : ""}read over ONVIF` };
  }

  getRecordingRange(camera: CameraConfig): Promise<RecordingRange | null> {
    return this.onvif.getRecordingRange(camera);
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
