import { combineRecording, flagToRecordingState } from "../recording.js";
import { aggregate } from "../storageMath.js";
import { COMMON_STATUSES, MIB, isAbsentStatus, parseByteCount, statusMapper } from "../parsing.js";
import {
  CameraApiError,
  type DeviceInfo,
  type NvrChannel,
  type RecordingChannelStatus,
  type RecordingReading,
  type StorageDeviceStatus,
  type StorageReading,
} from "../types.js";

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

/**
 * Parses a LAPI body and returns its payload: Response.Data when wrapped (or Response itself when
 * the fields sit directly in it, as some status endpoints do), the document otherwise.
 * A non-zero Response.StatusCode is raised as a classified error.
 */
function unwrapLapi(body: string): unknown {
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
      const msg = str(response, "ResponseString") ?? str(response, "StatusString") ?? `status code ${String(code)}`;
      // e.g. ResponseCode 4 / StatusCode 8: "Not Supported" / "UnSupport" (IPC815SB-ADF14K-I0).
      const unsupported = /not ?support|unsupport|not ?found/i.test(`${msg} ${str(response, "StatusString") ?? ""}`);
      const errorCode = unsupported ? "API_UNAVAILABLE"
        : /unauthori[sz]ed|not ?authori[sz]ed|no ?permission|forbidden/i.test(msg) ? "PERMISSION_DENIED"
        : "API_ERROR";
      throw new CameraApiError(errorCode, `Camera reported: ${msg}`);
    }
    data = field(response, "Data") ?? response;
  }
  return data;
}

/** Returns the classified error described by a LAPI error body, if it is one. */
export function parseUniviewError(body: string): CameraApiError | undefined {
  try {
    unwrapLapi(body);
    return undefined;
  } catch (e) {
    return e instanceof CameraApiError && e.code !== "INVALID_RESPONSE" ? e : undefined;
  }
}

/**
 * Disk status codes in Storage/Containers/DetailInfos, as in Uniview's NETDEV SDK
 * (NETDEV_HDD_STATUS_E). 3 is confirmed on an IPC815SB-ADF14K-I0 recording to its SD card.
 */
const CONTAINER_STATUS: Record<string, { label: string; health: StorageDeviceStatus["healthStatus"] }> = {
  "1": { label: "Not formatted", health: "unhealthy" },
  "2": { label: "Formatted", health: "healthy" },
  "3": { label: "Recordable", health: "healthy" },
  "4": { label: "Abnormal", health: "unhealthy" },
  "5": { label: "Suspended", health: "degraded" },
  "6": { label: "Formatting", health: "degraded" },
  "7": { label: "Repairing", health: "degraded" },
};

/** Device lists in Storage/Containers/DetailInfos and the type each holds. */
const CONTAINER_LISTS: [string, string][] = [
  ["SDList", "SD"], ["LocalHDDList", "HDD"], ["eSATAList", "eSATA"], ["NASList", "NAS"], ["IPSANList", "IPSAN"],
  ["ArrayList", "Array"], ["ExtendCabinet1HDDList", "HDD"], ["ExtendCabinet2HDDList", "HDD"],
];

/**
 * Parses GET /LAPI/V1.0/Storage/Containers/DetailInfos (confirmed on IPC815SB-ADF14K-I0):
 *   { "Response": { "Data": { "SDNum": 1, "SDList": [ { "ID": 1, "RemainCapacity": 37298,
 *       "TotalCapacity": 243712, "Status": 3, "Property": 0, ... } ], "LocalHDDList": [], ... } } }
 * Capacities are MiB. Status 0 (not detected) is an empty slot and is skipped.
 */
export function parseUniviewContainers(body: string): StorageReading {
  const data = unwrapLapi(body);
  if (!isObject(data) || !CONTAINER_LISTS.some(([name]) => field(data, name) !== undefined)) {
    throw new CameraApiError("INVALID_RESPONSE", "Unexpected JSON response: no storage lists (SDList, LocalHDDList, ...)");
  }
  const devices: StorageDeviceStatus[] = [];
  for (const [name, type] of CONTAINER_LISTS) {
    const list = field(data, name);
    if (!Array.isArray(list)) continue;
    list.filter(isObject).forEach((disk, i) => {
      const code = str(disk, "Status");
      if (code === "0") return; // not detected: no card in this slot
      const known = code === undefined ? undefined : CONTAINER_STATUS[code];
      const id = str(disk, "ID", "Id") ?? String(i + 1);
      devices.push({
        id: `${type.toLowerCase()}-${id}`,
        name: type === "SD" ? `SD card ${id}` : `${type} ${id}`,
        type,
        healthStatus: known?.health ?? "unknown",
        rawStatus: known ? `${known.label} (${code})` : code === undefined ? undefined : `Status ${code}`,
        totalBytes: parseByteCount(field(disk, "TotalCapacity"), MIB),
        freeBytes: parseByteCount(field(disk, "RemainCapacity", "FreeCapacity"), MIB),
      });
    });
  }
  return aggregate(devices);
}

export function parseUniviewStorage(body: string): StorageReading {
  const data = unwrapLapi(body);
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

/** Parses GET /LAPI/V1.0/System/DeviceInfo. */
export function parseUniviewDeviceInfo(body: string): DeviceInfo {
  const data = unwrapLapi(body);
  if (!isObject(data)) throw new CameraApiError("INVALID_RESPONSE", "Unexpected JSON response: no device information");
  return {
    deviceName: str(data, "DeviceName", "Name"),
    model: str(data, "DeviceModel", "Model"),
    serialNumber: str(data, "SerialNumber", "SerialNo"),
    firmwareVersion: str(data, "FirmwareVersion", "SoftwareVersion"),
    macAddress: str(data, "MAC", "MacAddress"),
  };
}

/**
 * Parses GET /LAPI/V1.0/Storage/Status:
 *   { "Response": { "RecordingStatus": "True", "StreamType": "MainStream", "TriggerType": "Continuous" } }
 * RecordingStatus is True/False, or 1 (recording), 2 (alarm recording), 0 (not recording).
 * A list of per-channel objects carrying RecordingStatus is also accepted.
 */
export function parseUniviewRecording(body: string): RecordingReading {
  const data = unwrapLapi(body);
  if (!isObject(data)) throw new CameraApiError("INVALID_RESPONSE", "Unexpected JSON response: no recording status");

  const toChannel = (obj: JsonObject, id: string): RecordingChannelStatus | undefined => {
    const raw = field(obj, "RecordingStatus", "RecordStatus");
    if (raw === undefined || raw === null || typeof raw === "object") return undefined;
    const rawStatus = String(raw);
    const mode = [str(obj, "TriggerType", "RecordType"), str(obj, "StreamType")].filter(Boolean).join(", ") || undefined;
    return { id, state: flagToRecordingState(rawStatus), rawStatus, mode };
  };

  const single = toChannel(data, "channel-1");
  if (single) return combineRecording([single]);
  const list = Object.values(data).find((v): v is unknown[] => Array.isArray(v) && v.some((i) => isObject(i) && toChannel(i, "") !== undefined));
  if (!list) throw new CameraApiError("INVALID_RESPONSE", "Unexpected JSON response: no RecordingStatus field");
  const channels = list
    .filter(isObject)
    .map((item, i) => toChannel(item, `channel-${str(item, "ID", "ChannelID", "Id") ?? i + 1}`))
    .filter((c): c is RecordingChannelStatus => c !== undefined);
  return combineRecording(channels);
}

/**
 * An NVR's channels: GET /LAPI/V1.0/Channels/System/BasicInfos, a list of channels with their ID,
 * Name and Status (1 or "Online" when the NVR has video from the camera). Field names vary by
 * firmware, so the usual alternatives are read.
 */
export function parseUniviewChannels(body: string): NvrChannel[] {
  const data = unwrapLapi(body);
  const listed = Array.isArray(data)
    ? data
    : isObject(data)
      ? (Object.values(data).find((v) => Array.isArray(v)) as unknown[] | undefined) ?? []
      : [];
  const channels = listed.filter(isObject).flatMap((c): NvrChannel[] => {
    const id = Number(field(c, "ID", "ChannelID", "Id"));
    if (!Number.isInteger(id) || id < 1) return [];
    const status = field(c, "Status", "OnlineStatus", "IsOnline", "Online");
    const online = status === undefined ? undefined : status === 1 || status === true || /^(1|online|true)$/i.test(String(status));
    return [{ channel: id, name: str(c, "Name", "ChannelName"), online }];
  });
  if (channels.length === 0) throw new CameraApiError("INVALID_RESPONSE", "The device reported no channels");
  return channels.sort((a, b) => a.channel - b.channel);
}
