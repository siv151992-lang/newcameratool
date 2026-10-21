import { MIB, parseKeyValueLines } from "../parsing.js";
import { aggregate } from "../storageMath.js";
import { CameraApiError, type DeviceInfo, type RecordingReading, type StorageDeviceStatus, type StorageReading } from "../types.js";

/**
 * Panasonic / i-PRO cameras.
 *
 * Storage: the SD memory card setup page (/admin/setup_sdcard.html) is generated with the card
 * figures embedded as JavaScript variables, in MB:
 *   var sRemSD = "696";  var sTotalSD = "243952";  var sRemSD2 = "-";  var sTotalSD2 = "-";
 * "-" (or empty) means no card in that slot. The page itself shows "#" and "*" as placeholder
 * states it does not explain (shown as "##########MB" / "**********MB"); those are reported as an
 * unknown card state without capacity rather than guessed.
 *
 * Device information and recording: /cgi-bin/getinfo?FILE=1 answers with "KEY=value" lines
 * wrapped in <HTML> tags (NAME, SERIAL, VERSION, FIRMWARE, MAC, SDrec=on|off, …).
 */

const VAR = /var\s+(sRemSD2?|sTotalSD2?)\s*=\s*"([^"]*)"\s*;/g;

function sdVariables(html: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of html.matchAll(VAR)) if (!vars.has(m[1]!)) vars.set(m[1]!, m[2]!.trim());
  return vars;
}

const absent = (v: string | undefined) => v === undefined || v === "" || v === "-";

function megabytes(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const bytes = Number(raw) * MIB;
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

export function parsePanasonicStorage(html: string): StorageReading {
  const vars = sdVariables(html);
  if (!vars.has("sTotalSD") && !vars.has("sRemSD")) {
    if (/<title>[^<]*(login|unauthori|forbidden)/i.test(html)) {
      throw new CameraApiError("PERMISSION_DENIED", "The camera did not return the SD memory card page. The user needs administrator rights.");
    }
    throw new CameraApiError("INVALID_RESPONSE", "The SD memory card page did not contain the expected capacity values (sTotalSD / sRemSD)");
  }
  const devices: StorageDeviceStatus[] = [];
  for (const [slot, suffix] of [["1", ""], ["2", "2"]] as const) {
    const totalRaw = vars.get(`sTotalSD${suffix}`);
    const remRaw = vars.get(`sRemSD${suffix}`);
    if (absent(totalRaw) && absent(remRaw)) continue; // no card in this slot
    const totalBytes = totalRaw ? megabytes(totalRaw) : undefined;
    const freeBytes = remRaw ? megabytes(remRaw) : undefined;
    const known = totalBytes !== undefined && freeBytes !== undefined;
    devices.push({
      id: slot,
      name: `SD card ${slot}`,
      type: "SD",
      healthStatus: known ? "healthy" : "unknown",
      rawStatus: known ? "Ready" : `Capacity shown as "${remRaw ?? ""}/${totalRaw ?? ""}"`,
      totalBytes: totalBytes && totalBytes > 0 ? totalBytes : undefined,
      freeBytes,
    });
  }
  return aggregate(devices);
}

/** Parses getinfo's "KEY=value" lines (inside <HTML> … </HTML>). */
export function parsePanasonicInfoLines(text: string): Map<string, string> {
  const body = text.replace(/<\/?html>/gi, "");
  const map = new Map<string, string>();
  for (const [k, v] of parseKeyValueLines(body)) map.set(k.toUpperCase(), v);
  if (map.size === 0) throw new CameraApiError("INVALID_RESPONSE", "The camera's getinfo reply was empty or not recognised");
  return map;
}

export function parsePanasonicDeviceInfo(text: string): DeviceInfo {
  const m = parsePanasonicInfoLines(text);
  const mac = m.get("MAC")?.replace(/-/g, ":").toUpperCase();
  return {
    model: m.get("PRODUCT_NAME") || m.get("NAME") || undefined,
    serialNumber: m.get("SERIAL") || undefined,
    firmwareVersion: [m.get("VERSION"), m.get("FIRMWARE") && `(${m.get("FIRMWARE")})`].filter(Boolean).join(" ") || undefined,
    macAddress: mac || undefined,
  };
}

/** SDrec=on: recording to the SD card is on; off: not recording to SD. */
export function parsePanasonicRecording(text: string): RecordingReading {
  const raw = parsePanasonicInfoLines(text).get("SDREC");
  const state = raw?.toLowerCase() === "on" ? "recording" : raw?.toLowerCase() === "off" ? "idle" : "unknown";
  return {
    state,
    channels: [{ id: "sd", state, rawStatus: raw === undefined ? undefined : `SDrec=${raw}` }],
    detail: raw === undefined ? "The camera did not report SD recording (SDrec)" : `SD recording ${raw.toLowerCase() === "on" ? "is on" : raw.toLowerCase() === "off" ? "is off" : `reported as "${raw}"`} (SDrec=${raw})`,
  };
}
