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

export class DahuaRpc {
  private id = 0;

  constructor(private readonly http: CameraHttpClient) {}

  private async post(camera: CameraConfig, path: string, body: object): Promise<RpcReply> {
    const res = await this.http.request(camera, {
      method: "POST",
      path,
      body: JSON.stringify({ ...body, id: ++this.id }),
      contentType: "application/json",
      accept: "application/json, */*",
      auth: "none",
    });
    if (res.status === 404) throw new CameraApiError("API_UNAVAILABLE", `The camera does not provide ${path} (HTTP 404)`, { httpStatus: 404 });
    if (res.status < 200 || res.status >= 300) throw new CameraApiError("API_ERROR", `Camera returned HTTP ${res.status} for ${path}`, { httpStatus: res.status });
    try {
      return JSON.parse(res.body) as RpcReply;
    } catch {
      throw new CameraApiError("INVALID_RESPONSE", `The camera did not answer ${path} with JSON`);
    }
  }

  /** Logs in and returns the session. */
  async login(camera: CameraConfig, base: RpcBase): Promise<string> {
    const path = `${base}_Login`;
    const params = { userName: camera.username, password: "", clientType: "Web3.0", loginType: "Direct" };
    const challenge = await this.post(camera, path, { method: "global.login", params });
    const p = challenge.params ?? {};
    const session = challenge.session;
    if (session === undefined || typeof p.realm !== "string" || typeof p.random !== "string") {
      throw new CameraApiError("INVALID_RESPONSE", `The camera did not start a login on ${path}`);
    }
    const encryption = typeof p.encryption === "string" ? p.encryption : "Default";
    const hash = rpcPasswordHash(encryption, camera.username, camera.password, p.realm, p.random);
    const reply = await this.post(camera, path, {
      method: "global.login",
      params: { ...params, password: hash, authorityType: encryption },
      session,
    });
    if (reply.result !== true) {
      const why = reply.error?.message ? `: ${reply.error.message}` : "";
      throw new CameraApiError("AUTH_FAILED", `The camera rejected the credentials${why}`);
    }
    return String(reply.session ?? session);
  }

  /** Calls a method in a session; throws on an error reply. */
  async call(camera: CameraConfig, base: RpcBase, session: string, method: string, params: unknown = null): Promise<Record<string, unknown>> {
    const reply = await this.post(camera, base, { method, params, session });
    if (reply.result === false || reply.error) {
      const msg = reply.error?.message ?? "the call was refused";
      const code = reply.error?.code === 287637505 || /no.?session|invalid session/i.test(msg) ? "AUTH_FAILED" : "API_ERROR";
      throw new CameraApiError(code, `The camera refused ${method}: ${msg}`);
    }
    return reply.params ?? {};
  }

  logout(camera: CameraConfig, base: RpcBase, session: string) {
    return this.post(camera, base, { method: "global.logout", params: null, session }).catch(() => undefined);
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
