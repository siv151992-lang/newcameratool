import { XMLParser, XMLValidator } from "fast-xml-parser";
import { aggregate } from "../storageMath.js";
import { COMMON_STATUSES, isAbsentStatus, parseBoolean, parseByteCount, statusMapper } from "../parsing.js";
import { CameraApiError, type StorageDeviceStatus, type StorageReading } from "../types.js";

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
  isArray: (name) => name === "StorageDevice",
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

export function parseOnvifStorage(xml: string): StorageReading {
  const trimmed = xml.trim();
  if (!trimmed.startsWith("<") || XMLValidator.validate(trimmed) !== true) {
    throw new CameraApiError("INVALID_RESPONSE", "The camera did not return valid XML");
  }
  const doc = parser.parse(trimmed) as XmlNode;
  const body = child(child(doc, "Envelope"), "Body");
  if (!body) throw new CameraApiError("INVALID_RESPONSE", "Unexpected XML response: expected a SOAP Envelope/Body");

  const fault = child(body, "Fault");
  if (fault) throw faultError(fault);

  const responseKey = Object.keys(body).find((k) => k.toLowerCase() === "getstoragedevicesresponse");
  if (responseKey === undefined) {
    throw new CameraApiError("INVALID_RESPONSE", "Unexpected SOAP response: expected <GetStorageDevicesResponse>");
  }
  // An empty <GetStorageDevicesResponse/> parses as "": the device has no storage.
  const response = isNode(body[responseKey]) ? (body[responseKey] as XmlNode) : {};

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
  if (codes.some((c) => /^NotAuthorized$/i.test(c))) return new CameraApiError("PERMISSION_DENIED", msg);
  if (codes.some((c) => /ActionNotSupported|NotSupported|NoSuchService/i.test(c))) return new CameraApiError("API_UNAVAILABLE", msg);
  return new CameraApiError("API_ERROR", msg);
}
