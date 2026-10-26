import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { runDiagnostics } from "../diagnostics.js";
import { CameraApiError, type BrandMeta, type CameraBrandAdapter, type CameraConfig, type ConnectionResult, type DeviceInfo, type RecordedSegment, type RecordingList, type RecordingReading, type StorageReading } from "../types.js";
import { parseAxisDeviceInfo, parseAxisError, parseAxisRecording, parseAxisRecordings, parseAxisStorage } from "./parser.js";
import { fetchSnapshot } from "../snapshot.js";

export const AXIS_STORAGE_PATH = "/axis-cgi/param.cgi?action=list&group=root.Storage";
export const AXIS_DEVICE_INFO_PATH = "/axis-cgi/param.cgi?action=list&group=root.Brand,root.Properties";

export class AxisAdapter implements CameraBrandAdapter {
  readonly meta: BrandMeta = {
    key: "axis",
    displayName: "Axis",
    supportStatus: "unverified",
    authMethods: ["digest", "basic (HTTPS only)"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "live-view", "playback", "multiple-storage-devices"],
    storageEndpoint: `GET ${AXIS_STORAGE_PATH}`,
    defaultTimeoutMs: 10000,
    notes:
      "VAPIX parameter list with HTTP Digest authentication. Sizes are read as MiB. Many models only report " +
      "total size, in which case usage cannot be shown. Not yet tested on real hardware; confirm with Test Connection.",
  };

  constructor(private readonly http: CameraHttpClient) {}

  /** Live video: the second (sub) stream, which is H.264 on most models. */
  readonly rtspPath = "/axis-media/media.amp?videocodec=h264";
  /** The default codec when H.264 is not offered. */
  readonly rtspFallbacks = ["/axis-media/media.amp"];

  /** The current picture for the live view (VAPIX JPEG image). */
  getSnapshot(camera: CameraConfig) {
    return fetchSnapshot(this.http, camera, "/axis-cgi/jpg/image.cgi");
  }

  private async getText(camera: CameraConfig, path: string): Promise<string> {
    return requireOk(await this.http.request(camera, { path, accept: "text/plain, */*" }), path, parseAxisError);
  }

  async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    return parseAxisStorage(await this.getText(camera, AXIS_STORAGE_PATH));
  }

  async getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    return parseAxisDeviceInfo(await this.getText(camera, AXIS_DEVICE_INFO_PATH));
  }

  async getRecordingStatus(camera: CameraConfig): Promise<RecordingReading> {
    return parseAxisRecording(await this.getText(camera, AXIS_STORAGE_PATH));
  }

  /**
   * Recordings on the camera's storage (record/list.cgi). Searched over a UTC period wide enough
   * for any time zone, then kept to the requested local period. Axis plays a recording by its id,
   * from its start.
   */
  async listRecordings(camera: CameraConfig, fromMs: number, toMs: number): Promise<RecordingList> {
    const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
    const nowUtc = Date.now();
    const xml = await this.getText(camera, `/axis-cgi/record/list.cgi?recordingid=all&starttime=${iso(fromMs - 14 * 3_600_000)}&stoptime=${iso(toMs + 14 * 3_600_000)}`);
    const { segments, offsetMs } = parseAxisRecordings(xml, nowUtc);
    return { segments: segments.filter((s) => s.end > fromMs && s.start < toMs).sort((a, b) => a.start - b.start), nowMs: nowUtc + offsetMs, shiftMs: offsetMs, playsFromRecordingStart: true };
  }

  /** The chosen recording, from its start. */
  playbackRtspPath(_startMs: number, segment?: RecordedSegment): string {
    if (!segment?.ref) throw new CameraApiError("API_UNAVAILABLE", "No recording at that time");
    return `/axis-media/media.amp?recordingid=${encodeURIComponent(segment.ref)}`;
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
