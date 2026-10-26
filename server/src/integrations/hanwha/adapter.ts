import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { runDiagnostics } from "../diagnostics.js";
import { mergeSegments, type BrandMeta, type CameraBrandAdapter, type CameraConfig, type ConnectionResult, type DeviceInfo, type NvrChannel, type RecordedSegment, type RecordingList, type RecordingReading, type StorageReading } from "../types.js";
import { parseHanwhaDeviceInfo, parseHanwhaRecording, parseHanwhaStorage, parseSunapiChannels, parseSunapiError, parseSunapiTimeline, parseSunapiUtcOffset } from "./parser.js";
import { fetchSnapshot } from "../snapshot.js";

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
    capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "live-view", "playback", "multiple-storage-devices"],
    storageEndpoint: `GET ${HANWHA_STORAGE_PATH}`,
    defaultTimeoutMs: 10000,
    notes:
      "SUNAPI (stw-cgi) with HTTP Digest authentication; key=value and JSON replies are both read, sizes in MB. " +
      "Recording status is inferred from the recording settings, storage status and storage events, because the " +
      "camera does not report live recording.",
    compatibility: "Confirmed on QND-7012R. Wisenet cameras with SUNAPI (stw-cgi); formerly Samsung Techwin / Hanwha Techwin.",
  };

  constructor(private readonly http: CameraHttpClient) {}

  /** Live video: the second (sub) stream, which is H.264 on most models. */
  readonly rtspPath = "/profile2/media.smp";
  /** The first profile, or the channel-prefixed path of multi-channel models. */
  readonly rtspFallbacks = ["/profile1/media.smp", "/0/profile2/media.smp"];

  /** The current picture for the live view (SUNAPI snapshot). */
  getSnapshot(camera: CameraConfig, channel = 1) {
    return fetchSnapshot(this.http, camera, `/stw-cgi/video.cgi?msubmenu=snapshot&action=view${channel > 1 ? `&Channel=${channel - 1}` : ""}`);
  }

  /** NVR channel N (SUNAPI counts from 0): its second profile, then the first. */
  channelRtspPaths(channel: number) {
    return [`/${channel - 1}/profile2/media.smp`, `/${channel - 1}/profile1/media.smp`];
  }

  private async getText(camera: CameraConfig, path: string): Promise<string> {
    return requireOk(await this.http.request(camera, { path, accept: "application/json, text/plain, */*" }), path, parseSunapiError);
  }

  /**
   * Recordings between two local times from the SUNAPI timeline (channel 0), which works in UTC:
   * the camera's offset (system date) turns local times into UTC and back (shiftMs).
   */
  async listRecordings(camera: CameraConfig, fromMs: number, toMs: number, channel = 1): Promise<RecordingList> {
    const shiftMs = await this.getText(camera, "/stw-cgi/system.cgi?msubmenu=date&action=view").then(parseSunapiUtcOffset, () => 0);
    const iso = (ms: number) => `${new Date(ms - shiftMs).toISOString().slice(0, 19)}Z`;
    const body = await this.getText(
      camera,
      `/stw-cgi/recording.cgi?msubmenu=timeline&action=view&ChannelIDList=${channel - 1}&Type=All&FromDate=${encodeURIComponent(iso(fromMs))}&ToDate=${encodeURIComponent(iso(toMs))}`,
    );
    const segments = parseSunapiTimeline(body).map((p) => ({ start: p.start + shiftMs, end: p.end + shiftMs }));
    return { segments: mergeSegments(segments), nowMs: Date.now() + shiftMs, shiftMs };
  }

  /** Playback from a UTC time (YYYYMMDDhhmmss, to 12 hours later), main profile. */
  playbackRtspPath(startMs: number, _segment?: RecordedSegment, channel = 1): string {
    const c = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace(/[-T:]/g, "");
    return `${channel > 1 ? `/${channel - 1}` : ""}/recording/${c(startMs)}-${c(startMs + 12 * 3_600_000)}/play.smp`;
  }

  /** NVR channels: video loss and recording per channel, from the event status. */
  async getChannels(camera: CameraConfig): Promise<NvrChannel[]> {
    return parseSunapiChannels(await this.getText(camera, HANWHA_EVENT_STATUS_PATH));
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
