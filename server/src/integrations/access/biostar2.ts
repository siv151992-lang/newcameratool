import type { CameraHttpClient, CameraResponse } from "../http/cameraHttpClient.js";
import type { AccessEventReading, AccessPoint, AccessReading, BrandMeta, CameraBrandAdapter, CameraConfig, DeviceInfo, StorageReading } from "../types.js";
import { CameraApiError } from "../types.js";
import { categorize, json, requireHttps, runAccessDiagnostics } from "./common.js";

interface Row { [key: string]: unknown }
const rows = (v: unknown, collection: string): Row[] => {
  const c = (v as Record<string, { rows?: Row[] } | undefined>)?.[collection];
  return Array.isArray(c?.rows) ? c.rows : [];
};
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined);
const ref = (v: unknown) => (v && typeof v === "object" ? (v as Row) : undefined);

/** A BioStar 2 device's connection status → online, offline or not known. */
export function deviceOnline(status: unknown): boolean | undefined {
  const s = String(status ?? "").toLowerCase();
  if (["1", "true", "normal", "connected", "online"].includes(s)) return true;
  if (["0", "false", "disconnected", "offline", "disconnect"].includes(s)) return false;
  return undefined;
}

/** Event type code → its name (VERIFY_SUCCESS, DOOR_FORCED_OPEN …), per server, for an hour. */
const eventTypes = new Map<string, { at: number; names: Map<string, string> }>();

/** BioStar 2 events → access events, with each door's and device's latest state from them. */
export function parseBioStarEvents(reply: unknown, names: Map<string, string>) {
  const events: AccessEventReading[] = [];
  const doors = new Map<string, AccessPoint["doorState"]>();
  const tamper = new Map<string, boolean>();
  for (const r of rows(reply, "EventCollection")) {
    const at = Date.parse(str(r.datetime) ?? "");
    if (!Number.isFinite(at)) continue;
    const code = str(ref(r.event_type_id)?.code) ?? "";
    const name = names.get(code) ?? str(ref(r.event_type_id)?.name) ?? `Event ${code}`;
    const device = ref(r.device_id);
    const doorList = Array.isArray(r.door_id) ? (r.door_id as Row[]) : [];
    const door = doorList[0];
    const user = ref(r.user_id);
    const words = name.replace(/_/g, " ").toLowerCase();
    const description = words.charAt(0).toUpperCase() + words.slice(1);
    events.push({
      at,
      category: categorize(words),
      description,
      ...(str(user?.name) ? { person: str(user?.name)! } : {}),
      ...(str(door?.name) ?? str(device?.name) ? { point: (str(door?.name) ?? str(device?.name))! } : {}),
      key: str(r.id) ?? `${str(r.datetime)}|${code}|${str(device?.id) ?? ""}|${str(user?.user_id) ?? ""}`,
    });
    const doorId = str(door?.id);
    if (doorId) {
      if (/forced/.test(words)) doors.set(doorId, "forced");
      else if (/held/.test(words)) doors.set(doorId, "held_open");
      else if (/door (opened|open)\b/.test(words)) doors.set(doorId, "open");
      else if (/door closed/.test(words)) doors.set(doorId, "closed");
    }
    const deviceId = str(device?.id);
    if (deviceId && /tamper/.test(words)) tamper.set(deviceId, !/off|restor|clear|normal/.test(words));
  }
  events.sort((a, b) => a.at - b.at);
  return { events, doors, tamper };
}

/**
 * Suprema readers (BioStation 3, BioEntry W2, BioEntry P2 …), through the BioStar 2 server they
 * report to: added once, with a BioStar 2 operator account, it gives every device (online or not),
 * door, and the access events. The login sends the password itself, so HTTPS only.
 */
export class BioStar2Adapter implements CameraBrandAdapter {
  readonly meta: BrandMeta = {
    key: "suprema-biostar2",
    displayName: "Suprema BioStar 2 (BioStation, BioEntry)",
    supportStatus: "unverified",
    authMethods: ["BioStar 2 login (HTTPS only)"],
    defaultPorts: { http: 80, https: 443 },
    defaultProtocol: "https",
    httpsOnly: true,
    capabilities: ["access-control", "connection-test"],
    defaultTimeoutMs: 15000,
    deviceKind: "access",
    notes:
      "Add the BioStar 2 server once (its HTTPS address and port, and a BioStar 2 operator who may see devices, doors and events): " +
      "each BioStation, BioEntry and other Suprema device it manages is listed with its connection, and access events, doors forced " +
      "or held open and tamper come from its event log.",
  };

  constructor(private readonly http: CameraHttpClient) {}

  private async login(camera: CameraConfig): Promise<string> {
    requireHttps(camera, "The BioStar 2 password");
    const res = await this.http.request(camera, {
      method: "POST",
      path: "/api/login",
      body: JSON.stringify({ User: { login_id: camera.username, password: camera.password } }),
      contentType: "application/json",
      accept: "application/json",
      auth: "none",
    });
    if (res.status === 401 || res.status === 400 || res.status === 403) throw new CameraApiError("AUTH_FAILED", "BioStar 2 refused the user name or password");
    if (res.status === 404) throw new CameraApiError("API_UNAVAILABLE", "No BioStar 2 API at this address (is it the BioStar 2 server, and its HTTPS port?)");
    if (res.status < 200 || res.status >= 300) throw new CameraApiError("API_ERROR", `BioStar 2 login answered HTTP ${res.status}`, { httpStatus: res.status, transient: res.status >= 500 });
    const session = res.headers["bs-session-id"];
    const id = Array.isArray(session) ? session[0] : session;
    if (!id) throw new CameraApiError("INVALID_RESPONSE", "BioStar 2 accepted the login but sent no session");
    return id;
  }

  private async call(camera: CameraConfig, session: string, path: string, body?: unknown): Promise<unknown> {
    const res: CameraResponse = await this.http.request(camera, {
      method: body === undefined ? "GET" : "POST",
      path,
      ...(body === undefined ? {} : { body: JSON.stringify(body), contentType: "application/json" }),
      accept: "application/json",
      auth: "none",
      headers: { "bs-session-id": session },
    });
    if (res.status === 401) throw new CameraApiError("AUTH_FAILED", "BioStar 2 ended the session", { httpStatus: 401 });
    if (res.status === 404) throw new CameraApiError("API_UNAVAILABLE", `BioStar 2 has no ${path.split("?")[0]}`, { httpStatus: 404 });
    if (res.status < 200 || res.status >= 300) throw new CameraApiError("API_ERROR", `BioStar 2 answered HTTP ${res.status} for ${path.split("?")[0]}`, { httpStatus: res.status, transient: res.status >= 500 });
    return json(res.body, `BioStar 2 ${path.split("?")[0]}`);
  }

  private async session<T>(camera: CameraConfig, fn: (session: string) => Promise<T>): Promise<T> {
    const session = await this.login(camera);
    try {
      return await fn(session);
    } finally {
      await this.call(camera, session, "/api/logout", {}).catch(() => undefined);
    }
  }

  async getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    return this.session(camera, async (s) => {
      const devices = rows(await this.call(camera, s, "/api/devices"), "DeviceCollection");
      return { deviceName: "BioStar 2", model: `BioStar 2 server, ${devices.length} device(s)` };
    });
  }

  async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    await this.getDeviceInfo(camera);
    return { devices: [] };
  }

  testConnection(camera: CameraConfig) {
    return runAccessDiagnostics(this, camera);
  }

  private async eventNames(camera: CameraConfig, session: string): Promise<Map<string, string>> {
    const key = `${camera.host}:${camera.port}`;
    const cached = eventTypes.get(key);
    if (cached && Date.now() - cached.at < 3600_000) return cached.names;
    const names = new Map<string, string>();
    try {
      for (const r of rows(await this.call(camera, session, "/api/event_types?limit=0"), "EventTypeCollection")) {
        const code = str(r.code);
        const name = str(r.name) ?? str(r.description);
        if (code && name) names.set(code, name);
      }
    } catch {
      // Names stay unknown: events show their code.
    }
    eventTypes.set(key, { at: Date.now(), names });
    return names;
  }

  async getAccessStatus(camera: CameraConfig, afterMs: number): Promise<AccessReading> {
    return this.session(camera, async (s) => {
      const points: AccessPoint[] = rows(await this.call(camera, s, "/api/devices"), "DeviceCollection").map((d) => {
        const type = ref(d.device_type_id);
        return {
          kind: "reader" as const,
          externalId: str(d.id) ?? "",
          name: str(d.name) ?? `Device ${str(d.id)}`,
          ...(str(type?.name) ? { model: str(type?.name)! } : {}),
          online: deviceOnline(d.status),
          ...(str(d.status) && deviceOnline(d.status) === undefined ? { statusText: `Status ${str(d.status)}` } : {}),
        };
      }).filter((p) => p.externalId);
      const doors: AccessPoint[] = [];
      try {
        for (const d of rows(await this.call(camera, s, "/api/doors"), "DoorCollection")) {
          const id = str(d.id);
          if (id) doors.push({ kind: "door", externalId: id, name: str(d.name) ?? `Door ${id}` });
        }
      } catch {
        // Doors are optional (a BioStar 2 without doors configured).
      }
      let events: AccessEventReading[] = [];
      let eventsError: string | undefined;
      try {
        const names = await this.eventNames(camera, s);
        const reply = await this.call(camera, s, "/api/events/search", {
          Query: {
            limit: 200,
            conditions: [{ column: "datetime", operator: 3, values: [new Date(afterMs - 1000).toISOString(), new Date(Date.now() + 60_000).toISOString()] }],
            orders: [{ column: "datetime", descending: false }],
          },
        });
        const got = parseBioStarEvents(reply, names);
        events = got.events;
        for (const d of doors) {
          const st = got.doors.get(d.externalId);
          if (st) d.doorState = st;
        }
        for (const p of points) {
          const t = got.tamper.get(p.externalId);
          if (t !== undefined) p.tamper = t;
        }
      } catch (err) {
        eventsError = err instanceof CameraApiError ? err.message : "could not be read";
      }
      return { points: [...points, ...doors], events, ...(eventsError ? { eventsError } : {}) };
    });
  }
}
