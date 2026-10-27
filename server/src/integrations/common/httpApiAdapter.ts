import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { runDiagnostics } from "../diagnostics.js";
import { OnvifAdapter } from "../onvif/adapter.js";
import { fetchSnapshot } from "../snapshot.js";
import {
  CameraApiError,
  type BrandMeta,
  type CameraBrandAdapter,
  type CameraConfig,
  type ConnectionResult,
  type DeviceInfo,
  type RecordedSegment,
  type RecordingList,
  type RecordingRange,
  type RecordingReading,
  type StorageReading,
} from "../types.js";

/** One request to the brand's API and how to read its answer. */
export interface ApiCall<T> {
  /** Path and query on the camera, e.g. "/api/v1/storage". */
  path: string;
  method?: "GET" | "POST";
  body?: string;
  /** Content type of the body (POST); JSON by default. */
  contentType?: string;
  /** What the request accepts, e.g. "application/json". */
  accept?: string;
  /** "none" for APIs with their own login (a token in the request): no HTTP authentication. */
  auth?: "none";
  /** The path as shown in errors, when the real one holds a credential (a token in the query). */
  displayPath?: string;
  /** Turns the answer's body into the app's model; throw CameraApiError for what it cannot read. */
  parse: (body: string) => T;
}

/**
 * A base for brands with a plain HTTP API (JSON, XML or text): a new brand declares its storage
 * request and, if it has them, its device information request and picture address. The camera
 * login (Digest, or Basic over HTTPS), certificates, time-outs, blocked addresses, error messages
 * and the connection test are shared. What the brand's API lacks is read over ONVIF: device
 * information, recording status, recordings and playback (Profile G), the live stream address
 * and the picture.
 *
 *   export class AcmeAdapter extends HttpApiAdapter {
 *     readonly meta = { key: "acme", displayName: "Acme", supportStatus: "unverified", … };
 *     protected readonly storage = { path: "/api/v1/storage", accept: "application/json", parse: parseAcmeStorage };
 *   }
 */
export abstract class HttpApiAdapter implements CameraBrandAdapter {
  abstract readonly meta: BrandMeta;
  /** How storage is read: required. */
  protected abstract readonly storage: ApiCall<StorageReading>;
  /** How model, serial and firmware are read; ONVIF's when absent. */
  protected readonly deviceInfo?: ApiCall<DeviceInfo>;
  /** How recording status is read; ONVIF's when absent. */
  protected readonly recording?: ApiCall<RecordingReading>;
  /** The picture's address (channel from 1); ONVIF's when absent. */
  protected readonly snapshotPath?: (channel?: number) => string;
  /** Turns the brand's own error answers into precise errors (wrong password, not supported, …). */
  protected describeError?(body: string): CameraApiError | undefined;

  protected readonly onvif: OnvifAdapter;

  constructor(protected readonly http: CameraHttpClient) {
    this.onvif = new OnvifAdapter(http);
  }

  /** Sends one call and reads its answer. */
  protected async call<T>(camera: CameraConfig, c: ApiCall<T>): Promise<T> {
    const res = await this.http.request(camera, {
      method: c.method ?? (c.body !== undefined ? "POST" : "GET"),
      path: c.path,
      body: c.body,
      contentType: c.body !== undefined ? (c.contentType ?? "application/json") : undefined,
      accept: c.accept ?? "application/json, application/xml, text/plain, */*",
      ...(c.auth ? { auth: c.auth } : {}),
      ...(c.displayPath ? { displayPath: c.displayPath } : {}),
    });
    return c.parse(requireOk(res, c.displayPath ?? c.path, (body) => this.describeError?.(body)));
  }

  getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    return this.call(camera, this.storage);
  }

  getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    return this.deviceInfo ? this.call(camera, this.deviceInfo) : this.onvif.getDeviceInfo(camera);
  }

  getRecordingStatus(camera: CameraConfig): Promise<RecordingReading> {
    return this.recording ? this.call(camera, this.recording) : this.onvif.getRecordingStatus(camera);
  }

  getRecordingRange(camera: CameraConfig): Promise<RecordingRange | null> {
    return this.onvif.getRecordingRange(camera);
  }

  listRecordings(camera: CameraConfig): Promise<RecordingList> {
    return this.onvif.listRecordings(camera);
  }

  replayRtspUrl(camera: CameraConfig, segment?: RecordedSegment): Promise<string> {
    return this.onvif.replayRtspUrl(camera, segment);
  }

  liveRtspUrl(camera: CameraConfig): Promise<string> {
    return this.onvif.liveRtspUrl(camera);
  }

  async getSnapshot(camera: CameraConfig, channel?: number) {
    if (!this.snapshotPath) return this.onvif.getSnapshot(camera);
    return fetchSnapshot(this.http, camera, this.snapshotPath(channel));
  }

  testConnection(camera: CameraConfig): Promise<ConnectionResult> {
    return runDiagnostics(this, camera);
  }
}

/** Parses a JSON answer, or says the camera did not answer JSON. */
export function json<T = Record<string, unknown>>(body: string, what = "answer"): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new CameraApiError("INVALID_RESPONSE", `The camera's ${what} is not JSON`);
  }
}
