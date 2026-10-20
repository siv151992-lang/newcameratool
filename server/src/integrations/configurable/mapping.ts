import { XMLParser, XMLValidator } from "fast-xml-parser";
import { isAbsentStatus, statusMapper, parseBoolean } from "../parsing.js";
import { aggregate } from "../storageMath.js";
import type { DeviceHealth, DeviceInfo, StorageDeviceStatus, StorageReading } from "../types.js";
import { stripRoot, UNITS, type IntegrationConfig, type Unit } from "./config.js";

/**
 * Turns a vendor reply into the normalised storage model using a declarative mapping.
 * Parsing is strict: JSON must be valid JSON, XML must be well formed and may not declare a
 * DOCTYPE or entities (no entity expansion of any kind). Paths are resolved over own properties
 * only. Numbers must be non-negative and are converted to bytes; inconsistent capacity figures
 * are reported, never smoothed over.
 */

export type ParseFailure = "format" | "mapping" | "no_storage";

export class MappingError extends Error {
  constructor(public readonly kind: ParseFailure, message: string) {
    super(message);
  }
}

export interface FieldValue {
  field: string;
  path: string;
  raw?: string;
  value?: string | number | boolean;
  error?: string;
}

export interface MappedDevice {
  index: number;
  fields: FieldValue[];
  device?: StorageDeviceStatus;
  skipped?: string;
}

export interface MappingResult {
  devices: MappedDevice[];
  reading: StorageReading;
  errors: string[];
  warnings: string[];
  missing: string[];
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
});

/** Parses a reply body as JSON or XML. Throws MappingError("format") for anything malformed. */
export function parseBody(body: string, format: "json" | "xml"): unknown {
  const text = body.replace(/^\uFEFF/, "").trim();
  if (text === "") throw new MappingError("format", "The response body is empty");
  if (format === "json") {
    try {
      return JSON.parse(text);
    } catch (err) {
      throw new MappingError("format", `The response is not valid JSON (${(err as Error).message.slice(0, 120)})`);
    }
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new MappingError("format", "XML with a DOCTYPE or entity declarations is refused");
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw new MappingError("format", `The response is not well-formed XML (${valid.err.msg} at line ${valid.err.line})`);
  return xmlParser.parse(text);
}

const own = (o: unknown, k: string): unknown =>
  o !== null && typeof o === "object" && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined;

/**
 * Resolves a dotted path. `[n]` picks one element, `[*]` keeps all; an object met where a list is
 * expected counts as a one-element list (XML elements that occur once). Returns every match.
 */
export function resolvePath(root: unknown, input: string): unknown[] {
  const path = stripRoot(input);
  if (path === "") return [root];
  let current: unknown[] = [root];
  for (const seg of path.split(".")) {
    const m = /^([^[]+)(?:\[(\d+|\*)\])?$/.exec(seg)!;
    const key = m[1]!;
    const index = m[2];
    const next: unknown[] = [];
    for (const node of current) {
      const value = own(node, key);
      if (value === undefined) continue;
      if (index === undefined) next.push(value);
      else {
        const list = Array.isArray(value) ? value : [value];
        if (index === "*") next.push(...list);
        else if (list[Number(index)] !== undefined) next.push(list[Number(index)]);
      }
    }
    current = next;
  }
  return current;
}

/** The text of a scalar node: strings/numbers/booleans as is, an XML element's #text. */
function scalar(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const text = own(v, "#text");
  return typeof text === "string" || typeof text === "number" ? String(text) : undefined;
}

function first(node: unknown, path: string): { raw?: string; found: boolean; notScalar?: boolean } {
  const hits = resolvePath(node, path);
  if (hits.length === 0) return { found: false };
  const raw = scalar(hits[0]);
  return raw === undefined ? { found: true, notScalar: true } : { found: true, raw: raw.trim() };
}

/** Parses a non-negative number (no exponent, no sign) and converts it to whole bytes. */
export function toBytes(raw: string, unit: Unit): number | undefined {
  if (!/^\d+(\.\d+)?$/.test(raw)) return undefined;
  const bytes = Math.round(Number(raw) * UNITS[unit]);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");

export function mapStorage(parsed: unknown, response: IntegrationConfig["response"]): MappingResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const health = statusMapper(response.healthValues);
  const absent = new Set(response.healthValues.absent.map(norm));
  const rw = new Set(response.readWriteValues.readWrite.map(norm));
  const ro = new Set(response.readWriteValues.readOnly.map(norm));

  const nodes = resolvePath(parsed, response.devicesPath).flatMap((n) => (Array.isArray(n) ? n : [n]));
  const mapped: MappedDevice[] = [];
  const devices: StorageDeviceStatus[] = [];

  nodes.forEach((node, index) => {
    const label = `Device ${index + 1}`;
    const fields: FieldValue[] = [];
    const text = (field: string, path: string | undefined) => {
      if (!path) return undefined;
      const r = first(node, path);
      const fv: FieldValue = { field, path, raw: r.raw };
      if (!r.found) fv.error = "Not found";
      else if (r.notScalar) fv.error = "Is an object or list, not a value";
      else fv.value = r.raw;
      fields.push(fv);
      return fv.value as string | undefined;
    };
    const bytes = (field: string, f: { path: string; unit: Unit } | undefined) => {
      if (!f) return undefined;
      const r = first(node, f.path);
      const fv: FieldValue = { field, path: f.path, raw: r.raw };
      fields.push(fv);
      if (!r.found) {
        fv.error = "Not found";
        return undefined;
      }
      const b = r.raw === undefined ? undefined : toBytes(r.raw, f.unit);
      if (b === undefined) {
        fv.error = r.notScalar ? "Is an object or list, not a value" : `"${r.raw}" is not a non-negative number`;
        errors.push(`${label}: ${field} ${fv.error}`);
        return undefined;
      }
      fv.value = b;
      return b;
    };

    const id = text("Device ID", response.fields.id);
    const name = text("Device name", response.fields.name);
    const rawHealth = text("Disk status", response.fields.health);
    if (rawHealth !== undefined && (absent.has(norm(rawHealth)) || (absent.size === 0 && isAbsentStatus(rawHealth)))) {
      mapped.push({ index, fields, skipped: `Skipped: status "${rawHealth}" means no disk is installed` });
      return;
    }
    let total = bytes("Total capacity", response.fields.total);
    let free = bytes("Free capacity", response.fields.free);
    const used = bytes("Used capacity", response.fields.used);
    const rawRw = text("Read/write status", response.fields.readWrite);

    if (total !== undefined && free !== undefined && free > total) {
      errors.push(`${label}: free capacity is larger than total capacity`);
      free = undefined;
    }
    if (total !== undefined && used !== undefined && used > total) {
      errors.push(`${label}: used capacity is larger than total capacity`);
    } else if (total !== undefined && used !== undefined && free !== undefined) {
      const tolerance = Math.max(total * 0.01, 1024 ** 2);
      if (Math.abs(used + free - total) > tolerance) warnings.push(`${label}: used + free does not add up to total; free capacity is used`);
    } else if (total !== undefined && used !== undefined && free === undefined) {
      free = total - used; // only from consistent, reported numbers
    }
    if (total === 0) {
      warnings.push(`${label}: total capacity is 0`);
      total = undefined;
    }

    let healthStatus: DeviceHealth = rawHealth === undefined ? "unknown" : health(rawHealth);
    if (rawHealth !== undefined && healthStatus === "unknown") warnings.push(`${label}: disk status "${rawHealth}" is not in any status list`);
    let writable: boolean | undefined;
    if (rawRw !== undefined) {
      const s = norm(rawRw);
      writable = rw.has(s) ? true : ro.has(s) ? false : parseBoolean(rawRw);
      if (writable === false && healthStatus === "healthy") healthStatus = "degraded";
    }
    const device: StorageDeviceStatus = {
      id: id || String(index + 1),
      name: name || undefined,
      healthStatus,
      rawStatus: rawHealth,
      totalBytes: total,
      freeBytes: free,
      writable,
    };
    mapped.push({ index, fields, device });
    devices.push(device);
  });

  const reading = aggregate(devices);
  const missing: string[] = [];
  if (nodes.length === 0) missing.push(`No storage devices found at "${response.devicesPath || "(root)"}"`);
  else if (devices.length > 0) {
    if (!devices.some((d) => d.totalBytes !== undefined)) missing.push("Total capacity");
    if (!devices.some((d) => d.freeBytes !== undefined)) missing.push(response.fields.free ? "Free capacity" : "Used capacity");
  }
  return { devices: mapped, reading, errors, warnings, missing };
}

export function mapDeviceInfo(parsed: unknown, fields: NonNullable<IntegrationConfig["deviceInfo"]>["fields"]): DeviceInfo {
  const out: DeviceInfo = {};
  for (const [k, path] of Object.entries(fields) as [keyof DeviceInfo, string | undefined][]) {
    if (!path) continue;
    const r = first(parsed, path);
    if (r.raw) out[k] = r.raw.slice(0, 120);
  }
  return out;
}

/** Throws the first problem that makes a mapping unusable for monitoring. */
export function assertUsable(result: MappingResult): StorageReading {
  if (result.errors.length > 0) throw new MappingError("mapping", result.errors[0]!);
  if (result.missing.length > 0 && result.devices.length === 0) throw new MappingError("no_storage", result.missing[0]!);
  if (result.missing.length > 0) throw new MappingError("mapping", `Required field missing: ${result.missing.join(", ")}`);
  return result.reading;
}
