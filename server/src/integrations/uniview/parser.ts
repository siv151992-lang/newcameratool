import { aggregate } from "../storageMath.js";
import { COMMON_STATUSES, MIB, isAbsentStatus, parseByteCount, statusMapper } from "../parsing.js";
import { CameraApiError, type StorageDeviceStatus, type StorageReading } from "../types.js";

/**
 * Parsing for Uniview LAPI storage JSON:
 *
 *   { "Disks": [ { "ID": 1, "Name": "sdcard0", "Status": "Normal", "Type": "Local",
 *                  "TotalCapacity": 128000, "UsedCapacity": 64500, "FreeCapacity": 63500 } ] }
 *
 * LAPI usually wraps payloads in { "Response": { "StatusCode": 0, "Data": { ... } } }; both the
 * wrapped and the bare form are accepted. Capacities are megabytes (MiB) and normalised to bytes.
 * Key lookup is case-insensitive because firmware versions disagree on casing.
 */

export const mapUniviewStatus = statusMapper({
  healthy: [...COMMON_STATUSES.healthy, "recording"],
  degraded: [...COMMON_STATUSES.degraded],
  unhealthy: [...COMMON_STATUSES.unhealthy, "unformat", "nospace", "invalid"],
});

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => !!v && typeof v === "object" && !Array.isArray(v);

function field(obj: JsonObject | undefined, ...names: string[]): unknown {
  if (!obj) return undefined;
  for (const name of names) {
    const key = Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key !== undefined) return obj[key];
  }
  return undefined;
}

function str(obj: JsonObject, ...names: string[]): string | undefined {
  const v = field(obj, ...names);
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

export function parseUniviewStorage(body: string): StorageReading {
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    throw new CameraApiError("INVALID_RESPONSE", "The camera did not return valid JSON");
  }
  if (!isObject(doc)) throw new CameraApiError("INVALID_RESPONSE", "Unexpected JSON response: expected an object");

  let data: unknown = doc;
  const response = field(doc, "Response");
  if (isObject(response)) {
    const code = field(response, "StatusCode");
    if (code !== undefined && Number(code) !== 0) {
      const msg = str(response, "StatusString") ?? `status code ${String(code)}`;
      throw new CameraApiError(/not ?support|not ?found/i.test(msg) ? "API_UNAVAILABLE" : "API_ERROR", `Camera reported: ${msg}`);
    }
    data = field(response, "Data");
  }

  const disks = isObject(data) ? field(data, "Disks", "DiskList", "DiskInfoList") : undefined;
  if (!Array.isArray(disks)) {
    throw new CameraApiError("INVALID_RESPONSE", "Unexpected JSON response: no \"Disks\" list");
  }

  const devices = disks
    .filter(isObject)
    .filter((d) => !isAbsentStatus(str(d, "Status")))
    .map(toDevice);
  return aggregate(devices);
}

function toDevice(disk: JsonObject, index: number): StorageDeviceStatus {
  const id = str(disk, "ID", "Id") ?? String(index + 1);
  const rawStatus = str(disk, "Status");
  const totalBytes = parseByteCount(field(disk, "TotalCapacity"), MIB);
  let freeBytes = parseByteCount(field(disk, "FreeCapacity"), MIB);
  const usedBytes = parseByteCount(field(disk, "UsedCapacity"), MIB);
  // Some firmware omits FreeCapacity; derive it from UsedCapacity when that is consistent.
  if (freeBytes === undefined && totalBytes !== undefined && usedBytes !== undefined && usedBytes <= totalBytes) {
    freeBytes = totalBytes - usedBytes;
  }
  return {
    id: `disk-${id}`,
    name: str(disk, "Name") ?? `disk-${id}`,
    type: str(disk, "Type"),
    healthStatus: mapUniviewStatus(rawStatus),
    rawStatus,
    totalBytes,
    freeBytes,
  };
}
