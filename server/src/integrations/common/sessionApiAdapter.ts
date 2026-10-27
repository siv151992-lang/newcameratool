import { CameraApiError, type CameraConfig, type DeviceInfo, type StorageReading } from "../types.js";
import { HttpApiAdapter, type ApiCall } from "./httpApiAdapter.js";

/**
 * A base for brands whose API logs in first (a token or session id for the other requests), like
 * Reolink or Dahua's RPC: a new brand writes login() and, if it has one, logout(), and its calls
 * take the token. Each check logs in and out again (cameras allow few sessions at once). Logins
 * that send the password itself are only made over HTTPS.
 */
export abstract class SessionApiAdapter extends HttpApiAdapter {
  /** True when login() sends the password itself (not a hash or Digest): HTTPS only. */
  protected readonly loginSendsPassword: boolean = true;
  /** What to tell users whose camera is on plain HTTP. */
  protected readonly httpsHint: string = "Turn on HTTPS on the camera and set it to https, port 443.";

  /** Logs in and returns the token or session id. */
  protected abstract login(camera: CameraConfig): Promise<string>;
  /** Ends the session (errors are ignored). */
  protected logout?(camera: CameraConfig, token: string): Promise<unknown>;

  /** The storage call, made with the token. */
  protected abstract storageCall(token: string): ApiCall<StorageReading>;
  /** The device information call, made with the token; ONVIF's when absent. */
  protected deviceInfoCall?(token: string): ApiCall<DeviceInfo>;

  // Calls need a token, so the base's fixed calls are not used.
  protected readonly storage: ApiCall<StorageReading> = { path: "", parse: () => ({ devices: [] }) };

  /** Logs in, runs `work` with the token, and logs out. */
  protected async withSession<T>(camera: CameraConfig, work: (token: string) => Promise<T>): Promise<T> {
    if (this.loginSendsPassword && camera.protocol !== "https") {
      throw new CameraApiError("AUTH_METHOD_INSECURE", `${this.meta.displayName}'s login sends the password itself, which anyone on the network could read over HTTP. ${this.httpsHint}`);
    }
    const token = await this.login(camera);
    try {
      return await work(token);
    } finally {
      await this.logout?.(camera, token).catch(() => undefined);
    }
  }

  override getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    return this.withSession(camera, (t) => this.call(camera, this.storageCall(t)));
  }

  override getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    const call = this.deviceInfoCall;
    return call ? this.withSession(camera, (t) => this.call(camera, call.call(this, t))) : this.onvif.getDeviceInfo(camera);
  }
}
