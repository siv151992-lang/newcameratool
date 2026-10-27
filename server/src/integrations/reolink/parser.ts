import { aggregate } from "../storageMath.js";
import { CameraApiError, type DeviceInfo, type NvrChannel, type StorageDeviceStatus, type StorageReading } from "../types.js";

/**
 * Reolink's HTTP API (/cgi-bin/api.cgi) answers a JSON list, one entry per command:
 *   [{ "cmd": "GetHddInfo", "code": 0, "value": { … } }]
 *   [{ "cmd": "Login", "code": 1, "error": { "detail": "login failed", "rspCode": -7 } }]
 */
interface ReolinkEntry {
  cmd?: string;
  code?: number;
  value?: Record<string, unknown>;
  error?: { detail?: string; rspCode?: number };
}

/** The value of the command's answer; throws a classified error for an error answer. */
export function reolinkValue(body: string, cmd: string): Record<string, unknown> {
  let list: unknown;
  try {
    list = JSON.parse(body);
  } catch {
    throw new CameraApiError("INVALID_RESPONSE", `The camera's answer to ${cmd} is not JSON`);
  }
  const entry = (Array.isArray(list) ? list : [list]).find((e): e is ReolinkEntry => !!e && typeof e === "object" && ((e as ReolinkEntry).cmd ?? cmd) === cmd);
  if (!entry) throw new CameraApiError("INVALID_RESPONSE", `The camera did not answer ${cmd}`);
  if (entry.code !== 0 || entry.error) {
    const rsp = entry.error?.rspCode;
    const detail = entry.error?.detail ?? "refused";
    // -6 / -7: not logged in, login failed; -9 not supported; -26 / -27: user rights.
    if (rsp === -6 || rsp === -7 || /login|password|user/i.test(detail)) throw new CameraApiError("AUTH_FAILED", `The camera refused the login (${detail})`);
    if (rsp === -9 || /not support/i.test(detail)) throw new CameraApiError("API_UNAVAILABLE", `The camera does not support ${cmd} (${detail})`);
    if (rsp === -26 || rsp === -27 || /permission|ability|right/i.test(detail)) throw new CameraApiError("PERMISSION_DENIED", `The camera user may not use ${cmd} (${detail})`);
    throw new CameraApiError("API_ERROR", `The camera refused ${cmd} (${detail}${rsp !== undefined ? `, ${rsp}` : ""})`);
  }
  return entry.value ?? {};
}

const MB = 1024 * 1024;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);

/** GetHddInfo: HddInfo[] with capacity and size (free) in MB, format and mount flags (1 = yes). */
export function parseReolinkStorage(value: Record<string, unknown>): StorageReading {
  const list = Array.isArray(value.HddInfo) ? value.HddInfo : [];
  const devices = list.flatMap((h, i): StorageDeviceStatus[] => {
    if (!h || typeof h !== "object") return [];
    const d = h as Record<string, unknown>;
    const total = num(d.capacity);
    const free = num(d.size);
    const formatted = d.format === undefined ? undefined : d.format === 1;
    const mounted = d.mount === undefined ? undefined : d.mount === 1;
    const kind = d.storageType === 1 ? "HDD" : d.storageType === 2 ? "SD card" : undefined;
    const raw = formatted === false ? "unformatted" : mounted === false ? "not mounted" : "ok";
    return [{
      id: String(d.id ?? i),
      name: kind ? `${kind} ${Number(d.id ?? i) + 1}` : `Storage ${Number(d.id ?? i) + 1}`,
      type: kind,
      healthStatus: raw === "ok" ? "healthy" : "unhealthy",
      rawStatus: raw,
      totalBytes: total !== undefined ? total * MB : undefined,
      freeBytes: free !== undefined && total !== undefined ? Math.min(free, total) * MB : undefined,
    }];
  });
  return aggregate(devices);
}

/** GetDevInfo: DevInfo { model, serial, firmVer, name }. */
export function parseReolinkDeviceInfo(value: Record<string, unknown>): DeviceInfo {
  const d = (value.DevInfo ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return { model: str(d.model), serialNumber: str(d.serial), firmwareVersion: str(d.firmVer), deviceName: str(d.name) };
}

/** NVR GetChannelstatus: status[] { channel (from 0), name, online (1/0) }. */
export function parseReolinkChannels(value: Record<string, unknown>): NvrChannel[] {
  const list = Array.isArray(value.status) ? value.status : [];
  return list
    .filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && typeof (c as Record<string, unknown>).channel === "number")
    .map((c) => ({
      channel: (c.channel as number) + 1,
      ...(typeof c.name === "string" && c.name.trim() ? { name: c.name.trim() } : {}),
      ...(c.online === 1 || c.online === 0 ? { online: c.online === 1 } : {}),
    }))
    .sort((a, b) => a.channel - b.channel);
}
