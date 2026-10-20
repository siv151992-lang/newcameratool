import type { DeviceHealth } from "./types.js";

/**
 * Small helpers shared by the brand parsers. Everything here is strict: a value that is missing,
 * negative, fractional where it should not be, or outside the safe integer range becomes undefined
 * instead of a guessed number.
 */

export const MIB = 1024 * 1024;

/**
 * Parses a non-negative byte count, optionally scaled by `unit` (e.g. MIB for values reported in
 * megabytes). Accepts plain decimals such as "1495797858304.000000", which Dahua firmware emits.
 */
export function parseByteCount(raw: unknown, unit = 1): number | undefined {
  if (typeof raw === "number") raw = String(raw);
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return undefined;
  const bytes = Math.round(Number(s) * unit);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

export function parseBoolean(raw: string | undefined): boolean | undefined {
  const s = raw?.trim().toLowerCase();
  if (s === "true" || s === "1" || s === "yes") return true;
  if (s === "false" || s === "0" || s === "no") return false;
  return undefined;
}

/**
 * Splits a CGI "key=value" body into ordered pairs. Lines without "=" and comment lines are ignored;
 * the value keeps any further "=" characters. CRLF, LF and lone CR line endings are all accepted.
 */
export function parseKeyValueLines(body: string): Array<[key: string, value: string]> {
  const pairs: Array<[string, string]> = [];
  for (const line of body.split(/\r\n|\n|\r/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    pairs.push([trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim()]);
  }
  return pairs;
}

/** Slot states meaning "no disk is installed here": such slots are left out of a reading. */
const ABSENT = new Set(["absent", "notexist", "nodisk", "notinstalled", "uninstalled", "empty", "none"]);

export function isAbsentStatus(raw: string | undefined): boolean {
  return raw !== undefined && ABSENT.has(normaliseStatus(raw));
}

const normaliseStatus = (raw: string) => raw.trim().toLowerCase().replace(/[\s_-]+/g, "");

export interface StatusTable {
  healthy: readonly string[];
  degraded: readonly string[];
  unhealthy: readonly string[];
}

/** Builds a case/spacing-insensitive status mapper ("In Use", "in_use" and "InUse" are equal). */
export function statusMapper(table: StatusTable): (raw: string | undefined) => DeviceHealth {
  const healthy = new Set(table.healthy.map(normaliseStatus));
  const degraded = new Set(table.degraded.map(normaliseStatus));
  const unhealthy = new Set(table.unhealthy.map(normaliseStatus));
  return (raw) => {
    if (!raw) return "unknown";
    const s = normaliseStatus(raw);
    if (healthy.has(s)) return "healthy";
    if (degraded.has(s)) return "degraded";
    if (unhealthy.has(s)) return "unhealthy";
    return "unknown";
  };
}

/** Status words most camera firmwares share; brand parsers extend these with their own. */
export const COMMON_STATUSES: StatusTable = {
  healthy: ["normal", "ok", "success", "idle", "inuse", "sleep", "sleeping", "ready", "active", "mounted"],
  degraded: ["formatting", "formating", "repairing", "initializing", "initialising", "checking", "mounting"],
  unhealthy: [
    "error", "abnormal", "exception", "fault", "failed", "failure", "damaged", "unformatted",
    "uninitialized", "readonly", "full", "offline", "unmounted", "smartfailed", "locked",
  ],
};
