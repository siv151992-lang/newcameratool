import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { runDiagnostics } from "../diagnostics.js";
import { CameraApiError, mergeSegments, type BrandMeta, type CameraBrandAdapter, type CameraConfig, type ConnectionResult, type DeviceInfo, type RecordedSegment, type RecordingList, type RecordingReading, type StorageReading } from "../types.js";
import { dahuaTime, dahuaTimeMs, parseDahuaDeviceInfo, parseDahuaError, parseDahuaFiles, parseDahuaRecording, parseDahuaStorage } from "./parser.js";
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
    capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "live-view", "playback", "multiple-storage-devices"],
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

  /**
   * Recordings of channel 1 between two local times: mediaFileFind (create, findFile, then
   * findNextFile until the files run out; closed and destroyed afterwards). Dahua uses local time throughout.
   */
  async listRecordings(camera: CameraConfig, fromMs: number, toMs: number): Promise<RecordingList> {
    const finder = "/cgi-bin/mediaFileFind.cgi";
    const now = await this.getText(camera, "/cgi-bin/global.cgi?action=getCurrentTime").then((t) => dahuaTimeMs(t), () => undefined);
    const id = /result=(\d+)/.exec(await this.getText(camera, `${finder}?action=factory.create`))?.[1];
    if (!id) throw new CameraApiError("INVALID_RESPONSE", "The camera did not open a recording search");
    const found: RecordedSegment[] = [];
    try {
      await this.getText(
        camera,
        `${finder}?action=findFile&object=${id}&condition.Channel=1&condition.StartTime=${encodeURIComponent(dahuaTime(fromMs))}&condition.EndTime=${encodeURIComponent(dahuaTime(toMs))}&condition.Types[0]=dav`,
      ).catch((err: unknown) => {
        // "Error" here means no files in the period on many models.
        if (!(err instanceof CameraApiError) || err.code !== "API_ERROR") throw err;
      });
      for (let page = 0; page < 30; page++) {
        const { found: n, segments } = parseDahuaFiles(await this.getText(camera, `${finder}?action=findNextFile&object=${id}&count=100`).catch(() => "found=0"));
        found.push(...segments);
        if (n < 100) break;
      }
    } finally {
      await this.getText(camera, `${finder}?action=close&object=${id}`).catch(() => undefined);
      await this.getText(camera, `${finder}?action=destroy&object=${id}`).catch(() => undefined);
    }
    return { segments: mergeSegments(found), nowMs: now ?? Date.now(), shiftMs: 0 };
  }

  /** Channel 1 main stream from a local time (to 12 hours later; it stops at the end of the recordings). */
  playbackRtspPath(startMs: number): string {
    return `/cam/playback?channel=1&subtype=0&starttime=${dahuaTime(startMs, "_")}&endtime=${dahuaTime(startMs + 12 * 3_600_000, "_")}`;
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
