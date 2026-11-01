import { randomUUID } from "node:crypto";
import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { requireOk } from "../http/responses.js";
import { parseDeviceInfoXml, parseResponseStatus } from "../hikvision/parser.js";
import type { AccessEventCategory, AccessEventReading, AccessPoint, AccessReading, BrandMeta, CameraBrandAdapter, CameraConfig, DeviceInfo, StorageReading } from "../types.js";
import { CameraApiError } from "../types.js";
import { json, runAccessDiagnostics } from "./common.js";

/** Access event codes (major, minor) → what they mean. Others are kept by their number. */
const EVENTS: Record<string, { category: AccessEventCategory; text: string; door?: "forced" | "held_open" | "open" | "closed" }> = {
  // Major 5: access events.
  "5:1": { category: "granted", text: "Card accepted" },
  "5:2": { category: "granted", text: "Card and PIN accepted" },
  "5:3": { category: "denied", text: "Card and PIN refused" },
  "5:4": { category: "denied", text: "Card and PIN timed out" },
  "5:6": { category: "denied", text: "Card has no permission here" },
  "5:7": { category: "denied", text: "Card outside its valid time" },
  "5:8": { category: "denied", text: "Card expired" },
  "5:9": { category: "denied", text: "Unknown card" },
  "5:10": { category: "denied", text: "Anti-passback refused" },
  "5:11": { category: "denied", text: "Interlocked door not closed" },
  "5:16": { category: "granted", text: "Multi-person verification accepted" },
  "5:21": { category: "door", text: "Door unlocked" },
  "5:22": { category: "door", text: "Door locked" },
  "5:23": { category: "door", text: "Exit button pressed" },
  "5:25": { category: "door", text: "Door opened", door: "open" },
  "5:26": { category: "door", text: "Door closed", door: "closed" },
  "5:27": { category: "door", text: "Door forced open", door: "forced" },
  "5:28": { category: "door", text: "Door held open too long", door: "held_open" },
  "5:38": { category: "granted", text: "Fingerprint accepted" },
  "5:39": { category: "denied", text: "Fingerprint refused" },
  "5:75": { category: "granted", text: "Face accepted" },
  "5:76": { category: "denied", text: "Face refused" },
  // Major 1: alarms.
  "1:1024": { category: "alarm", text: "Alarm input short circuit" },
  "1:1025": { category: "alarm", text: "Alarm input broken circuit" },
  "1:1026": { category: "alarm", text: "Alarm input exception" },
  "1:1028": { category: "tamper", text: "Controller tampered with (opened or removed)" },
  "1:1029": { category: "tamper", text: "Controller tamper restored" },
  "1:1030": { category: "tamper", text: "Reader tampered with (removed)" },
  "1:1031": { category: "tamper", text: "Reader tamper restored" },
};

interface WorkStatus {
  AcsWorkStatus?: {
    doorLockStatus?: number[];
    doorStatus?: number[];
    magneticStatus?: number[];
    cardReaderOnlineStatus?: number[];
    cardReaderAntiDismantleStatus?: number[];
    hostAntiDismantleStatus?: string;
  };
}
interface AcsEventReply {
  AcsEvent?: {
    responseStatusStrg?: string;
    numOfMatches?: number;
    totalMatches?: number;
    InfoList?: { major: number; minor: number; time: string; name?: string; doorNo?: number; cardReaderNo?: number; serialNo?: number; employeeNoString?: string }[];
  };
}

/** The work status → the controller, its doors and its readers. */
export function parseWorkStatus(reply: WorkStatus, deviceName: string): AccessPoint[] {
  const s = reply.AcsWorkStatus;
  if (!s) throw new CameraApiError("INVALID_RESPONSE", "The access controller's work status has no AcsWorkStatus");
  const tamper = s.hostAntiDismantleStatus === "open" ? true : s.hostAntiDismantleStatus === "close" ? false : undefined;
  const points: AccessPoint[] = [{ kind: "controller", externalId: "0", name: deviceName, online: true, tamper }];
  const doors = Math.max(s.doorLockStatus?.length ?? 0, s.magneticStatus?.length ?? 0, s.doorStatus?.length ?? 0);
  for (let i = 0; i < doors; i++) {
    const lock = s.doorLockStatus?.[i];
    const contact = s.magneticStatus?.[i];
    const mode = s.doorStatus?.[i];
    const words = [
      mode === 2 ? "kept open (normally open)" : mode === 3 ? "kept closed (normally closed)" : mode === 1 ? "sleeping" : "",
      contact !== undefined && contact >= 2 ? ["", "", "door contact short circuit", "door contact broken circuit", "door contact fault"][contact] : "",
      lock !== undefined && lock >= 2 ? ["", "", "lock short circuit", "lock broken circuit", "lock fault"][lock] : "",
    ].filter(Boolean);
    points.push({
      kind: "door",
      externalId: String(i + 1),
      name: `Door ${i + 1}`,
      doorState: contact === 0 ? "closed" : contact === 1 ? "open" : undefined,
      lockState: lock === 0 ? "locked" : lock === 1 ? "unlocked" : undefined,
      ...(words.length ? { statusText: words.join(", ") } : {}),
    });
  }
  (s.cardReaderOnlineStatus ?? []).forEach((online, i) => {
    const tamperReader = s.cardReaderAntiDismantleStatus?.[i];
    points.push({
      kind: "reader",
      externalId: String(i + 1),
      name: `Reader ${i + 1}`,
      online: online === 1,
      tamper: tamperReader === 1 ? true : tamperReader === 0 ? false : undefined,
    });
  });
  return points;
}

/** The event list → events, with each door's latest state from them. */
export function parseAcsEvents(reply: AcsEventReply): { events: AccessEventReading[]; doors: Map<string, "forced" | "held_open" | "open" | "closed"> } {
  const events: AccessEventReading[] = [];
  const doors = new Map<string, "forced" | "held_open" | "open" | "closed">();
  for (const e of reply.AcsEvent?.InfoList ?? []) {
    const at = Date.parse(e.time);
    if (!Number.isFinite(at)) continue;
    const known = EVENTS[`${e.major}:${e.minor}`];
    const point = e.doorNo ? `Door ${e.doorNo}` : e.cardReaderNo ? `Reader ${e.cardReaderNo}` : undefined;
    events.push({
      at,
      category: known?.category ?? (e.major === 1 ? "alarm" : e.major === 2 ? "fault" : "other"),
      description: known?.text ?? `Event ${e.major}/${e.minor}`,
      ...(e.name ? { person: e.name } : {}),
      ...(point ? { point } : {}),
      key: e.serialNo !== undefined ? `sn:${e.serialNo}` : `${e.time}|${e.major}|${e.minor}|${e.doorNo ?? ""}|${e.employeeNoString ?? ""}`,
    });
    if (known?.door && e.doorNo) doors.set(String(e.doorNo), known.door);
  }
  events.sort((a, b) => a.at - b.at);
  return { events, doors };
}

/** ISAPI time with an offset: UTC, as "2026-11-01T08:00:00+00:00". */
const isapiTime = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}+00:00`;

/**
 * Hikvision access controllers and face / card terminals (DS-K1T, DS-K2600 …), read directly over
 * ISAPI with Digest login, like the cameras: the work status (doors open or closed, locked or
 * unlocked, readers online, tamper) and the access event log.
 */
export class HikvisionAccessAdapter implements CameraBrandAdapter {
  readonly meta: BrandMeta = {
    key: "hikvision-access",
    displayName: "Hikvision access control",
    supportStatus: "unverified",
    authMethods: ["digest", "basic (HTTPS only)"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["access-control", "device-info", "connection-test"],
    defaultTimeoutMs: 10000,
    deviceKind: "access",
    notes:
      "Hikvision access controllers and terminals (DS-K1T face and card terminals, DS-K2600 controllers), over ISAPI " +
      "with Digest login: doors open or closed and locked or unlocked, readers online, tamper, and the access event log.",
  };

  constructor(private readonly http: CameraHttpClient) {}

  async getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    const path = "/ISAPI/System/deviceInfo";
    return parseDeviceInfoXml(requireOk(await this.http.get(camera, path), path, describe));
  }

  /** Reachable and logged in (an access controller has no recordings of its own to check). */
  async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    await this.getDeviceInfo(camera);
    return { devices: [] };
  }

  testConnection(camera: CameraConfig) {
    return runAccessDiagnostics(this, camera);
  }

  async getAccessStatus(camera: CameraConfig, afterMs: number): Promise<AccessReading> {
    const statusPath = "/ISAPI/AccessControl/AcsWorkStatus?format=json";
    const work = json<WorkStatus>(requireOk(await this.http.request(camera, { path: statusPath, accept: "application/json" }), statusPath, describe), "Work status");
    const info = await this.getDeviceInfo(camera).catch(() => undefined);
    const points = parseWorkStatus(work, info?.deviceName ?? info?.model ?? "Controller");
    let events: AccessEventReading[] = [];
    let eventsError: string | undefined;
    try {
      const all: AccessEventReading[] = [];
      const doors = new Map<string, "forced" | "held_open" | "open" | "closed">();
      const searchID = randomUUID();
      // Up to 5 pages of 30 (what most terminals give per page) a check.
      for (let page = 0, position = 0; page < 5; page++) {
        const path = "/ISAPI/AccessControl/AcsEvent?format=json";
        const body = JSON.stringify({ AcsEventCond: { searchID, searchResultPosition: position, maxResults: 30, major: 0, minor: 0, startTime: isapiTime(afterMs - 1000), endTime: isapiTime(Date.now() + 60_000) } });
        const res = await this.http.request(camera, { method: "POST", path, body, contentType: "application/json", accept: "application/json" });
        const reply = json<AcsEventReply>(requireOk(res, path, describe), "Access events");
        const got = parseAcsEvents(reply);
        all.push(...got.events);
        for (const [d, st] of got.doors) doors.set(d, st);
        const n = reply.AcsEvent?.numOfMatches ?? got.events.length;
        position += n;
        if (reply.AcsEvent?.responseStatusStrg !== "MORE" || n === 0) break;
      }
      events = all.sort((a, b) => a.at - b.at);
      // A door forced or held open (it says so only in its events) while its contact still reads open.
      for (const p of points) {
        const latest = doors.get(p.externalId);
        if (p.kind === "door" && p.doorState === "open" && (latest === "forced" || latest === "held_open")) p.doorState = latest;
      }
    } catch (err) {
      eventsError = err instanceof CameraApiError ? err.message : "could not be read";
    }
    return { points, events, ...(eventsError ? { eventsError } : {}) };
  }
}

const describe = (body: string) => parseResponseStatus(body);
