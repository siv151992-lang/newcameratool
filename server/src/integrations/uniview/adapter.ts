import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { runDiagnostics } from "../diagnostics.js";
import { CameraApiError, type BrandMeta, type CameraBrandAdapter, type CameraConfig, type ConnectionResult, type DeviceInfo, type NvrChannel, type RecordedSegment, type RecordingRange, type RecordingReading, type StorageReading } from "../types.js";
import { OnvifAdapter } from "../onvif/adapter.js";
import { parseUniviewChannels, parseUniviewContainers, parseUniviewDeviceInfo, parseUniviewError, parseUniviewRecording, parseUniviewStorage } from "./parser.js";
import { fetchSnapshot } from "../snapshot.js";

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
    capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "live-view", "playback", "multiple-storage-devices"],
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

  /** Live video: the second (sub) stream, which is H.264 on most models. */
  readonly rtspPath = "/media/video2";
  /** The main stream, or the path of other firmware. */
  readonly rtspFallbacks = ["/media/video1", "/unicast/c1/s1/live"];

  /** The current picture for the live view (LAPI, channel 0 main stream). */
  getSnapshot(camera: CameraConfig, channel = 1) {
    return fetchSnapshot(this.http, camera, `/LAPI/V1.0/Channels/${channel > 1 ? channel : 0}/Media/Video/Streams/0/Snapshot`);
  }

  /** NVR channel N: sub stream, then main stream. */
  channelRtspPaths(channel: number) {
    return [`/unicast/c${channel}/s1/live`, `/unicast/c${channel}/s0/live`];
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

  /** NVR channels (LAPI Channels/System/BasicInfos): names and whether each camera is online. */
  async getChannels(camera: CameraConfig): Promise<NvrChannel[]> {
    return parseUniviewChannels(await this.getJson(camera, "/LAPI/V1.0/Channels/System/BasicInfos"));
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

  /** The span the recordings cover, over ONVIF (Profile G); gaps are not listed. */
  listRecordings(camera: CameraConfig) {
    return this.onvif.recordedSpan(camera);
  }

  /** Replay of channel 1 from a UTC time (Unix seconds), to 12 hours later. */
  playbackRtspPath(startMs: number, _segment?: RecordedSegment, channel = 1): string {
    const b = Math.floor(startMs / 1000);
    return `/c${channel}/b${b}/e${b + 12 * 3600}/replay/`;
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
