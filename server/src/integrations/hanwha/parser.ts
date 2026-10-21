import { COMMON_STATUSES, isAbsentStatus, MIB, parseBoolean, parseKeyValueLines, statusMapper } from "../parsing.js";
import { aggregate } from "../storageMath.js";
import { CameraApiError, type DeviceInfo, type StorageDeviceStatus, type StorageReading } from "../types.js";

/**
 * Hanwha Vision (Wisenet) SUNAPI replies. Depending on firmware, a "view" request answers either with
 * plain "Key=Value" lines (e.g. "Storage.0.TotalSpace=30436") or with JSON
 * (e.g. {"Storages":[{"Storage":0,"TotalSpace":30436}]}). Both are flattened to dotted keys and read
 * the same way. Built from SUNAPI conventions and not yet confirmed on hardware, so field names are
 * matched loosely and anything ambiguous is left out rather than guessed.
 */

/** Flattens JSON into dotted keys: {"Storages":[{"TotalSpace":1}]} → "Storages.0.TotalSpace". */
function flatten(value: unknown, prefix: string, out: Map<string, string>) {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) value.forEach((v, i) => flatten(v, prefix ? `${prefix}.${i}` : String(i), out));
  else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else out.set(prefix, String(value));
}

/** SUNAPI error bodies: "NG" plus "Error Code: 600 / Error Details: ..." (or a JSON Response: Fail). */
export function parseSunapiError(body: string): CameraApiError | undefined {
  const text = body.trim();
  const code = /Error\s*Code\s*[:=]\s*(\d+)/i.exec(text)?.[1] ?? /"Code"\s*:\s*(\d+)/.exec(text)?.[1];
  const details = /Error\s*Details\s*[:=]\s*(.+)/i.exec(text)?.[1]?.trim() ?? /"Details"\s*:\s*"([^"]*)"/.exec(text)?.[1];
  if (!/^NG\b/.test(text) && !code && !/"Response"\s*:\s*"Fail"/i.test(text)) return undefined;
  const msg = `Camera reported an error${code ? ` (code ${code})` : ""}${details ? `: ${details.slice(0, 160)}` : ""}`;
  // 600/601/602: submenu or action not supported on this model or firmware.
  if (code && ["600", "601", "602"].includes(code)) return new CameraApiError("API_UNAVAILABLE", `${msg}. This camera does not provide storage information through SUNAPI.`);
  if (code === "607" || /permission|not authori[sz]ed/i.test(details ?? "")) return new CameraApiError("PERMISSION_DENIED", msg);
  return new CameraApiError("API_ERROR", msg);
}

/** Parses a SUNAPI reply (key=value text or JSON) into dotted keys. */
export function parseSunapiBody(body: string): Map<string, string> {
  const error = parseSunapiError(body);
  if (error) throw error;
  const text = body.trim();
  const out = new Map<string, string>();
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      flatten(JSON.parse(text), "", out);
    } catch {
      throw new CameraApiError("INVALID_RESPONSE", "The camera returned malformed JSON");
    }
  } else {
    for (const [k, v] of parseKeyValueLines(text)) out.set(k, v);
  }
  if (out.size === 0) throw new CameraApiError("INVALID_RESPONSE", "The camera returned an empty or unrecognised response");
  return out;
}

const STATUS = statusMapper({
  healthy: [...COMMON_STATUSES.healthy, "recording", "record", "use", "using"],
  degraded: [...COMMON_STATUSES.degraded, "format", "formatrequired"],
  unhealthy: [...COMMON_STATUSES.unhealthy, "fail", "abnormal", "notformatted", "invalid"],
});

const TOTAL = ["totalspace", "totalsize", "total", "capacity"];
const FREE = ["freespace", "freesize", "free", "remainspace", "remainsize", "remaining"];
const USED = ["usedspace", "usedsize", "used"];

/**
 * A size field: plain numbers are SUNAPI's megabytes; a unit suffix (e.g. "30 GB") is honoured.
 * Values too large to be megabytes on a camera (over 100 TB) are taken as bytes.
 */
export function parseSunapiSize(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)?\s*$/i.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2]?.toUpperCase();
  const scale: Record<string, number> = { B: 1, KB: 1024, KIB: 1024, MB: MIB, MIB: MIB, GB: 1024 * MIB, GIB: 1024 * MIB, TB: 1024 ** 4, TIB: 1024 ** 4 };
  const bytes = unit ? n * scale[unit]! : n > 100_000_000 ? n : n * MIB;
  return Number.isSafeInteger(Math.round(bytes)) ? Math.round(bytes) : undefined;
}

export function parseHanwhaStorage(body: string): StorageReading {
  const keys = parseSunapiBody(body);
  // Group "Storage.0.TotalSpace" / "Storages.0.TotalSpace" / "StorageInfo.Storages.0.TotalSpace" by slot.
  const slots = new Map<string, Map<string, string>>();
  for (const [key, value] of keys) {
    const m = /(?:^|\.)(?:storages?|storagelist|disks?|sdcards?)\.(\d+)\.([A-Za-z]+)$/i.exec(key);
    if (!m) continue;
    const slot = slots.get(m[1]!) ?? new Map<string, string>();
    slot.set(m[2]!.toLowerCase(), value);
    slots.set(m[1]!, slot);
  }
  if (slots.size === 0) {
    throw new CameraApiError("API_UNAVAILABLE", "The camera's reply contains no storage entries (Storage.N.*)");
  }
  const pick = (s: Map<string, string>, names: string[]) => names.map((n) => s.get(n)).find((v) => v !== undefined);
  const devices: StorageDeviceStatus[] = [];
  for (const [index, s] of [...slots.entries()].sort(([a], [b]) => Number(a) - Number(b))) {
    const rawStatus = s.get("status") ?? s.get("state");
    const enabled = parseBoolean(s.get("enable"));
    if (enabled === false || isAbsentStatus(rawStatus) || /^(none|nocard|notinserted|notexist)$/i.test(rawStatus ?? "")) continue;
    const totalBytes = parseSunapiSize(pick(s, TOTAL));
    let freeBytes = parseSunapiSize(pick(s, FREE));
    const usedBytes = parseSunapiSize(pick(s, USED));
    if (freeBytes === undefined && totalBytes !== undefined && usedBytes !== undefined && usedBytes <= totalBytes) freeBytes = totalBytes - usedBytes;
    const readOnly = /readonly|lock/i.test(rawStatus ?? "") || parseBoolean(s.get("readonly")) === true;
    let healthStatus = STATUS(rawStatus);
    if (readOnly && healthStatus === "healthy") healthStatus = "degraded";
    devices.push({
      id: s.get("storage") ?? index,
      name: s.get("type") ?? s.get("name"),
      type: s.get("type"),
      healthStatus,
      rawStatus,
      totalBytes: totalBytes && totalBytes > 0 ? totalBytes : undefined,
      freeBytes,
      writable: readOnly ? false : undefined,
    });
  }
  return aggregate(devices);
}

export function parseHanwhaDeviceInfo(body: string): DeviceInfo {
  const keys = parseSunapiBody(body);
  const get = (...names: string[]) => {
    for (const n of names) {
      for (const [k, v] of keys) if (k.split(".").pop()!.toLowerCase() === n.toLowerCase() && v.trim()) return v.trim();
    }
    return undefined;
  };
  const mac = get("ConnectedMACAddress", "MACAddress");
  return {
    deviceName: get("DeviceName", "DeviceDescription"),
    model: get("Model"),
    serialNumber: get("SerialNumber"),
    firmwareVersion: get("FirmwareVersion"),
    macAddress: mac ? mac.toUpperCase() : undefined,
  };
}
