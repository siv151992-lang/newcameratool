import { combineRecording, flagToRecordingState } from "../recording.js";
import { aggregate } from "../storageMath.js";
import { COMMON_STATUSES, isAbsentStatus, parseBoolean, parseByteCount, parseKeyValueLines, statusMapper } from "../parsing.js";
import {
  CameraApiError,
  type DeviceInfo,
  type RecordingChannelStatus,
  type RecordingReading,
  type StorageDeviceStatus,
  type StorageReading,
} from "../types.js";

/**
 * Parsing for Dahua (and OEM: CP Plus, Amcrest) storageDevice.cgi flat lists:
 *
 *   list.info.Name=/dev/sda
 *   list.info.State=Success
 *   list.info.Detail.IsError=false
 *   list.info.Detail.TotalBytes=1495797858304
 *   list.info.Detail.UsedBytes=643829104128
 *   list.info.Name=/dev/sdb
 *   list.info.State=Absent
 *
 * Two shapes are accepted:
 * - indexed, as most firmware sends it: `list.info[0].Detail[1].TotalBytes=...`
 * - unindexed, as in the reference sheet: a repeated `list.info.Name` starts the next disk and a
 *   repeated Detail property starts the next partition.
 *
 * Line breaks may arrive as real CR/LF or as literal escaped "\r\n" text (seen when the body has
 * been JSON-encoded or logged by a proxy); both are normalised. Sizes are bytes and may carry a
 * decimal part ("1495797858304.000000"). Partitions are summed per disk and free space is
 * total - used. Slots reported as Absent have no disk and are left out.
 */

export const mapDahuaStatus = statusMapper({
  healthy: [...COMMON_STATUSES.healthy],
  degraded: [...COMMON_STATUSES.degraded],
  unhealthy: [...COMMON_STATUSES.unhealthy, "unknown error", "nopartition"],
});

const LINE = /^list\.info(?:\[(\d+)\])?\.(?:Detail(?:\[(\d+)\])?\.)?(\w+)$/i;

interface Partition {
  fields: Map<string, string>;
}

interface Disk {
  fields: Map<string, string>;
  partitions: Map<string, Partition>;
}

/** Turns literal "\r\n" / "\n" / "\r" escape sequences into real line breaks. */
export function unescapeLineBreaks(body: string): string {
  return body.replace(/\\+r\\+n|\\+n|\\+r/g, "\n");
}

/** Dahua CGI errors look like "Error\r\nBad Request!" (or "Error: ..."). */
export function parseDahuaError(body: string): CameraApiError | undefined {
  const text = unescapeLineBreaks(body).trim();
  if (!/^error\b/i.test(text)) return undefined;
  const reason = text.replace(/^error\b[:\s]*/i, "").split("\n")[0]?.trim();
  // Firmware without the requested CGI action answers "Bad Request!".
  const notFound = /not ?found|not ?support|bad request/i.test(reason ?? "");
  return new CameraApiError(notFound ? "API_UNAVAILABLE" : "API_ERROR", `Camera reported: ${reason || "Error"}`);
}

export function parseDahuaStorage(body: string): StorageReading {
  const error = parseDahuaError(body);
  if (error) throw error;
  const text = unescapeLineBreaks(body).trim();

  const disks = collectDisks(text);
  if (disks.length === 0) {
    throw new CameraApiError("INVALID_RESPONSE", "The camera response contains no list.info entries");
  }
  const devices = disks
    .filter((d) => !isAbsentStatus(d.fields.get("state")))
    .map(toDevice);
  return aggregate(devices);
}

function collectDisks(text: string): Disk[] {
  const indexed = new Map<string, Disk>();
  const sequential: Disk[] = [];
  const newDisk = (): Disk => ({ fields: new Map(), partitions: new Map() });

  for (const [key, value] of parseKeyValueLines(text)) {
    const m = LINE.exec(key);
    if (!m) continue;
    const [, diskIndex, partIndex, rawProp] = m;
    const prop = rawProp!.toLowerCase();
    const isDetail = /\.Detail(\[\d+\])?\./i.test(key);

    let disk: Disk;
    if (diskIndex !== undefined) {
      disk = indexed.get(diskIndex) ?? newDisk();
      indexed.set(diskIndex, disk);
    } else {
      let current = sequential.at(-1);
      // A repeated disk-level property (normally Name) means the next disk has started.
      if (!current || (!isDetail && current.fields.has(prop))) sequential.push((current = newDisk()));
      disk = current;
    }

    if (!isDetail) {
      disk.fields.set(prop, value);
      continue;
    }
    let partKey = partIndex;
    if (partKey === undefined) {
      const last = [...disk.partitions.keys()].at(-1);
      // Unindexed detail: a repeated property means the next partition has started.
      partKey = last === undefined || disk.partitions.get(last)!.fields.has(prop) ? `#${disk.partitions.size}` : last;
    }
    const partition = disk.partitions.get(partKey) ?? { fields: new Map() };
    disk.partitions.set(partKey, partition);
    partition.fields.set(prop, value);
  }

  const ordered = [...indexed.entries()].sort(([a], [b]) => Number(a) - Number(b)).map(([, d]) => d);
  return [...ordered, ...sequential];
}

function toDevice(disk: Disk, index: number): StorageDeviceStatus {
  const name = disk.fields.get("name") || undefined;
  const rawStatus = disk.fields.get("state") || undefined;
  const partitions = [...disk.partitions.values()];

  let totalBytes: number | undefined;
  let usedBytes: number | undefined;
  const sizes = partitions.map((p) => ({
    total: parseByteCount(p.fields.get("totalbytes")),
    used: parseByteCount(p.fields.get("usedbytes")),
  }));
  // Only sum when every partition is readable; a partial sum would understate usage.
  if (sizes.length > 0 && sizes.every((s) => s.total !== undefined && s.used !== undefined)) {
    totalBytes = sizes.reduce((sum, s) => sum + s.total!, 0);
    usedBytes = sizes.reduce((sum, s) => sum + s.used!, 0);
  }
  const freeBytes = totalBytes !== undefined && usedBytes !== undefined && usedBytes <= totalBytes ? totalBytes - usedBytes : undefined;

  const reportsError = partitions.some((p) => parseBoolean(p.fields.get("iserror")) === true);
  const readOnly = partitions.some((p) => parseBoolean(p.fields.get("isreadonly")) === true);
  return {
    id: name ? `disk-${name.replace(/^\/dev\//, "")}` : `disk-${index + 1}`,
    name,
    type: partitions[0]?.fields.get("type") || undefined,
    healthStatus: reportsError ? "unhealthy" : mapDahuaStatus(rawStatus),
    rawStatus,
    totalBytes,
    freeBytes,
    writable: readOnly ? false : undefined,
  };
}

/** Parses magicBox.cgi?action=getSystemInfo (deviceType=..., serialNumber=..., ...). */
export function parseDahuaDeviceInfo(body: string): DeviceInfo {
  const error = parseDahuaError(body);
  if (error) throw error;
  const fields = new Map<string, string>();
  for (const [key, value] of parseKeyValueLines(unescapeLineBreaks(body))) fields.set(key.toLowerCase(), value);
  if (fields.size === 0) throw new CameraApiError("INVALID_RESPONSE", "The camera response contains no system information");
  const get = (k: string) => fields.get(k.toLowerCase()) || undefined;
  return {
    deviceName: get("deviceName") ?? get("machineName"),
    model: get("deviceType") ?? get("updateSerial"),
    serialNumber: get("serialNumber"),
    firmwareVersion: get("version") ?? get("softwareVersion"),
  };
}

const RECORD_LINE = /^(?:status\.)?Channels?\[(\d+)\]\.(\w+)$/i;

/**
 * Parses record.cgi?action=getRecordStatus:
 *   status.Channels[0].RecordStatus=1     0 = stopped, 1 = recording, 2 = alarm recording
 *   status.Channels[0].Mode=Manual        Manual | Auto | Schedule
 * Trailing "# ..." annotations (as in documentation samples) are ignored.
 */
export function parseDahuaRecording(body: string): RecordingReading {
  const error = parseDahuaError(body);
  if (error) throw error;
  const channels = new Map<number, { status?: string; mode?: string }>();
  for (const [key, rawValue] of parseKeyValueLines(unescapeLineBreaks(body))) {
    const m = RECORD_LINE.exec(key);
    if (!m) continue;
    const value = rawValue.replace(/\s+#.*$/, "").trim();
    const ch = channels.get(Number(m[1])) ?? {};
    channels.set(Number(m[1]), ch);
    const prop = m[2]!.toLowerCase();
    if (prop === "recordstatus" || prop === "status") ch.status = value;
    else if (prop === "mode") ch.mode = value;
  }
  if (channels.size === 0) throw new CameraApiError("INVALID_RESPONSE", "The camera response contains no channel recording status");
  const list: RecordingChannelStatus[] = [...channels.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, ch]) => ({
      id: `channel-${index + 1}`,
      state: flagToRecordingState(ch.status),
      rawStatus: ch.status === "2" ? "2 (alarm)" : ch.status,
      mode: ch.mode || undefined,
    }));
  return combineRecording(list);
}

/** "2026-10-24 14:00:00" (camera local time) as a wall-clock instant. */
export function dahuaTimeMs(raw: string | undefined): number | undefined {
  const m = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(raw ?? "");
  return m ? Date.parse(`${m[1]}T${m[2]}Z`) : undefined;
}

/** A wall-clock instant as Dahua writes it in queries ("2026-10-24 14:00:00") or playback URLs ("2026_10_24_14_00_00"). */
export const dahuaTime = (ms: number, sep: " " | "_" = " ") => {
  const t = new Date(ms).toISOString().slice(0, 19);
  return sep === " " ? t.replace("T", " ") : t.replace(/[-T:]/g, "_");
};

/** mediaFileFind.cgi?action=findNextFile → the files' start and end times, and how many were found. */
export function parseDahuaFiles(body: string): { found: number; segments: { start: number; end: number }[] } {
  const found = Number(/^found=(\d+)/m.exec(body)?.[1] ?? 0);
  const items = new Map<string, { start?: number; end?: number }>();
  for (const m of body.matchAll(/^items\[(\d+)\]\.(StartTime|EndTime)=(.+)$/gm)) {
    const item = items.get(m[1]!) ?? {};
    if (m[2] === "StartTime") item.start = dahuaTimeMs(m[3]);
    else item.end = dahuaTimeMs(m[3]);
    items.set(m[1]!, item);
  }
  const segments = [...items.values()].filter((i): i is { start: number; end: number } => i.start !== undefined && i.end !== undefined && i.end > i.start);
  return { found, segments };
}
