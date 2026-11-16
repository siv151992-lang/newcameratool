import { randomBytes } from "node:crypto";
import { SessionApiAdapter } from "../common/sessionApiAdapter.js";
import type { ApiCall } from "../common/httpApiAdapter.js";
import { fetchSnapshot } from "../snapshot.js";
import { CameraApiError, type BrandMeta, type CameraConfig, type DeviceInfo, type NvrChannel, type RecordingRange, type RecordingReading, type StorageReading } from "../types.js";
import {
  parseReolinkChannels, parseReolinkDeviceInfo, parseReolinkFiles, parseReolinkRecordedDays, parseReolinkStorage, parseReolinkTime,
  type ReolinkTime, reolinkTimeText, reolinkValue,
} from "./parser.js";

/** How many months back the days with recordings are looked for (cards rarely hold more). */
const SEARCH_MONTHS = 12;
const DAY_MS = 86_400_000;
const wallMs = (text: string) => Date.parse(`${text}Z`);

const API = "/cgi-bin/api.cgi";
const two = (n: number) => String(n).padStart(2, "0");

/** One Reolink command: a JSON list with the command, the token in the query. */
function command<T>(cmd: string, parse: (value: Record<string, unknown>) => T, token?: string, param: Record<string, unknown> = {}): ApiCall<T> {
  return {
    path: `${API}?cmd=${cmd}${token ? `&token=${encodeURIComponent(token)}` : ""}`,
    // The token is a credential: never shown in errors. Reolink logs in with its own command.
    displayPath: `${API}?cmd=${cmd}`,
    auth: "none",
    body: JSON.stringify([{ cmd, action: 0, param }]),
    accept: "application/json, */*",
    parse: (body) => parse(reolinkValue(body, cmd)),
  };
}

/**
 * Reolink cameras and NVRs: the JSON API at /cgi-bin/api.cgi. Login (cmd=Login) sends the password
 * itself and returns a token for the other commands, so it is only used over HTTPS (as Basic
 * authentication is). Each check logs in and out again: Reolink allows few sessions at once.
 */
export class ReolinkAdapter extends SessionApiAdapter {
  readonly meta: BrandMeta = {
    key: "reolink",
    displayName: "Reolink",
    supportStatus: "unverified",
    authMethods: ["token login (HTTPS only)"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "live-view", "multiple-storage-devices"],
    storageEndpoint: `POST ${API}?cmd=GetHddInfo`,
    defaultTimeoutMs: 10000,
    notes:
      "Reolink HTTP API (JSON): login with a token, then GetHddInfo (SD card or disk, capacity and free space in MB) and GetDevInfo. " +
      "The login sends the password itself, so turn on HTTPS on the camera (Settings → Network → Advanced → Server Settings) and use https, port 443. " +
      "Live video from /h264Preview_01_sub (RTSP on). Days of recordings from the camera's recording search (cmd=Search); " +
      "recording status over ONVIF where the camera has it. Playback is not available for this brand yet.",
    defaultProtocol: "https",
  };

  protected override readonly httpsHint = "Turn on HTTPS on the camera (Settings → Network → Advanced → Server Settings) and set the camera to https, port 443.";

  /** Live video: the sub stream (H.264), then the main stream, and the names of H.265 models. */
  readonly rtspPath = "/h264Preview_01_sub";
  readonly rtspFallbacks = ["/h264Preview_01_main", "/Preview_01_sub", "/Preview_01_main"];

  channelRtspPaths(channel: number) {
    return [`/h264Preview_${two(channel)}_sub`, `/h264Preview_${two(channel)}_main`];
  }

  protected async login(camera: CameraConfig): Promise<string> {
    const value = await this.call(camera, command("Login", (v) => v, undefined, { User: { Version: "0", userName: camera.username, password: camera.password } }));
    const token = (value.Token as { name?: unknown } | undefined)?.name;
    if (typeof token !== "string" || !token) throw new CameraApiError("INVALID_RESPONSE", "The camera accepted the login but gave no token");
    return token;
  }

  protected override logout(camera: CameraConfig, token: string) {
    return this.call(camera, command("Logout", (v) => v, token));
  }

  protected storageCall(token: string): ApiCall<StorageReading> {
    return command("GetHddInfo", parseReolinkStorage, token);
  }

  protected override deviceInfoCall(token: string): ApiCall<DeviceInfo> {
    return command("GetDevInfo", parseReolinkDeviceInfo, token);
  }

  /** Reolink's API has no "recording now" status: it is read over ONVIF where the camera has it. */
  override async getRecordingStatus(camera: CameraConfig): Promise<RecordingReading> {
    try {
      const r = await this.onvif.getRecordingStatus(camera);
      return { ...r, detail: `${r.detail ? `${r.detail}; ` : ""}read over ONVIF` };
    } catch {
      throw new CameraApiError("API_UNAVAILABLE", "This Reolink model does not report whether it is recording now (its days of recordings are still read)");
    }
  }

  /**
   * Days of recordings on the card: the months with recordings (Search, onlyStatus 1) back from the
   * camera's date, then the first file of the oldest day. Channel N is numbered from 1 here.
   */
  override getRecordingRange(camera: CameraConfig, channel = 1): Promise<RecordingRange | null> {
    return this.withSession(camera, async (t) => {
      const now = await this.call(camera, command("GetTime", parseReolinkTime, t));
      const search = <T>(start: ReolinkTime, end: ReolinkTime, onlyStatus: 0 | 1, parse: (v: Record<string, unknown>) => T) =>
        this.call(camera, command("Search", parse, t, { Search: { channel: channel - 1, onlyStatus, streamType: "main", StartTime: start, EndTime: end } }));
      let oldestDay: string | undefined;
      let atLeast = false;
      for (let i = 0; i < SEARCH_MONTHS; i++) {
        const first = new Date(Date.UTC(now.year, now.mon - 1 - i, 1));
        const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
        const y = first.getUTCFullYear(), m = first.getUTCMonth() + 1;
        const days = await search({ year: y, mon: m, day: 1, hour: 0, min: 0, sec: 0 }, { year: y, mon: m, day: last.getUTCDate(), hour: 23, min: 59, sec: 59 }, 1, parseReolinkRecordedDays);
        if (!days.length) {
          if (oldestDay) break; // a month without recordings before the oldest ones: done
          continue;
        }
        oldestDay = days[0];
        // The card's oldest recordings start inside this month (not on its 1st): no need to look further back.
        if (!days[0]!.endsWith("-01")) break;
        if (i === SEARCH_MONTHS - 1) atLeast = true;
      }
      if (!oldestDay) return null;
      const [y, m, d] = oldestDay.split("-").map(Number) as [number, number, number];
      const files = await search({ year: y, mon: m, day: d, hour: 0, min: 0, sec: 0 }, { year: y, mon: m, day: d, hour: 23, min: 59, sec: 59 }, 0, parseReolinkFiles)
        .catch(() => []);
      const oldest = files[0]?.start ?? `${oldestDay}T00:00:00`;
      const days = Math.max(0, (wallMs(reolinkTimeText(now)) - wallMs(oldest)) / DAY_MS);
      return { oldest, days: Math.round(days * 10) / 10, ...(atLeast ? { atLeast } : {}) };
    });
  }

  /** Reolink NVRs: each channel's camera name and whether it is online. */
  getChannels(camera: CameraConfig): Promise<NvrChannel[]> {
    return this.withSession(camera, (t) => this.call(camera, command("GetChannelstatus", parseReolinkChannels, t)));
  }

  /** The picture, with a token of its own (cmd=Snap; channels from 0). */
  override getSnapshot(camera: CameraConfig, channel = 1) {
    return this.withSession(camera, (t) =>
      fetchSnapshot(this.http, camera, `${API}?cmd=Snap&channel=${channel - 1}&rs=${randomBytes(6).toString("hex")}&token=${encodeURIComponent(t)}`),
    );
  }
}
