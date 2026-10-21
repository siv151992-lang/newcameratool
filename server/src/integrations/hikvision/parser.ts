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
  isArray: (name) => ["hdd", "nas", "TrackStatus", "searchMatchItem", "ScheduleAction"].includes(name),
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

/*
 * Recording inferred from the recordings themselves, for cameras without Recording/status (many
 * IP cameras answer it with HTTP 404). Confirmed on a DS-2CD3563G2-IS:
 * - GET /ISAPI/System/time: <Time><localTime>2026-10-21T13:25:02+05:30</localTime>…
 * - POST /ISAPI/ContentMgmt/search (CMSearchDescription) lists the recorded segments of track 101;
 *   the segment being written ends at about the camera's current time. The requested period is
 *   read as local time, but replies differ by firmware: a DS-2CD3563G2-IS answers in local time, a
 *   DS-2CD2563G2-IS set to UTC+05:30 in real UTC, both ending in "Z" (see toLocalWallClock).
 * - GET /ISAPI/ContentMgmt/record/tracks/101: <Enable> and the weekly schedule (CMR = continuous).
 * Times are compared on the camera's own clock, so a camera whose clock is wrong is still read
 * correctly.
 */

/** Recording counts as live when the newest segment ended no longer ago than this. */
export const RECORDING_RECENT_MINUTES = 10;

/** A wall-clock time ("2026-10-21T13:22:18", any suffix ignored) as milliseconds on a UTC scale. */
export function wallClockMs(raw: string | undefined): number | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/.exec(raw?.trim() ?? "");
  if (!m) return undefined;
  const ms = Date.parse(`${m[1]}T${m[2]}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

const wallClockText = (ms: number) => new Date(ms).toISOString().slice(0, 19);

/** GET /ISAPI/System/time → the camera's wall-clock time now and its UTC offset when stated. */
export function parseCameraTime(xml: string): { nowMs: number; offsetMinutes?: number } {
  const local = text(findRoot(parseXml(xml), "Time"), "localTime");
  const nowMs = wallClockMs(local);
  if (nowMs === undefined) throw new CameraApiError("INVALID_RESPONSE", "The camera did not report its local time");
  const off = /([+-])(\d{2}):?(\d{2})$/.exec(local!);
  const offsetMinutes = off ? (off[1] === "-" ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) : /Z$/i.test(local!) ? 0 : undefined;
  return { nowMs, offsetMinutes };
}

/** Body of POST /ISAPI/ContentMgmt/search for track 101 between two wall-clock times. */
export function searchRequestXml(fromMs: number, toMs: number, searchId: string): string {
  const t = (ms: number) => `${wallClockText(ms)}Z`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<CMSearchDescription><searchID>${searchId}</searchID>
<trackIDList><trackID>101</trackID></trackIDList>
<timeSpanList><timeSpan><startTime>${t(fromMs)}</startTime><endTime>${t(toMs)}</endTime></timeSpan></timeSpanList>
<maxResults>40</maxResults><searchResultPostion>0</searchResultPostion>
<metadataList><metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor></metadataList>
</CMSearchDescription>`;
}

/**
 * Converts a segment end from a search reply to the camera's local wall-clock time. The reply is
 * in local time or in UTC depending on firmware; a reading that would lie in the future is ruled
 * out, otherwise the one closer to the camera's time now is taken.
 */
export function toLocalWallClock(endMs: number, nowLocalMs: number, offsetMinutes: number | undefined): number {
  if (!offsetMinutes) return endMs;
  const fromUtc = endMs + offsetMinutes * 60_000;
  const slack = 5 * 60_000;
  const localPossible = endMs <= nowLocalMs + slack;
  const utcPossible = fromUtc <= nowLocalMs + slack;
  if (localPossible !== utcPossible) return utcPossible ? fromUtc : endMs;
  return Math.abs(nowLocalMs - fromUtc) < Math.abs(nowLocalMs - endMs) ? fromUtc : endMs;
}

/** POST /ISAPI/ContentMgmt/search → the end of the newest recorded segment (wall clock), if any. */
export function parseSearchLatestEnd(xml: string): number | undefined {
  const root = findRoot(parseXml(xml), "CMSearchResult");
  if (text(root, "responseStatus") === "false" && !/^no\s*match/i.test(text(root, "responseStatusStrg") ?? "")) {
    throw new CameraApiError("API_ERROR", `Recording search failed: ${text(root, "responseStatusStrg") ?? "no reason given"}`);
  }
  const ends = list(root, "matchList", "searchMatchItem")
    .map((item) => wallClockMs(text(item.timeSpan as XmlNode, "endTime")))
    .filter((v): v is number => v !== undefined);
  return ends.length ? Math.max(...ends) : undefined;
}

export interface TrackSchedule {
  enabled?: boolean;
  /** Whether continuous recording (CMR) is scheduled at the given moment. */
  continuousAt(wallMs: number): boolean;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const secondsOfDay = (raw: string | undefined) => {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw ?? "");
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0) : undefined;
};

/** GET /ISAPI/ContentMgmt/record/tracks/101 → whether recording is on and when it is continuous. */
export function parseTrackSchedule(xml: string): TrackSchedule {
  const root = findRoot(parseXml(xml), "Track");
  const enable = text(root, "Enable")?.toLowerCase();
  const blocks = (root.TrackSchedule as XmlNode | undefined)?.ScheduleBlockList as XmlNode | undefined;
  const block = blocks?.ScheduleBlock;
  const actions = (Array.isArray(block) ? block : [block])
    .flatMap((b) => ((b as XmlNode | undefined)?.ScheduleAction as XmlNode[] | undefined) ?? [])
    .map((a) => {
      const start = a.ScheduleActionStartTime as XmlNode | undefined;
      const end = a.ScheduleActionEndTime as XmlNode | undefined;
      const act = a.Actions as XmlNode | undefined;
      return {
        day: DAYS.indexOf(text(start, "DayOfWeek")?.toLowerCase() ?? ""),
        from: secondsOfDay(text(start, "TimeOfDay")),
        to: secondsOfDay(text(end, "TimeOfDay")),
        continuous: text(act, "Record")?.toLowerCase() === "true" && text(act, "ActionRecordingMode")?.toUpperCase() === "CMR",
      };
    });
  return {
    enabled: enable === "true" ? true : enable === "false" ? false : undefined,
    continuousAt(wallMs) {
      const d = new Date(wallMs);
      const sec = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
      return actions.some((a) => a.continuous && a.day === d.getUTCDay() && a.from !== undefined && a.to !== undefined && a.from <= sec && sec < a.to);
    },
  };
}

const clock = (ms: number) => wallClockText(ms).slice(11, 16);

/**
 * Decides the recording state from the newest recorded segment (camera wall clock), the camera's
 * time now and, when it could be read, the channel's recording schedule.
 */
export function recordingFromSegments(nowMs: number, latestEndMs: number | undefined, schedule?: TrackSchedule): RecordingReading {
  const note = "inferred from the recordings on the camera's storage";
  const minutesAgo = latestEndMs === undefined ? undefined : Math.max(0, Math.round((nowMs - latestEndMs) / 60_000));
  const last = latestEndMs === undefined ? "" : `; last recording ended at ${clock(latestEndMs)} camera time`;
  const result = (state: RecordingReading["state"], why: string): RecordingReading => ({
    state,
    channels: [{ id: "track-101", state, rawStatus: latestEndMs === undefined ? undefined : `last segment ends ${wallClockText(latestEndMs)}` }],
    detail: `${why}; ${note}`,
  });
  if (minutesAgo !== undefined && minutesAgo <= RECORDING_RECENT_MINUTES) {
    return result("recording", `Recording (last recorded ${minutesAgo === 0 ? "just now" : `${minutesAgo} min ago`}, ${clock(latestEndMs!)} camera time)`);
  }
  if (schedule?.enabled === false) return result("idle", `Recording is turned off for this channel${last}`);
  const nothing = `Nothing recorded in the last ${RECORDING_RECENT_MINUTES} minutes${last}`;
  if (schedule?.continuousAt(nowMs)) return result("error", `Continuous recording is scheduled, but n${nothing.slice(1)}`);
  return result("idle", schedule ? `${nothing} (recording is event-based or outside its schedule)` : nothing);
}
