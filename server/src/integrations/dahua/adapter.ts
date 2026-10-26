import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { runDiagnostics } from "../diagnostics.js";
import { CameraApiError, mergeSegments, type BrandMeta, type CameraBrandAdapter, type CameraConfig, type ConnectionResult, type DeviceInfo, type NvrChannel, type RecordedSegment, type RecordingList, type RecordingReading, type StorageReading } from "../types.js";
import { dahuaTime, dahuaTimeMs, parseDahuaChannels, parseDahuaDeviceInfo, parseDahuaError, parseDahuaFiles, parseDahuaRecording, parseDahuaStorage } from "./parser.js";
import { fetchSnapshot } from "../snapshot.js";
import { OnvifAdapter } from "../onvif/adapter.js";
import { DahuaRpc, parseRpcDeviceInfo, parseRpcStorage, RPC_BASES, type RpcBase } from "./rpc.js";

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

  private readonly rpc: DahuaRpc;
  private readonly onvif: OnvifAdapter;
  /** Per camera: whether it answers the HTTP API (CGI) or only the RPC API (RPC2 / CP Plus cpapi2). */
  private readonly apis = new Map<string, { api: "cgi" | RpcBase; until: number }>();

  constructor(private readonly http: CameraHttpClient) {
    this.rpc = new DahuaRpc(http);
    this.onvif = new OnvifAdapter(http);
  }

  private apiOf(camera: CameraConfig) {
    const a = this.apis.get(`${camera.protocol}://${camera.host}:${camera.port}`);
    return a && a.until > Date.now() ? a.api : undefined;
  }

  private setApi(camera: CameraConfig, api: "cgi" | RpcBase) {
    if (this.apis.size > 10_000) this.apis.clear();
    this.apis.set(`${camera.protocol}://${camera.host}:${camera.port}`, { api, until: Date.now() + 6 * 3_600_000 });
  }

  /**
   * The HTTP API (CGI), or, where it is off or missing (newer Dahua and CP Plus firmware), the RPC
   * API the camera's web page uses: /RPC2, or /cpapi2 on CP Plus. The one that answers is remembered.
   */
  private async either<T>(camera: CameraConfig, cgi: () => Promise<T>, rpc: (base: RpcBase) => Promise<T>): Promise<T> {
    const known = this.apiOf(camera);
    if (known === "cgi") return cgi();
    if (known) return rpc(known);
    let cgiError: unknown;
    try {
      const value = await cgi();
      this.setApi(camera, "cgi");
      return value;
    } catch (err) {
      if (!(err instanceof CameraApiError) || err.code !== "API_UNAVAILABLE") throw err;
      cgiError = err;
    }
    for (const base of RPC_BASES) {
      try {
        const value = await rpc(base);
        this.setApi(camera, base);
        return value;
      } catch (err) {
        if (!(err instanceof CameraApiError) || err.code !== "API_UNAVAILABLE") throw err;
      }
    }
    throw cgiError;
  }

  /** Live video: the second (sub) stream, which is H.264 on most models. */
  readonly rtspPath = "/cam/realmonitor?channel=1&subtype=1";
  /** The main stream when the sub stream is off. */
  readonly rtspFallbacks = ["/cam/realmonitor?channel=1&subtype=0"];

  /** The current picture for the live view (Channel 1). */
  getSnapshot(camera: CameraConfig, channel = 1) {
    return fetchSnapshot(this.http, camera, `/cgi-bin/snapshot.cgi?channel=${channel}`);
  }

  /** NVR channel N: sub stream, then main stream. */
  channelRtspPaths(channel: number) {
    return [`/cam/realmonitor?channel=${channel}&subtype=1`, `/cam/realmonitor?channel=${channel}&subtype=0`];
  }

  private async getText(camera: CameraConfig, path: string): Promise<string> {
    try {
      return requireOk(await this.http.request(camera, { path, accept: "text/plain, */*" }), path, parseDahuaError);
    } catch (err) {
      // Newer Dahua and CP Plus firmware ships with its HTTP API (CGI) turned off: every /cgi-bin path is 404.
      if (err instanceof CameraApiError && err.code === "API_UNAVAILABLE" && err.options.httpStatus === 404 && path.startsWith("/cgi-bin/")) {
        throw new CameraApiError(
          "API_UNAVAILABLE",
          `${err.message}. The camera's HTTP API (CGI) may be turned off: on newer Dahua and CP Plus firmware, turn it on in the camera ` +
            "under Settings → Network → Access Platform (or Integration Protocol) → CGI.",
          err.options,
        );
      }
      throw err;
    }
  }

  async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    return this.either(
      camera,
      async () => parseDahuaStorage(await this.getText(camera, DAHUA_STORAGE_PATH)),
      (base) => this.rpc.withSession(camera, base, async (s) => parseRpcStorage(await this.rpc.storage(camera, base, s))),
    );
  }

  async getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    return this.either(
      camera,
      async () => parseDahuaDeviceInfo(await this.getText(camera, DAHUA_DEVICE_INFO_PATH)),
      (base) => this.rpc.withSession(camera, base, async (s) => {
        const system = await this.rpc.call(camera, base, s, "magicBox.getSystemInfo");
        const software = await this.rpc.call(camera, base, s, "magicBox.getSoftwareVersion").catch(() => undefined);
        return parseRpcDeviceInfo(system, software);
      }),
    );
  }

  /** NVR channels: names, whether each camera is connected, and whether each channel is recording. */
  async getChannels(camera: CameraConfig): Promise<NvrChannel[]> {
    const titles = await this.getText(camera, "/cgi-bin/configManager.cgi?action=getConfig&name=ChannelTitle");
    const states = await this.getText(camera, "/cgi-bin/LogicDeviceManager.cgi?action=getCameraState&uniqueChannels[0]=-1").catch(() => undefined);
    const recording = await this.getRecordingStatus(camera).catch(() => undefined);
    return parseDahuaChannels(titles, states, recording);
  }

  /** Recording status (CGI); over ONVIF on cameras with only the RPC API. */
  async getRecordingStatus(camera: CameraConfig): Promise<RecordingReading> {
    if (this.apiOf(camera) && this.apiOf(camera) !== "cgi") return this.onvif.getRecordingStatus(camera);
    try {
      return parseDahuaRecording(await this.getText(camera, DAHUA_RECORDING_PATH));
    } catch (err) {
      if (!(err instanceof CameraApiError) || err.code !== "API_UNAVAILABLE") throw err;
      return this.onvif.getRecordingStatus(camera);
    }
  }

  /** ONVIF replay, for recordings listed over ONVIF (cameras with only the RPC API). */
  replayRtspUrl(camera: CameraConfig, segment?: RecordedSegment): Promise<string> {
    return this.onvif.replayRtspUrl(camera, segment);
  }

  /**
   * Recordings of channel 1 between two local times: mediaFileFind (create, findFile, then
   * findNextFile until the files run out; closed and destroyed afterwards). Dahua uses local time throughout.
   */
  async listRecordings(camera: CameraConfig, fromMs: number, toMs: number, channel = 1): Promise<RecordingList> {
    if (this.apiOf(camera) && this.apiOf(camera) !== "cgi") return { ...(await this.onvif.listRecordings(camera)), viaOnvif: true };
    return this.listRecordingsCgi(camera, fromMs, toMs, channel);
  }

  private async listRecordingsCgi(camera: CameraConfig, fromMs: number, toMs: number, channel: number): Promise<RecordingList> {
    const finder = "/cgi-bin/mediaFileFind.cgi";
    const now = await this.getText(camera, "/cgi-bin/global.cgi?action=getCurrentTime").then((t) => dahuaTimeMs(t), () => undefined);
    const id = /result=(\d+)/.exec(await this.getText(camera, `${finder}?action=factory.create`))?.[1];
    if (!id) throw new CameraApiError("INVALID_RESPONSE", "The camera did not open a recording search");
    const found: RecordedSegment[] = [];
    try {
      await this.getText(
        camera,
        `${finder}?action=findFile&object=${id}&condition.Channel=${channel}&condition.StartTime=${encodeURIComponent(dahuaTime(fromMs))}&condition.EndTime=${encodeURIComponent(dahuaTime(toMs))}&condition.Types[0]=dav`,
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
  playbackRtspPath(startMs: number, _segment?: RecordedSegment, channel = 1): string {
    return `/cam/playback?channel=${channel}&subtype=0&starttime=${dahuaTime(startMs, "_")}&endtime=${dahuaTime(startMs + 12 * 3_600_000, "_")}`;
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}
