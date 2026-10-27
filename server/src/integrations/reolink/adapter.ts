import { randomBytes } from "node:crypto";
import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { runDiagnostics } from "../diagnostics.js";
import { fetchSnapshot } from "../snapshot.js";
import { CameraApiError, type BrandMeta, type CameraBrandAdapter, type CameraConfig, type ConnectionResult, type DeviceInfo, type NvrChannel, type StorageReading } from "../types.js";
import { parseReolinkChannels, parseReolinkDeviceInfo, parseReolinkStorage, reolinkValue } from "./parser.js";

const API = "/cgi-bin/api.cgi";
const two = (n: number) => String(n).padStart(2, "0");

/**
 * Reolink cameras and NVRs: the JSON API at /cgi-bin/api.cgi. Login (cmd=Login) sends the password
 * itself and returns a token for the other commands, so it is only used over HTTPS (as Basic
 * authentication is). Each check logs in and out again: Reolink allows few sessions at once.
 */
export class ReolinkAdapter implements CameraBrandAdapter {
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

  constructor(private readonly http: CameraHttpClient) {}

  /** Live video: the sub stream (H.264), then the main stream, and the names of H.265 models. */
  readonly rtspPath = "/h264Preview_01_sub";
  readonly rtspFallbacks = ["/h264Preview_01_main", "/Preview_01_sub", "/Preview_01_main"];

  channelRtspPaths(channel: number) {
    return [`/h264Preview_${two(channel)}_sub`, `/h264Preview_${two(channel)}_main`];
  }

  private async post(camera: CameraConfig, cmd: string, param: Record<string, unknown>, token?: string): Promise<Record<string, unknown>> {
    const path = `${API}?cmd=${cmd}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
    const res = await this.http.request(camera, {
      method: "POST",
      path,
      // The token is a credential: never shown in errors.
      displayPath: `${API}?cmd=${cmd}`,
      body: JSON.stringify([{ cmd, action: 0, param }]),
      contentType: "application/json",
      accept: "application/json, */*",
      auth: "none",
    });
    if (res.status === 404) throw new CameraApiError("API_UNAVAILABLE", `The camera has no Reolink API (${API}, HTTP 404)`, { httpStatus: 404 });
    if (res.status < 200 || res.status >= 300) throw new CameraApiError("API_ERROR", `Camera returned HTTP ${res.status} for ${cmd}`, { httpStatus: res.status });
    return reolinkValue(res.body, cmd);
  }

  /** Logs in, runs `work` with the token, and logs out. */
  private async withToken<T>(camera: CameraConfig, work: (token: string) => Promise<T>): Promise<T> {
    if (camera.protocol !== "https") {
      throw new CameraApiError(
        "AUTH_METHOD_INSECURE",
        "Reolink's login sends the password itself, which over HTTP anyone on the network could read. Turn on HTTPS on the camera (Settings → Network → Advanced → Server Settings) and set the camera to https, port 443.",
      );
    }
    const login = await this.post(camera, "Login", { User: { Version: "0", userName: camera.username, password: camera.password } });
    const token = (login.Token as { name?: unknown } | undefined)?.name;
    if (typeof token !== "string" || !token) throw new CameraApiError("INVALID_RESPONSE", "The camera accepted the login but gave no token");
    try {
      return await work(token);
    } finally {
      await this.post(camera, "Logout", {}, token).catch(() => undefined);
    }
  }

  getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    return this.withToken(camera, async (t) => parseReolinkStorage(await this.post(camera, "GetHddInfo", {}, t)));
  }

  getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    return this.withToken(camera, async (t) => parseReolinkDeviceInfo(await this.post(camera, "GetDevInfo", {}, t)));
  }

  /** Reolink NVRs: each channel's camera name and whether it is online. */
  getChannels(camera: CameraConfig): Promise<NvrChannel[]> {
    return this.withToken(camera, async (t) => parseReolinkChannels(await this.post(camera, "GetChannelstatus", {}, t)));
  }

  /** The picture, with a token of its own (cmd=Snap; channels from 0). */
  getSnapshot(camera: CameraConfig, channel = 1) {
    return this.withToken(camera, (t) =>
      fetchSnapshot(this.http, camera, `${API}?cmd=Snap&channel=${channel - 1}&rs=${randomBytes(6).toString("hex")}&token=${encodeURIComponent(t)}`),
    );
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
