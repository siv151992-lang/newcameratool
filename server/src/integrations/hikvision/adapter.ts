import { randomUUID } from "node:crypto";
import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { runDiagnostics } from "../diagnostics.js";
import { redirectError } from "../http/responses.js";
import {
  CameraApiError,
  type BrandMeta,
  type CameraBrandAdapter,
  type CameraConfig,
  type ConnectionResult,
  type DeviceInfo,
  type NvrChannel,
  type RecordingRange,
  type RecordingReading,
  type StorageReading,
  mergeSegments,
  type RecordedSegment,
  type RecordingList,
} from "../types.js";
import {
  parseCameraTime,
  parseDeviceInfoXml,
  parseHikvisionChannels,
  parseRecordingStatusXml,
  parseResponseStatus,
  parseSearchLatestEnd,
  parseSearchOldestStart,
  parseStorageXml,
  parseTrackSchedule,
  RECORDING_RECENT_MINUTES,
  recordingFromSegments,
  parseSearchSegments,
  searchRequestXml,
  toLocalWallClock,
  type TrackSchedule,
  wallClockText,
} from "./parser.js";
import { fetchSnapshot } from "../snapshot.js";

export const HIKVISION_STORAGE_PATH = "/ISAPI/ContentMgmt/Storage";
export const HIKVISION_DEVICE_INFO_PATH = "/ISAPI/System/deviceInfo";
export const HIKVISION_RECORDING_PATH = "/ISAPI/ContentMgmt/Recording/status";
export const HIKVISION_TIME_PATH = "/ISAPI/System/time";
export const HIKVISION_SEARCH_PATH = "/ISAPI/ContentMgmt/search";
export const HIKVISION_TRACK_PATH = "/ISAPI/ContentMgmt/record/tracks/101";

/** Recordings are searched from this long before the camera's time now (a few minutes after, too). */
const SEARCH_WINDOW_MINUTES = 30;
/**
 * How far back the search for the oldest recording looks (a large card at a low bitrate holds
 * months). A camera that rejects or times out on a long search is asked again over a shorter one.
 */
const RANGE_LOOKBACK_DAYS = [400, 90, 30];
/** A camera without Recording/status is not asked again for this long (saves two requests a check). */
const NO_STATUS_TTL_MS = 6 * 3600_000;

/** The playback period in the address: from the start, 12 hours on (both are needed by some firmware). */
const playbackTimes = (startMs: number) => {
  const t = (ms: number) => `${wallClockText(ms).replace(/[-:]/g, "")}Z`;
  return `starttime=${t(startMs)}&endtime=${t(startMs + 12 * 3_600_000)}`;
};

export class HikvisionAdapter implements CameraBrandAdapter {
  readonly meta: BrandMeta = {
    key: "hikvision",
    displayName: "Hikvision",
    supportStatus: "supported",
    authMethods: ["digest", "basic (HTTPS only)"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "live-view", "playback", "multiple-storage-devices", "nas"],
    storageEndpoint: `GET ${HIKVISION_STORAGE_PATH}`,
    defaultTimeoutMs: 10000,
    notes:
      "ISAPI storage status with HTTP Digest authentication. Recording comes from Recording/status where the " +
      "camera has it; otherwise from the newest recording on its storage (ContentMgmt/search), compared with " +
      "the camera's own clock, so it is shown as recording when a recording ended within the last 10 minutes.",
    compatibility: "Recording search confirmed on DS-2CD3563G2-IS.",
  };

  /** host:port of cameras known to lack Recording/status, with when to try it again. */
  private readonly noStatusApi = new Map<string, number>();

  constructor(private readonly http: CameraHttpClient) {}

  /** Live video: the second (sub) stream, which is H.264 on most models. */
  readonly rtspPath = "/Streaming/Channels/102";
  /** The main stream when the sub stream is off. */
  readonly rtspFallbacks = ["/Streaming/Channels/101", "/ISAPI/Streaming/channels/102"];

  /** The current picture for the live view (Main stream of channel 1). */
  getSnapshot(camera: CameraConfig, channel = 1) {
    return fetchSnapshot(this.http, camera, this.apiPath(camera, `/ISAPI/Streaming/channels/${channel}01/picture`));
  }

  /** NVR channel N: stream N02 (sub), then N01 (main). */
  channelRtspPaths(channel: number) {
    return [`/Streaming/Channels/${channel}02`, `/Streaming/Channels/${channel}01`];
  }

  /** The address of an ISAPI path on this camera (Prama firmware names the API /pramaAPI). */
  protected apiPath(_camera: CameraConfig, path: string): string {
    return path;
  }

  private async getXml(camera: CameraConfig, isapiPath: string, body?: string): Promise<string> {
    const path = this.apiPath(camera, isapiPath);
    const res = body === undefined
      ? await this.http.get(camera, path)
      : await this.http.request(camera, { method: "POST", path, body, contentType: "application/xml" });
    if (res.status >= 200 && res.status < 300) return res.body;
    // ISAPI usually explains failures in a <ResponseStatus> body.
    const described = parseResponseStatus(res.body);
    const notFound = res.status === 404 || res.status === 405 || res.status === 501;
    if (described) {
      throw new CameraApiError(notFound ? "API_UNAVAILABLE" : described.code, described.message, {
        httpStatus: res.status,
        transient: res.status >= 500,
      });
    }
    if (notFound) {
      throw new CameraApiError("API_UNAVAILABLE", `The camera does not provide ${path} (HTTP ${res.status})`, { httpStatus: res.status });
    }
    if (res.status >= 300 && res.status < 400) throw redirectError(res, path);
    throw new CameraApiError("API_ERROR", `Camera returned HTTP ${res.status} for ${path}`, {
      httpStatus: res.status,
      transient: res.status >= 500,
    });
  }

  async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    return parseStorageXml(await this.getXml(camera, HIKVISION_STORAGE_PATH));
  }

  async getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    return parseDeviceInfoXml(await this.getXml(camera, HIKVISION_DEVICE_INFO_PATH));
  }

  /**
   * Live status from Recording/status when the camera provides it; otherwise (many IP cameras
   * answer it with 404) inferred from the newest recorded segment on the camera's storage.
   */
  /**
   * NVR channels: the IP cameras added to the NVR (InputProxy), whether each has video, and
   * whether it is recording (Recording/status tracks). An IP camera has no InputProxy (404).
   */
  async getChannels(camera: CameraConfig): Promise<NvrChannel[]> {
    const channels = await this.getXml(camera, "/ISAPI/ContentMgmt/InputProxy/channels");
    const status = await this.getXml(camera, "/ISAPI/ContentMgmt/InputProxy/channels/status").catch(() => undefined);
    const recording = await this.getXml(camera, HIKVISION_RECORDING_PATH).then(parseRecordingStatusXml, () => undefined);
    return parseHikvisionChannels(channels, status, recording);
  }

  async getRecordingStatus(camera: CameraConfig): Promise<RecordingReading> {
    const key = `${camera.host}:${camera.port}`;
    if ((this.noStatusApi.get(key) ?? 0) < Date.now()) {
      try {
        const live = parseRecordingStatusXml(await this.getXml(camera, HIKVISION_RECORDING_PATH));
        if (live.state !== "unknown") return live;
      } catch (err) {
        // Some firmware answers a missing Recording/status with 403 rather than 404.
        if (!(err instanceof CameraApiError) || !["API_UNAVAILABLE", "INVALID_RESPONSE", "PERMISSION_DENIED"].includes(err.code)) throw err;
        if (err.code !== "INVALID_RESPONSE") {
          // Missing or refused is a property of the firmware; a garbled reply may be a one-off.
          if (this.noStatusApi.size > 100_000) this.noStatusApi.clear();
          this.noStatusApi.set(key, Date.now() + NO_STATUS_TTL_MS);
        }
      }
    }
    return this.recordingFromSearch(camera);
  }

  private async recordingFromSearch(camera: CameraConfig): Promise<RecordingReading> {
    const { nowMs, offsetMinutes } = parseCameraTime(await this.step("reading the camera's clock", () => this.getXml(camera, HIKVISION_TIME_PATH)));
    const latestAround = async (now: number) =>
      parseSearchLatestEnd(
        await this.step("searching its recordings", () =>
          this.getXml(camera, HIKVISION_SEARCH_PATH, searchRequestXml(now - SEARCH_WINDOW_MINUTES * 60_000, now + 5 * 60_000, randomUUID().toUpperCase())),
        ),
      );
    let latest = await latestAround(nowMs);
    // Some firmware reads the requested period as UTC; search that period too before concluding.
    if (latest === undefined && offsetMinutes) latest = await latestAround(nowMs - offsetMinutes * 60_000);
    if (latest !== undefined) latest = toLocalWallClock(latest, nowMs, offsetMinutes);
    // Only needed to explain a camera that is not recording.
    let schedule: TrackSchedule | undefined;
    if (latest === undefined || nowMs - latest > RECORDING_RECENT_MINUTES * 60_000) {
      schedule = await this.getXml(camera, HIKVISION_TRACK_PATH).then(parseTrackSchedule, () => undefined);
    }
    return recordingFromSegments(nowMs, latest, schedule);
  }

  /**
   * Days of recordings on the camera: one search over the last 400 days (shorter if the camera
   * refuses) asking for the first few segments (the camera lists them oldest first). Whether replies are in local time or
   * UTC is told from the newest segment, as for the recording status.
   */
  async getRecordingRange(camera: CameraConfig): Promise<RecordingRange | null> {
    const { nowMs, offsetMinutes } = parseCameraTime(await this.step("reading the camera's clock", () => this.getXml(camera, HIKVISION_TIME_PATH)));
    // The reply is parsed inside the step too: a camera reports a refused search in the reply body.
    const search = <T,>(from: number, to: number, max: number, parse: (xml: string) => T) =>
      this.step("searching its recordings", async () =>
        parse(await this.getXml(camera, HIKVISION_SEARCH_PATH, searchRequestXml(from, to, randomUUID().toUpperCase(), max))),
      );
    let oldest: number | undefined;
    let lookback = 0;
    for (const [i, days] of RANGE_LOOKBACK_DAYS.entries()) {
      try {
        oldest = await search(nowMs - days * 86_400_000, nowMs + 5 * 60_000, 5, parseSearchOldestStart);
        lookback = days;
        break;
      } catch (err) {
        const retryable = err instanceof CameraApiError && ["API_ERROR", "API_UNAVAILABLE", "INVALID_RESPONSE", "TIMEOUT"].includes(err.code);
        if (!retryable || i === RANGE_LOOKBACK_DAYS.length - 1) throw err;
      }
    }
    if (oldest === undefined) return null;
    let shiftMs = 0;
    if (offsetMinutes) {
      const latest = await search(nowMs - SEARCH_WINDOW_MINUTES * 60_000, nowMs + 5 * 60_000, 40, parseSearchLatestEnd);
      if (latest !== undefined && toLocalWallClock(latest, nowMs, offsetMinutes) !== latest) shiftMs = offsetMinutes * 60_000;
    }
    const oldestLocal = oldest + shiftMs;
    const days = Math.max(0, Math.round(((nowMs - oldestLocal) / 86_400_000) * 100) / 100);
    // Recordings from the very start of a shortened search: the card may hold more.
    const atLeast = lookback < RANGE_LOOKBACK_DAYS[0]! && days >= lookback - 1;
    return { oldest: wallClockText(oldestLocal), days, ...(atLeast ? { atLeast } : {}) };
  }

  /**
   * Recordings between two local wall-clock times, for playback: searched page by page, merged
   * where one segment ends as the next starts. Firmware that answers in UTC is detected as for
   * the recording range and its times shifted to local time (shiftMs).
   */
  async listRecordings(camera: CameraConfig, fromMs: number, toMs: number, channel = 1): Promise<RecordingList> {
    const { nowMs, offsetMinutes } = parseCameraTime(await this.step("reading the camera's clock", () => this.getXml(camera, HIKVISION_TIME_PATH)));
    const search = async (from: number, to: number) => {
      const id = randomUUID().toUpperCase();
      const found: RecordedSegment[] = [];
      for (let page = 0; page < 25; page++) {
        const { segments, more } = await this.step("searching its recordings", async () =>
          parseSearchSegments(await this.getXml(camera, HIKVISION_SEARCH_PATH, searchRequestXml(from, to, id, 50, page * 50, channel * 100 + 1))),
        );
        found.push(...segments);
        if (!more || segments.length === 0) break;
      }
      return found;
    };
    let found = await search(fromMs, toMs);
    let shiftMs = 0;
    if (offsetMinutes && found.length) {
      const latest = Math.max(...found.map((s) => s.end));
      if (toLocalWallClock(latest, nowMs, offsetMinutes) !== latest) {
        // Firmware answering in UTC also reads the requested period in UTC: ask for the local one.
        shiftMs = offsetMinutes * 60_000;
        found = await search(fromMs - shiftMs, toMs - shiftMs);
      }
    }
    return { segments: mergeSegments(found.map((s) => ({ start: s.start + shiftMs, end: s.end + shiftMs }))), nowMs, shiftMs };
  }

  /** Recordings of track N01 (channel N) from a camera time (YYYYMMDDTHHMMSSZ, the camera's own clock). */
  playbackRtspPath(startMs: number, _segment?: RecordedSegment, channel = 1): string {
    return `/Streaming/tracks/${channel}01?${playbackTimes(startMs)}`;
  }

  /** The sub stream's recordings (H.264 on most models, when the main stream is H.265), and the ISAPI-prefixed path of some firmware. */
  playbackRtspFallbacks(startMs: number, _segment?: RecordedSegment, channel = 1): string[] {
    const t = playbackTimes(startMs);
    return [`/Streaming/tracks/${channel}02?${t}`, `/ISAPI/Streaming/tracks/${channel}01?${t}`];
  }

  /** Some firmware ignores starttime and plays from the first recording on the card; it honours a clock range on PLAY. */
  readonly playbackClockRange = true;

  /** The camera's clock in UTC: its local time and time zone (/ISAPI/System/time). */
  async getClock(camera: CameraConfig): Promise<number> {
    const { nowMs, offsetMinutes } = parseCameraTime(await this.getXml(camera, HIKVISION_TIME_PATH));
    if (offsetMinutes === undefined) throw new CameraApiError("INVALID_RESPONSE", "The camera did not report its time zone");
    return nowMs - offsetMinutes * 60_000;
  }

  /** Names the step that failed, and what a refused one needs, in the error shown on the camera page. */
  private async step<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (err) {
      if (!(err instanceof CameraApiError)) throw err;
      const hint = err.code === "PERMISSION_DENIED"
        ? ". Give the camera user the Remote: Playback permission (Configuration → System → User Management), or use an administrator account"
        : "";
      throw new CameraApiError(err.code, `${err.message} (while ${what})${hint}`, err.options);
    }
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
