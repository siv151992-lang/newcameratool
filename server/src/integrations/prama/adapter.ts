import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { HIKVISION_STORAGE_PATH, HikvisionAdapter } from "../hikvision/adapter.js";
import { OnvifAdapter } from "../onvif/adapter.js";
import {
  CameraApiError,
  type BrandMeta,
  type CameraConfig,
  type DeviceInfo,
  type RecordedSegment,
  type RecordingList,
  type RecordingRange,
  type RecordingReading,
  type StorageReading,
} from "../types.js";

/** The API is missing at this address (404). */
const missing = (err: unknown) => err instanceof CameraApiError && err.code === "API_UNAVAILABLE";

/** How a Prama camera is read: Hikvision's API, the same API renamed /pramaAPI, or ONVIF. */
type Api = "isapi" | "prama" | "onvif";
const REMEMBER_MS = 6 * 3_600_000;

/**
 * Prama India cameras and NVRs. They run Hikvision-based firmware: older models answer Hikvision's
 * API at /ISAPI, newer ones the same API renamed /pramaAPI (confirmed on PT-NC361P3-WNAM(D2),
 * firmware V5.7.19: /pramaAPI/ContentMgmt/Storage). Models with neither are read over ONVIF. Each
 * camera is tried in that order, and the API that answers is remembered for it.
 */
export class PramaAdapter extends HikvisionAdapter {
  override readonly meta: BrandMeta = {
    key: "prama",
    displayName: "Prama (Hikvision India)",
    supportStatus: "supported",
    authMethods: ["digest", "basic (HTTPS only)", "ws-security (ONVIF)"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "live-view", "playback", "multiple-storage-devices", "nas"],
    storageEndpoint: `GET ${HIKVISION_STORAGE_PATH} or /pramaAPI/ContentMgmt/Storage, or ONVIF GetStorageDevices`,
    defaultTimeoutMs: 10000,
    notes:
      "Prama firmware is Hikvision-based: the Hikvision API at /ISAPI on older models, renamed /pramaAPI on newer ones " +
      "(HTTP Digest authentication). Storage, recording, live video, recordings and NVR channels work as for Hikvision. " +
      "Models with neither are read over ONVIF (turn on ONVIF and add an ONVIF user).",
    compatibility: "Confirmed on PT-NC361P3-WNAM(D2) firmware V5.7.19 (/pramaAPI). Older Prama models with /ISAPI.",
  };

  private readonly onvif: OnvifAdapter;
  /** Per camera (protocol://host:port): the API that answered, and until when to keep using it. */
  private readonly apis = new Map<string, { api: Api; until: number }>();

  constructor(http: CameraHttpClient) {
    super(http);
    this.onvif = new OnvifAdapter(http);
  }

  private key(camera: CameraConfig) {
    return `${camera.protocol}://${camera.host}:${camera.port}`;
  }

  private known(camera: CameraConfig): Api | undefined {
    const k = this.apis.get(this.key(camera));
    return k && k.until > Date.now() ? k.api : undefined;
  }

  private remember(camera: CameraConfig, api: Api) {
    if (this.apis.size > 10_000) this.apis.clear();
    this.apis.set(this.key(camera), { api, until: Date.now() + REMEMBER_MS });
  }

  protected override apiPath(camera: CameraConfig, path: string): string {
    return this.known(camera) === "prama" ? path.replace(/^\/ISAPI\//, "/pramaAPI/") : path;
  }

  /**
   * Runs a request on the camera's API: the one known for it, or /ISAPI, then /pramaAPI, then ONVIF.
   * (The Hikvision code builds /ISAPI paths; apiPath turns them into /pramaAPI ones.)
   */
  private async either<T>(camera: CameraConfig, hikvision: () => Promise<T>, onvif: () => Promise<T>): Promise<T> {
    const known = this.known(camera);
    if (known === "isapi" || known === "prama") return hikvision();
    if (!known) {
      for (const api of ["isapi", "prama"] as const) {
        this.remember(camera, api);
        try {
          return await hikvision();
        } catch (err) {
          if (!missing(err)) throw err;
        }
      }
      this.remember(camera, "onvif");
    }
    try {
      return await onvif();
    } catch (err) {
      if (!(err instanceof CameraApiError)) throw err;
      throw new CameraApiError(
        err.code,
        `This Prama model answers neither /ISAPI nor /pramaAPI, so it is read over ONVIF, which failed: ${err.message}. ` +
          "Turn on ONVIF in the camera (Network → Advanced → Integration Protocol) and add an ONVIF user with the same username and password.",
        err.options,
      );
    }
  }

  override getChannels(camera: CameraConfig) {
    return this.either(camera, () => super.getChannels(camera), () => Promise.reject(new CameraApiError("API_UNAVAILABLE", "NVR channels are read through the Prama / Hikvision API")));
  }

  override getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    return this.either(camera, () => super.getStorageStatus(camera), () => this.onvif.getStorageStatus(camera));
  }

  override getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    return this.either(camera, () => super.getDeviceInfo(camera), () => this.onvif.getDeviceInfo(camera));
  }

  override getRecordingStatus(camera: CameraConfig): Promise<RecordingReading> {
    return this.either(camera, () => super.getRecordingStatus(camera), () => this.onvif.getRecordingStatus(camera));
  }

  override getRecordingRange(camera: CameraConfig): Promise<RecordingRange | null> {
    return this.either(camera, () => super.getRecordingRange(camera), () => this.onvif.getRecordingRange(camera));
  }

  override getSnapshot(camera: CameraConfig, channel = 1) {
    return this.either(camera, () => super.getSnapshot(camera, channel), () => this.onvif.getSnapshot(camera));
  }

  override listRecordings(camera: CameraConfig, fromMs: number, toMs: number, channel = 1): Promise<RecordingList> {
    return this.either(
      camera,
      () => super.listRecordings(camera, fromMs, toMs, channel),
      async () => ({ ...(await this.onvif.listRecordings(camera)), viaOnvif: true }),
    );
  }

  /** ONVIF replay, for recordings listed over ONVIF (models without ISAPI). */
  replayRtspUrl(camera: CameraConfig, segment?: RecordedSegment): Promise<string> {
    return this.onvif.replayRtspUrl(camera, segment);
  }
}
