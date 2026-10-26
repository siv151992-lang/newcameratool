import { createHash } from "node:crypto";
import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { aggregate } from "../storageMath.js";
import { CameraApiError, type CameraConfig, type DeviceInfo, type StorageDeviceStatus, type StorageReading } from "../types.js";

/**
 * Dahua's JSON-RPC API (RPC2), which the camera's own web page uses. Newer Dahua and CP Plus firmware
 * has it where the HTTP API (CGI) is turned off or missing; CP Plus serves it as /cpapi2 instead of
 * /RPC2. Login is two steps on <base>_Login: the camera sends a realm and a random value, then the
 * password is sent hashed (MD5 of user:random:MD5(user:realm:password), upper case), never itself.
 */

/** Where the RPC API is: Dahua's name, then CP Plus's. */
export const RPC_BASES = ["/RPC2", "/cpapi2"] as const;
export type RpcBase = (typeof RPC_BASES)[number];

interface RpcReply {
  result?: unknown;
  params?: Record<string, unknown> | null;
  session?: string | number;
  error?: { code?: number; message?: string };
}

const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex").toUpperCase();

/** The hashed password for the second login step, by the encryption the camera asks for. */
export function rpcPasswordHash(encryption: string, user: string, password: string, realm: string, random: string): string {
  if (encryption === "Basic") return Buffer.from(`${user}:${password}`).toString("base64");
  if (encryption === "Default") return md5(`${user}:${random}:${md5(`${user}:${realm}:${password}`)}`);
  throw new CameraApiError("AUTH_FAILED", `The camera asks for a login method this app does not support yet (${encryption || "unknown"})`);
}

/**
 * The two login dialects: Dahua's Web3.0 page (global.login) and the newer Web5.0 page on CP Plus
 * firmware (user.signin), which answers global.login with HTTP 400. The challenge, the password hash
 * and the calls after login are the same.
 */
const DIALECTS = [
  { method: "global.login", params: { clientType: "Web3.0", loginType: "Direct" } },
  { method: "user.signin", params: { clientType: "Web5.0" } },
] as const;

export class DahuaRpc {
  private id = 0;
  /** The dialect each camera logs in with, by host and port. */
  private readonly dialects = new Map<string, number>();

  constructor(private readonly http: CameraHttpClient) {}

  private async post(camera: CameraConfig, path: string, body: object, session?: string): Promise<RpcReply> {
    const origin = `${camera.protocol}://${camera.host}${(camera.protocol === "https" ? camera.port === 443 : camera.port === 80) ? "" : `:${camera.port}`}`;
    const res = await this.http.request(camera, {
      method: "POST",
      path,
      body: JSON.stringify({ ...body, id: ++this.id }),
      contentType: "application/json",
      accept: "application/json, text/plain, */*",
      // As the camera's web page sends them.
      headers: { Origin: origin, Referer: `${origin}/`, "Accept-Language": "en-US,en;q=0.9" },
      cookie: session ? `username=${encodeURIComponent(camera.username)}; WebClientHttpsSessionID=${session}; WebClientSessionID=${session}` : undefined,
      auth: "none",
    });
    if (res.status === 404) throw new CameraApiError("API_UNAVAILABLE", `The camera does not provide ${path} (HTTP 404)`, { httpStatus: 404 });
    if (res.status < 200 || res.status >= 300) {
      const said = res.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
      throw new CameraApiError("API_ERROR", `Camera returned HTTP ${res.status} for ${path}${said ? ` ("${said}")` : ""}`, { httpStatus: res.status });
    }
    try {
      return JSON.parse(res.body) as RpcReply;
    } catch {
      throw new CameraApiError("INVALID_RESPONSE", `The camera did not answer ${path} with JSON`);
    }
  }

  /** Logs in and returns the session. */
  async login(camera: CameraConfig, base: RpcBase): Promise<string> {
    const path = `${base}_Login`;
    const key = `${camera.host}:${camera.port}`;
    const known = this.dialects.get(key);
    const order = known === undefined ? [0, 1] : [known];
    let challenge: RpcReply | undefined;
    let dialect: (typeof DIALECTS)[number] = DIALECTS[0];
    for (const [i, d] of order.entries()) {
      dialect = DIALECTS[d]!;
      try {
        challenge = await this.post(camera, path, { method: dialect.method, params: { userName: camera.username, password: "", ...dialect.params } });
      } catch (err) {
        // HTTP 400: this firmware does not know the method; try the other dialect.
        if (i < order.length - 1 && err instanceof CameraApiError && err.options.httpStatus === 400) continue;
        throw err;
      }
      const p = challenge.params ?? {};
      if (typeof p.realm === "string" && typeof p.random === "string") {
        this.dialects.set(key, d);
        break;
      }
      if (i === order.length - 1) break;
    }
    const p = challenge?.params ?? {};
    const session = challenge?.session;
    if (session === undefined || typeof p.realm !== "string" || typeof p.random !== "string") {
      throw new CameraApiError("INVALID_RESPONSE", `The camera did not start a login on ${path}`);
    }
    const encryption = typeof p.encryption === "string" ? p.encryption : "Default";
    const hash = rpcPasswordHash(encryption, camera.username, camera.password, p.realm, p.random);
    const reply = await this.post(camera, path, {
      method: dialect.method,
      params: { userName: camera.username, password: hash, ...dialect.params, authorityType: encryption, passwordType: encryption },
      session,
    }).catch((err: unknown) => {
      if (err instanceof CameraApiError && err.code === "API_ERROR") throw new CameraApiError("API_ERROR", `${err.message} (on the second login step, with the password)`, err.options);
      throw err;
    });
    if (reply.result !== true) {
      const why = reply.error?.message ? `: ${reply.error.message}` : "";
      throw new CameraApiError("AUTH_FAILED", `The camera rejected the credentials${why}`);
    }
    return String(reply.session ?? session);
  }

  private async send(camera: CameraConfig, base: RpcBase, session: string, method: string, params: unknown, object?: unknown): Promise<RpcReply> {
    const reply = await this.post(camera, base, { method, params, session, ...(object !== undefined ? { object } : {}) }, session);
    if (reply.result === false || reply.error) {
      const msg = reply.error?.message || "the call was refused";
      const code = reply.error?.code === 287637505 || /no.?session|invalid session/i.test(msg) ? "AUTH_FAILED" : "API_ERROR";
      throw new CameraApiError(code, `The camera refused ${method}: ${msg}`);
    }
    return reply;
  }

  /** Calls a method in a session (on an object made by a factory, if given); throws on an error reply. */
  async call(camera: CameraConfig, base: RpcBase, session: string, method: string, params: unknown = null, object?: unknown): Promise<Record<string, unknown>> {
    return (await this.send(camera, base, session, method, params, object)).params ?? {};
  }

  /**
   * The disks (storage.getDeviceAllInfo). Some firmware answers it directly; others, like the CP Plus
   * web page, first make a storage object (storage.factory.instance) and call it on that object.
   */
  async storage(camera: CameraConfig, base: RpcBase, session: string): Promise<Record<string, unknown>> {
    try {
      return await this.call(camera, base, session, "storage.getDeviceAllInfo");
    } catch (err) {
      if (err instanceof CameraApiError && err.code === "AUTH_FAILED") throw err;
      const object = (await this.send(camera, base, session, "storage.factory.instance", null)).result;
      if (object === undefined || object === true || object === null) throw err;
      try {
        return await this.call(camera, base, session, "storage.getDeviceAllInfo", null, object);
      } finally {
        await this.send(camera, base, session, "storage.destroy", null, object).catch(() => undefined);
      }
    }
  }

  logout(camera: CameraConfig, base: RpcBase, session: string) {
    return this.post(camera, base, { method: "global.logout", params: null, session }, session).catch(() => undefined);
  }

  /** Logs in, runs `work`, and logs out. */
  async withSession<T>(camera: CameraConfig, base: RpcBase, work: (session: string) => Promise<T>): Promise<T> {
    const session = await this.login(camera, base);
    try {
      return await work(session);
    } finally {
      await this.logout(camera, base, session);
    }
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);

/**
 * storage.getDeviceAllInfo: { info: [ { Name: "/dev/mmc0", State: "Success", Detail: [ { Path,
 * Type: "ReadWrite", TotalBytes, UsedBytes, IsError } ] } ] }. Partitions are summed per device.
 */
export function parseRpcStorage(params: Record<string, unknown>): StorageReading {
  const list = Array.isArray(params.info) ? params.info : Array.isArray(params.list) ? params.list : [];
  const devices = list.flatMap((d, i): StorageDeviceStatus[] => {
    if (!d || typeof d !== "object") return [];
    const disk = d as Record<string, unknown>;
    const parts = (Array.isArray(disk.Detail) ? disk.Detail : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
    const state = typeof disk.State === "string" ? disk.State : undefined;
    if (parts.length === 0 && /^(none|nodisk|notexist|empty)$/i.test(state ?? "")) return [];
    const total = parts.reduce((s, x) => s + (num(x.TotalBytes) ?? 0), 0);
    const used = parts.reduce((s, x) => s + (num(x.UsedBytes) ?? 0), 0);
    const error = parts.some((x) => x.IsError === true) || /error|fail|abnormal/i.test(state ?? "");
    const type = parts.find((x) => typeof x.Type === "string")?.Type as string | undefined;
    return [{
      id: typeof disk.Name === "string" ? disk.Name : String(i + 1),
      name: typeof disk.Name === "string" ? disk.Name : `Disk ${i + 1}`,
      healthStatus: error ? "unhealthy" : state && !/^(success|normal|ok)$/i.test(state) ? "degraded" : "healthy",
      rawStatus: error ? "Error" : state,
      totalBytes: total || undefined,
      usedBytes: total ? used : undefined,
      freeBytes: total ? Math.max(0, total - used) : undefined,
      usedPercentage: total ? Math.round((used / total) * 1000) / 10 : undefined,
      writable: type ? /write/i.test(type) && !/^readonly$/i.test(type) : undefined,
      property: type,
    }];
  });
  return aggregate(devices);
}

/** magicBox.getSystemInfo and magicBox.getSoftwareVersion. */
export function parseRpcDeviceInfo(system: Record<string, unknown>, software?: Record<string, unknown>): DeviceInfo {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const version = software?.version as Record<string, unknown> | undefined;
  return {
    model: str(system.updateSerial) ?? str(system.deviceType),
    serialNumber: str(system.serialNumber),
    firmwareVersion: str(version?.Version),
    deviceName: str(system.deviceType),
  };
}
