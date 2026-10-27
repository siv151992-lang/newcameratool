import { randomBytes } from "node:crypto";
import { SessionApiAdapter } from "../common/sessionApiAdapter.js";
import type { ApiCall } from "../common/httpApiAdapter.js";
import { fetchSnapshot } from "../snapshot.js";
import { CameraApiError, type BrandMeta, type CameraConfig, type DeviceInfo, type NvrChannel, type StorageReading } from "../types.js";
import { parseReolinkChannels, parseReolinkDeviceInfo, parseReolinkStorage, reolinkValue } from "./parser.js";

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
    capabilities: ["storage-status", "device-info", "connection-test", "live-view", "multiple-storage-devices"],
    storageEndpoint: `POST ${API}?cmd=GetHddInfo`,
    defaultTimeoutMs: 10000,
    notes:
      "Reolink HTTP API (JSON): login with a token, then GetHddInfo (SD card or disk, capacity and free space in MB) and GetDevInfo. " +
      "The login sends the password itself, so turn on HTTPS on the camera (Settings → Network → Advanced → Server Settings) and use https, port 443. " +
      "Live video from /h264Preview_01_sub (RTSP on). Recording status and playback are not read for this brand yet.",
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

  /** Recording status is not read for Reolink yet. */
  override getRecordingStatus(): never {
    throw new CameraApiError("API_UNAVAILABLE", "Recording status is not read for Reolink cameras yet");
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
