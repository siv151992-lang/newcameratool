import { XMLParser, XMLValidator } from "fast-xml-parser";
import { combineRecording, recordingMapper } from "../recording.js";
import { aggregate } from "../storageMath.js";
import { COMMON_STATUSES, isAbsentStatus, parseBoolean, parseByteCount, statusMapper } from "../parsing.js";
import { CameraApiError, type DeviceInfo, type RecordingReading, type StorageDeviceStatus, type StorageReading } from "../types.js";

/**
 * Parsing for ONVIF GetStorageDevices SOAP responses:
 *
 *   <soap:Envelope><soap:Body><tst:GetStorageDevicesResponse>
 *     <tst:StorageDevice>
 *       <tst:Token>StorageToken_SD_Card_1</tst:Token>
 *       <tst:Configuration><tt:Type>SDCard</tt:Type><tt:Enabled>true</tt:Enabled></tst:Configuration>
 *       <tst:Status><tt:State>Normal</tt:State>
 *         <tt:StorageInfo><tt:TotalSpace>…</tt:TotalSpace><tt:FreeSpace>…</tt:FreeSpace>
 *           <tt:UsedSpace>…</tt:UsedSpace></tt:StorageInfo></tst:Status>
 *     </tst:StorageDevice>
 *   </tst:GetStorageDevicesResponse></soap:Body></soap:Envelope>
 *
 * Namespace prefixes vary between vendors (tt/tst/tds/ns1…), so they are stripped and nodes are
 * matched by local name. Sizes are raw byte integers. SOAP Faults become classified errors.
 */

export const mapOnvifStatus = statusMapper({
  healthy: [...COMMON_STATUSES.healthy],
  degraded: [...COMMON_STATUSES.degraded],
  unhealthy: [...COMMON_STATUSES.unhealthy],
});

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false, // keep raw strings; numbers are validated explicitly
  trimValues: true,
  isArray: (name) => name === "StorageDevice" || name === "JobItem" || name === "Service",
});

type XmlNode = Record<string, unknown>;

const isNode = (v: unknown): v is XmlNode => !!v && typeof v === "object" && !Array.isArray(v);

function child(node: unknown, name: string): XmlNode | undefined {
  if (!isNode(node)) return undefined;
  const key = Object.keys(node).find((k) => k.toLowerCase() === name.toLowerCase());
  const v = key === undefined ? undefined : node[key];
  return isNode(v) ? v : undefined;
}

function text(node: unknown, name: string): string | undefined {
  if (!isNode(node)) return undefined;
  const key = Object.keys(node).find((k) => k.toLowerCase() === name.toLowerCase());
  let v = key === undefined ? undefined : node[key];
  // An element carrying attributes or mixed content is parsed as { "#text": ... }.
  if (isNode(v)) v = v["#text"];
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = String(v).trim();
  return s === "" ? undefined : s;
}

/** Parses a SOAP envelope and returns its Body, throwing the classified error for a Fault. */
function soapBody(xml: string): XmlNode {
  const trimmed = xml.trim();
  if (!trimmed.startsWith("<") || XMLValidator.validate(trimmed) !== true) {
    throw new CameraApiError("INVALID_RESPONSE", "The camera did not return valid XML");
  }
  const doc = parser.parse(trimmed) as XmlNode;
  const body = child(child(doc, "Envelope"), "Body");
  if (!body) throw new CameraApiError("INVALID_RESPONSE", "Unexpected XML response: expected a SOAP Envelope/Body");
  const fault = child(body, "Fault");
  if (fault) throw faultError(fault);
  return body;
}

/** Returns the named response element. An empty element (parsed as "") becomes {}. */
function soapResponse(xml: string, name: string): XmlNode {
  const body = soapBody(xml);
  const key = Object.keys(body).find((k) => k.toLowerCase() === name.toLowerCase());
  if (key === undefined) throw new CameraApiError("INVALID_RESPONSE", `Unexpected SOAP response: expected <${name}>`);
  return isNode(body[key]) ? (body[key] as XmlNode) : {};
}

/** Returns the classified error described by a SOAP Fault body, if it is one. */
export function parseOnvifFault(xml: string): CameraApiError | undefined {
  try {
    soapBody(xml);
    return undefined;
  } catch (e) {
    return e instanceof CameraApiError && e.code !== "INVALID_RESPONSE" ? e : undefined;
  }
}

export function parseOnvifStorage(xml: string): StorageReading {
  const response = soapResponse(xml, "GetStorageDevicesResponse");

  const key = Object.keys(response).find((k) => k.toLowerCase() === "storagedevice");
  const items = key === undefined ? [] : (response[key] as unknown[]);
  const devices = items
    .filter(isNode)
    .filter((n) => !isAbsentStatus(text(child(n, "Status"), "State")))
    .map(toDevice);
  return aggregate(devices);
}

function toDevice(node: XmlNode, index: number): StorageDeviceStatus {
  const token = text(node, "Token") ?? String(index + 1);
  const config = child(node, "Configuration");
  const status = child(node, "Status");
  const info = child(status, "StorageInfo");
  const rawStatus = text(status, "State");
  const enabled = parseBoolean(text(config, "Enabled"));

  const totalBytes = parseByteCount(text(info, "TotalSpace"));
  let freeBytes = parseByteCount(text(info, "FreeSpace"));
  const usedBytes = parseByteCount(text(info, "UsedSpace"));
  if (freeBytes === undefined && totalBytes !== undefined && usedBytes !== undefined && usedBytes <= totalBytes) {
    freeBytes = totalBytes - usedBytes;
  }
  return {
    id: token,
    name: text(config, "Name") ?? token,
    type: text(config, "Type"),
    // A disabled storage device cannot record, whatever state it reports.
    healthStatus: enabled === false ? "degraded" : mapOnvifStatus(rawStatus),
    rawStatus: enabled === false ? [rawStatus, "disabled"].filter(Boolean).join(", ") : rawStatus,
    totalBytes,
    freeBytes,
  };
}

/** Classifies a SOAP 1.2 (Code/Subcode/Reason) or SOAP 1.1 (faultcode/faultstring) fault. */
function faultError(fault: XmlNode): CameraApiError {
  const codes: string[] = [];
  for (let code = child(fault, "Code"); code; code = child(code, "Subcode")) {
    const v = text(code, "Value");
    if (v) codes.push(v.replace(/^.*:/, ""));
  }
  const legacy = text(fault, "faultcode");
  if (legacy) codes.push(legacy.replace(/^.*:/, ""));
  const reason = text(child(fault, "Reason"), "Text") ?? text(fault, "faultstring") ?? codes.at(-1) ?? "SOAP Fault";
  const msg = `Camera reported: ${reason}`;
  // ONVIF answers wrong WS-Security credentials with ter:NotAuthorized (or wsse:FailedAuthentication).
  if (codes.some((c) => /^(NotAuthorized|FailedAuthentication|InvalidSecurityToken)$/i.test(c))) {
    return new CameraApiError("AUTH_FAILED", msg);
  }
  if (codes.some((c) => /^(OperationProhibited|AccessDenied)$/i.test(c))) return new CameraApiError("PERMISSION_DENIED", msg);
  if (codes.some((c) => /ActionNotSupported|NotSupported|NoSuchService/i.test(c))) return new CameraApiError("API_UNAVAILABLE", msg);
  return new CameraApiError("API_ERROR", msg);
}

/** Parses a tds:GetDeviceInformationResponse. */
export function parseOnvifDeviceInfo(xml: string): DeviceInfo {
  const r = soapResponse(xml, "GetDeviceInformationResponse");
  const manufacturer = text(r, "Manufacturer");
  const model = text(r, "Model");
  return {
    deviceName: [manufacturer, model].filter(Boolean).join(" ") || undefined,
    model,
    serialNumber: text(r, "SerialNumber"),
    firmwareVersion: text(r, "FirmwareVersion"),
  };
}

/**
 * Parses a tds:GetSystemDateAndTimeResponse into the device's current UTC time (epoch ms).
 * Used to correct the WS-Security timestamp for cameras whose clock differs from ours.
 */
export function parseOnvifSystemTime(xml: string): number | undefined {
  const r = soapResponse(xml, "GetSystemDateAndTimeResponse");
  const utc = child(child(r, "SystemDateAndTime"), "UTCDateTime");
  const date = child(utc, "Date");
  const time = child(utc, "Time");
  const n = (node: XmlNode | undefined, k: string) => {
    const v = text(node, k);
    return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined;
  };
  const parts = [n(date, "Year"), n(date, "Month"), n(date, "Day"), n(time, "Hour"), n(time, "Minute"), n(time, "Second")];
  if (parts.some((p) => p === undefined)) return undefined;
  const [y, mo, d, h, mi, sec] = parts as number[];
  const ms = Date.UTC(y!, mo! - 1, d!, h!, mi!, sec!);
  return Number.isFinite(ms) ? ms : undefined;
}

/** The camera's UTC offset in minutes, from LocalDateTime − UTCDateTime in GetSystemDateAndTime. */
export function parseOnvifLocalOffset(xml: string): number | undefined {
  const sdt = child(soapResponse(xml, "GetSystemDateAndTimeResponse"), "SystemDateAndTime");
  const at = (node: XmlNode | undefined) => {
    const d = child(node, "Date");
    const t = child(node, "Time");
    const parts = [text(d, "Year"), text(d, "Month"), text(d, "Day"), text(t, "Hour"), text(t, "Minute"), text(t, "Second")].map(Number);
    return parts.some((p) => !Number.isInteger(p)) ? undefined : Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!, parts[3]!, parts[4]!, parts[5]!);
  };
  const utc = at(child(sdt, "UTCDateTime"));
  const local = at(child(sdt, "LocalDateTime"));
  return utc === undefined || local === undefined ? undefined : Math.round((local - utc) / 60_000);
}

/** GetServices → the path of each service by namespace (XAddr may name another host; only the path is used). */
export function parseOnvifServices(xml: string): Map<string, string> {
  const response = soapResponse(xml, "GetServicesResponse");
  const key = Object.keys(response).find((k) => k.toLowerCase() === "service");
  const out = new Map<string, string>();
  for (const svc of key === undefined ? [] : (response[key] as unknown[]).filter(isNode)) {
    const ns = text(svc, "Namespace");
    const addr = text(svc, "XAddr");
    if (!ns || !addr) continue;
    try {
      out.set(ns, new URL(addr).pathname);
    } catch {
      if (addr.startsWith("/")) out.set(ns, addr);
    }
  }
  return out;
}

/**
 * Parses a tse:GetRecordingSummaryResponse:
 *   <Summary><DataFrom>2026-09-20T08:14:00Z</DataFrom><DataUntil>…</DataUntil><NumberRecordings>1</NumberRecordings></Summary>
 * DataFrom/DataUntil are UTC (xs:dateTime); absent or unparseable values are left out.
 */
export function parseOnvifRecordingSummary(xml: string): { from?: number; until?: number; recordings?: number } {
  const summary = child(soapResponse(xml, "GetRecordingSummaryResponse"), "Summary");
  const time = (k: string) => {
    const v = text(summary, k);
    const ms = v ? Date.parse(/Z|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`) : NaN;
    return Number.isFinite(ms) ? ms : undefined;
  };
  const n = Number(text(summary, "NumberRecordings"));
  return { from: time("DataFrom"), until: time("DataUntil"), recordings: Number.isInteger(n) ? n : undefined };
}

export const mapOnvifRecording = recordingMapper({
  recording: ["recording", "active"],
  idle: ["stopped", "idle", "initiated", "inactive"],
  error: ["error", "failed"],
});

/**
 * Parses a trc:GetRecordingJobsResponse. Each <JobItem> is one recording job; its state comes from
 * <RecordingStatus> (Recording | Stopped | Initiated) or, per the ONVIF schema, from
 * <JobConfiguration><Mode> (Active | Idle). No jobs at all means the camera is not recording.
 */
export function parseOnvifRecording(xml: string): RecordingReading {
  const response = soapResponse(xml, "GetRecordingJobsResponse");
  const key = Object.keys(response).find((k) => k.toLowerCase() === "jobitem");
  const items = key === undefined ? [] : (response[key] as unknown[]).filter(isNode);
  if (items.length === 0) return { state: "idle", channels: [], detail: "No recording jobs configured" };
  const channels = items.map((item, i) => {
    const rawStatus = text(item, "RecordingStatus") ?? text(child(item, "JobConfiguration"), "Mode");
    const recording = text(item, "RecordingToken") ?? text(child(item, "JobConfiguration"), "RecordingToken");
    return {
      id: text(item, "JobToken") ?? `job-${i + 1}`,
      state: mapOnvifRecording(rawStatus),
      rawStatus,
      mode: recording ? `recording ${recording}` : undefined,
    };
  });
  return combineRecording(channels);
}
