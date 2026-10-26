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

/** ISAPI is missing (404): the model does not run Hikvision firmware. */
const noIsapi = (err: unknown) => err instanceof CameraApiError && err.code === "API_UNAVAILABLE";

/**
 * Prama India cameras and NVRs. Older models run Hikvision firmware (ISAPI); newer ones have Prama's
 * own firmware without ISAPI, and are read over ONVIF instead. Each camera is tried with ISAPI
 * first; when it answers 404, ONVIF is used (and remembered for that camera for a while).
 */
export class PramaAdapter extends HikvisionAdapter {
  override readonly meta: BrandMeta = {
    key: "prama",
    displayName: "Prama (Hikvision India)",
    supportStatus: "supported",
    authMethods: ["digest", "basic (HTTPS only)", "ws-security (ONVIF)"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "live-view", "playback", "multiple-storage-devices", "nas"],
    storageEndpoint: `GET ${HIKVISION_STORAGE_PATH}, or ONVIF GetStorageDevices`,
    defaultTimeoutMs: 10000,
    notes:
      "Models with Hikvision firmware use ISAPI with HTTP Digest authentication, like Hikvision. Newer Prama models " +
      "without ISAPI are read over ONVIF: turn on ONVIF in the camera (Network → Advanced → Integration Protocol) " +
      "and add an ONVIF user with the same username and password as entered here.",
    compatibility: "Prama Hikvision India models with Hikvision firmware (ISAPI); other Prama models over ONVIF.",
  };

  private readonly onvif: OnvifAdapter;
  /** host:port of cameras without ISAPI, until when to use ONVIF without asking ISAPI first. */
  private readonly onvifOnly = new Map<string, number>();

  constructor(http: CameraHttpClient) {
    super(http);
    this.onvif = new OnvifAdapter(http);
  }

  /** ISAPI, or ONVIF on models without it (with a message saying what ONVIF needs when that fails too). */
  private async either<T>(camera: CameraConfig, isapi: () => Promise<T>, onvif: () => Promise<T>): Promise<T> {
    const key = `${camera.protocol}://${camera.host}:${camera.port}`;
    if ((this.onvifOnly.get(key) ?? 0) < Date.now()) {
      try {
        return await isapi();
      } catch (err) {
        if (!noIsapi(err)) throw err;
        if (this.onvifOnly.size > 10_000) this.onvifOnly.clear();
        this.onvifOnly.set(key, Date.now() + 6 * 3_600_000);
      }
    }
    try {
      return await onvif();
    } catch (err) {
      if (!(err instanceof CameraApiError)) throw err;
      throw new CameraApiError(
        err.code,
        `This Prama model has no Hikvision API (ISAPI), so it is read over ONVIF, which failed: ${err.message}. ` +
          "Turn on ONVIF in the camera (Network → Advanced → Integration Protocol) and add an ONVIF user with the same username and password.",
        err.options,
      );
    }
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
