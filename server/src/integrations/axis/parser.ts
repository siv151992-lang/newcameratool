import { aggregate } from "../storageMath.js";
import { COMMON_STATUSES, MIB, isAbsentStatus, parseByteCount, parseKeyValueLines, statusMapper } from "../parsing.js";
import { CameraApiError, type StorageDeviceStatus, type StorageReading } from "../types.js";

/**
 * Parsing for Axis plain-text CGI storage parameters:
 *
 *   Storage.S0.DriveStatus=Normal
 *   Storage.S0.TotalSize=122048
 *   Storage.S0.WearLevel=12
 *
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

const KEY = /^Storage\.S(\d+)\.(\w+)$/i;

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
    // VAPIX reports failures as a plain-text "# Error: ..." or "Error: ..." body.
    const error = /^#?\s*error\b[:\s-]*(.*)$/im.exec(body);
    if (error) throw new CameraApiError("API_ERROR", `Camera reported: ${error[1]?.trim() || "Error"}`);
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
