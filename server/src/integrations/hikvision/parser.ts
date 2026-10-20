import { XMLParser, XMLValidator } from "fast-xml-parser";
import { combineRecording, recordingMapper } from "../recording.js";
import { aggregate } from "../storageMath.js";
import {
  CameraApiError,
  type DeviceHealth,
  type DeviceInfo,
  type RecordingReading,
  type StorageDeviceStatus,
  type StorageReading,
} from "../types.js";

/**
 * Parsing for Hikvision ISAPI responses.
 *
 * Units: ISAPI reports <capacity> and <freeSpace> in megabytes (MiB, 1024*1024 bytes).
 * e.g. a 128 GB microSD card reports capacity ≈ 121942. Values are normalised to bytes.
 *
 * Fields are optional: firmware versions differ, so every value is validated and missing or
 * non-numeric values are left undefined rather than guessed.
 */

export const MIB = 1024 * 1024;

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,   // keep raw strings; numbers are validated explicitly
  trimValues: true,
  isArray: (name) => name === "hdd" || name === "nas" || name === "TrackStatus",
});

// Status strings documented/observed for ISAPI <hdd><status>.
const HEALTHY = new Set(["ok", "idle", "normal", "inuse", "sleep", "sleeping"]);
const DEGRADED = new Set(["formating", "formatting", "reparing", "repairing", "initializing"]);
const UNHEALTHY = new Set([
  "error", "unformatted", "uninitialized", "mismatch", "offline", "smartfailed", "notexist",
  "abnormal", "exception", "unrecordhostformatted", "nospace", "readonly", "damaged", "fault",
]);

export function mapHikvisionStatus(raw: string | undefined): DeviceHealth {
  if (!raw) return "unknown";
  const s = raw.trim().toLowerCase();
  if (HEALTHY.has(s)) return "healthy";
  if (DEGRADED.has(s)) return "degraded";
  if (UNHEALTHY.has(s)) return "unhealthy";
  return "unknown";
}

type XmlNode = Record<string, unknown>;

function text(node: XmlNode | undefined, key: string): string | undefined {
  const v = node?.[key];
  if (v === undefined || v === null || typeof v === "object") return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

function megabytes(node: XmlNode, key: string): number | undefined {
  const s = text(node, key);
  if (s === undefined || !/^\d+(\.\d+)?$/.test(s)) return undefined;
  return Math.round(Number(s) * MIB);
}

function parseXml(xml: string): XmlNode {
  const trimmed = xml.trim();
  if (!trimmed.startsWith("<") || XMLValidator.validate(trimmed) !== true) {
    throw new CameraApiError("INVALID_RESPONSE", "The camera did not return valid XML");
  }
  return parser.parse(trimmed) as XmlNode;
}

function findRoot(doc: XmlNode, expected: string): XmlNode {
  const key = Object.keys(doc).find((k) => k.toLowerCase() === expected.toLowerCase());
  if (key) {
    const root = doc[key];
    return root && typeof root === "object" ? (root as XmlNode) : {};
  }
  const status = Object.keys(doc).find((k) => k.toLowerCase() === "responsestatus");
  if (status) throw responseStatusError(doc[status] as XmlNode);
  throw new CameraApiError("INVALID_RESPONSE", `Unexpected XML response: expected <${expected}>`);
}

/** ISAPI reports errors as <ResponseStatus>; turn them into a classified error. */
export function responseStatusError(node: XmlNode | undefined): CameraApiError {
  const statusString = text(node, "statusString") ?? "Error";
  const sub = text(node, "subStatusCode");
  const code = text(node, "statusCode");
  const msg = `Camera reported: ${statusString}${sub ? ` (${sub})` : ""}`;
  if (sub && /notsupport|invalidoperation/i.test(sub)) return new CameraApiError("API_UNAVAILABLE", msg);
  if (code === "4" && /notsupport/i.test(sub ?? "")) return new CameraApiError("API_UNAVAILABLE", msg);
  return new CameraApiError("API_ERROR", msg);
}

function parseDevice(node: XmlNode, kind: "hdd" | "nas", index: number): StorageDeviceStatus {
  const id = text(node, "id") ?? String(index + 1);
  const rawStatus = text(node, "status");
  const property = text(node, "property");
  const prop = property?.toUpperCase();
  return {
    id: `${kind}-${id}`,
    name: text(node, kind === "hdd" ? "hddName" : "path") ?? text(node, "ipAddress"),
    type: kind === "hdd" ? text(node, "hddType") : `NAS${text(node, "mountType") ? ` (${text(node, "mountType")})` : ""}`,
    healthStatus: mapHikvisionStatus(rawStatus),
    rawStatus,
    totalBytes: megabytes(node, "capacity"),
    freeBytes: megabytes(node, "freeSpace"),
    writable: prop === "RW" || prop === "REDUND" ? true : prop === "RO" ? false : undefined,
    property,
    formatType: text(node, "formatType"),
  };
}

function list(node: XmlNode | undefined, listKey: string, itemKey: string): XmlNode[] {
  const container = node?.[listKey];
  if (!container || typeof container !== "object") return [];
  const items = (container as XmlNode)[itemKey];
  return Array.isArray(items) ? items.filter((i): i is XmlNode => !!i && typeof i === "object") : [];
}

/** Returns the classified error described by an ISAPI <ResponseStatus> body, if it is one. */
export function parseResponseStatus(xml: string): CameraApiError | undefined {
  try {
    const doc = parseXml(xml);
    const key = Object.keys(doc).find((k) => k.toLowerCase() === "responsestatus");
    return key ? responseStatusError(doc[key] as XmlNode) : undefined;
  } catch {
    return undefined;
  }
}

/** Parses GET /ISAPI/ContentMgmt/Storage. */
export function parseStorageXml(xml: string): StorageReading {
  const root = findRoot(parseXml(xml), "storage");
  const devices = [
    ...list(root, "hddList", "hdd").map((n, i) => parseDevice(n, "hdd", i)),
    ...list(root, "nasList", "nas").map((n, i) => parseDevice(n, "nas", i)),
  ];
  return aggregate(devices);
}

/** Parses GET /ISAPI/System/deviceInfo. */
export function parseDeviceInfoXml(xml: string): DeviceInfo {
  const root = findRoot(parseXml(xml), "deviceInfo");
  return {
    deviceName: text(root, "deviceName"),
    model: text(root, "model"),
    serialNumber: text(root, "serialNumber"),
    firmwareVersion: [text(root, "firmwareVersion"), text(root, "firmwareReleasedDate")].filter(Boolean).join(" ") || undefined,
    macAddress: text(root, "macAddress"),
  };
}

export const mapHikvisionRecording = recordingMapper({
  recording: ["recording", "record", "true"],
  idle: ["idle", "stop", "stopped", "notrecording", "false"],
  error: ["error", "exception", "abnormal", "fail", "failed"],
});

/**
 * Parses GET /ISAPI/ContentMgmt/Recording/status:
 *   <RecordingStatus><status>recording</status>
 *     <TrackStatusList><TrackStatus><id>101</id><videoRecordStatus>recording</videoRecordStatus>…
 * The top-level <status> wins; per-track video status is used when it is missing.
 */
export function parseRecordingStatusXml(xml: string): RecordingReading {
  const root = findRoot(parseXml(xml), "RecordingStatus");
  const overallRaw = text(root, "status");
  const tracks = list(root, "TrackStatusList", "TrackStatus").map((t, i) => {
    const rawStatus = text(t, "videoRecordStatus") ?? text(t, "status");
    return { id: `track-${text(t, "id") ?? i + 1}`, state: mapHikvisionRecording(rawStatus), rawStatus };
  });
  return combineRecording(tracks, { state: mapHikvisionRecording(overallRaw), rawStatus: overallRaw });
}
