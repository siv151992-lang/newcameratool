import { aggregate } from "../storageMath.js";
import { COMMON_STATUSES, MIB, isAbsentStatus, parseByteCount, parseKeyValueLines, statusMapper } from "../parsing.js";
import { CameraApiError, type DeviceInfo, type StorageDeviceStatus, type StorageReading } from "../types.js";

/**
 * Parsing for Axis plain-text CGI storage parameters:
 *
 *   Storage.S0.DriveStatus=Normal
 *   Storage.S0.TotalSize=122048
 *   Storage.S0.WearLevel=12
 *
 * param.cgi prefixes every name with "root." (root.Storage.S0.DriveStatus); both forms are accepted.
 * Each `S<n>` group is one disk. Sizes are megabytes (MiB): a 128 GB card reports ≈ 122048.
 * TotalSize is the only size the reference payload carries, so usage is computed only when the
 * firmware also reports FreeSize or UsedSize; otherwise the disk is listed with its status and
 * capacity and no usage figure is invented.
 */

export const mapAxisStatus = statusMapper({
  healthy: [...COMMON_STATUSES.healthy],
  degraded: [...COMMON_STATUSES.degraded],
  unhealthy: [...COMMON_STATUSES.unhealthy, "wornout", "nospace", "disconnected"],
});

const KEY = /^(?:root\.)?Storage\.S(\d+)\.(\w+)$/i;

interface AxisGroup {
  index: number;
  fields: Map<string, string>; // lower-cased property name -> value (last one wins)
}

export function parseAxisStorage(body: string): StorageReading {
  const groups = new Map<number, AxisGroup>();
  for (const [key, value] of parseKeyValueLines(body)) {
    const m = KEY.exec(key);
    if (!m) continue;
    const index = Number(m[1]);
    let group = groups.get(index);
    if (!group) groups.set(index, (group = { index, fields: new Map() }));
    group.fields.set(m[2]!.toLowerCase(), value);
  }
  if (groups.size === 0) {
    const error = parseAxisError(body);
    if (error) throw error;
    throw new CameraApiError("INVALID_RESPONSE", "The camera response contains no Storage.S<n> parameters");
  }

  const devices = [...groups.values()]
    .sort((a, b) => a.index - b.index)
    .filter((g) => !isAbsentStatus(g.fields.get("drivestatus")))
    .map(toDevice);
  return aggregate(devices);
}

function toDevice({ index, fields }: AxisGroup): StorageDeviceStatus {
  const rawStatus = fields.get("drivestatus") || undefined;
  const totalBytes = parseByteCount(fields.get("totalsize"), MIB);
  let freeBytes = parseByteCount(fields.get("freesize"), MIB);
  const usedBytes = parseByteCount(fields.get("usedsize"), MIB);
  // Only UsedSize reported: derive free space from it (aggregate() then derives used again).
  if (freeBytes === undefined && totalBytes !== undefined && usedBytes !== undefined && usedBytes <= totalBytes) {
    freeBytes = totalBytes - usedBytes;
  }
  return {
    id: `S${index}`,
    name: fields.get("name") || fields.get("diskid") || `S${index}`,
    type: fields.get("type") || undefined,
    healthStatus: mapAxisStatus(rawStatus),
    rawStatus,
    totalBytes,
    freeBytes,
    formatType: fields.get("filesystem") || undefined,
  };
}

/** VAPIX reports failures as a plain-text "# Error: ..." or "Error: ..." body. */
export function parseAxisError(body: string): CameraApiError | undefined {
  const error = /^#?\s*error\b[:\s-]*(.*)$/im.exec(body);
  if (!error) return undefined;
  const reason = error[1]?.trim() || "Error";
  // e.g. "# Error: Error -1 getting param in group 'Storage'" when the device has no storage group.
  const code = /getting param|not found|no such|not supported/i.test(reason) ? "API_UNAVAILABLE" : "API_ERROR";
  return new CameraApiError(code, `Camera reported: ${reason}`);
}

/** Parses param.cgi?action=list&group=Brand,Properties. */
export function parseAxisDeviceInfo(body: string): DeviceInfo {
  const fields = new Map<string, string>();
  for (const [key, value] of parseKeyValueLines(body)) fields.set(key.replace(/^root\./i, "").toLowerCase(), value);
  if (fields.size === 0) {
    throw parseAxisError(body) ?? new CameraApiError("INVALID_RESPONSE", "The camera response contains no parameters");
  }
  const get = (k: string) => fields.get(k.toLowerCase()) || undefined;
  const serial = get("Properties.System.SerialNumber");
  return {
    deviceName: get("Brand.ProdFullName") ?? get("Brand.ProdShortName"),
    model: get("Brand.ProdNbr"),
    serialNumber: serial,
    firmwareVersion: get("Properties.Firmware.Version"),
    // Axis serial numbers are the device's MAC address.
    macAddress: serial && /^[0-9a-f]{12}$/i.test(serial) ? serial.match(/../g)!.join(":").toUpperCase() : undefined,
  };
}
