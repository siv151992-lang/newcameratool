import { combineRecording, recordingMapper } from "../recording.js";
import { aggregate } from "../storageMath.js";
import { COMMON_STATUSES, MIB, isAbsentStatus, parseByteCount, parseKeyValueLines, statusMapper } from "../parsing.js";
import { CameraApiError, type DeviceInfo, type RecordingReading, type StorageDeviceStatus, type StorageReading } from "../types.js";

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

/** Groups Storage.S<n>.* parameters by disk; throws for error bodies and unrelated text. */
function storageGroups(body: string): AxisGroup[] {
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
  return [...groups.values()]
    .sort((a, b) => a.index - b.index)
    .filter((g) => !isAbsentStatus(g.fields.get("drivestatus")));
}

export function parseAxisStorage(body: string): StorageReading {
  return aggregate(storageGroups(body).map(toDevice));
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

export const mapAxisRecording = recordingMapper({
  recording: ["recording", "active"],
  idle: ["notrecording", "stopped", "inactive", "suspended"],
  error: ["error", "failed"],
});

/**
 * Reads recording status from the same Storage parameter group:
 *   Storage.S0.RecordingStatus=Recording      (Recording | NotRecording)
 *   Storage.S0.RecordingState=active          (active | inactive | suspended)
 * Disks that report neither are left out; a camera reporting none at all is "unknown".
 */
export function parseAxisRecording(body: string): RecordingReading {
  const channels = storageGroups(body).flatMap((g) => {
    const rawStatus = g.fields.get("recordingstatus") || g.fields.get("recordingstate") || undefined;
    return rawStatus === undefined ? [] : [{ id: `S${g.index}`, state: mapAxisRecording(rawStatus), rawStatus }];
  });
  return combineRecording(channels);
}

/** "2026-10-24T13:30:00.123+05:30" → local wall-clock ms and the offset (ms) it states. */
function axisLocal(raw: string | undefined): { local: number; offset: number } | undefined {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/.exec(raw?.trim() ?? "");
  if (!m) return undefined;
  const local = Date.parse(`${m[1]}Z`);
  const z = m[2];
  const offset = !z || z === "Z" ? 0 : (z[0] === "-" ? -1 : 1) * (Number(z.slice(1, 3)) * 60 + Number(z.slice(-2))) * 60_000;
  return { local, offset };
}

/**
 * record/list.cgi → recordings on the camera's storage in local time (starttimelocal), with their
 * ids; an ongoing recording (no stop time) ends now. offsetMs: local time minus UTC.
 */
export function parseAxisRecordings(xml: string, nowUtcMs: number): { segments: { start: number; end: number; ref: string }[]; offsetMs: number } {
  const segments: { start: number; end: number; ref: string }[] = [];
  let offsetMs = 0;
  for (const m of xml.matchAll(/<recording\b([^>]*)>/g)) {
    const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(m[1]!)?.[1];
    const id = attr("recordingid");
    const start = axisLocal(attr("starttimelocal")) ?? axisLocal(attr("starttime"));
    if (!id || !start) continue;
    offsetMs = start.offset;
    const stop = axisLocal(attr("stoptimelocal")) ?? axisLocal(attr("stoptime"));
    const end = stop ? stop.local : nowUtcMs + start.offset;
    if (end > start.local) segments.push({ start: start.local, end, ref: id });
  }
  return { segments, offsetMs };
}
