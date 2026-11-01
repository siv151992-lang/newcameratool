import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import type { AccessEventReading, AccessPoint, AccessReading, BrandMeta, CameraBrandAdapter, CameraConfig, DeviceInfo, StorageReading } from "../types.js";
import { CameraApiError } from "../types.js";
import { categorize, json, requireHttps, runAccessDiagnostics, samePath } from "./common.js";

interface Item { id?: string; name?: string; statusFlags?: string[]; statusText?: string; type?: { name?: string } }
interface Page<T> { results?: T[]; next?: { href?: string } }
interface Discovery {
  version?: string;
  features?: {
    doors?: { doors?: { href?: string } };
    events?: { events?: { href?: string } };
    items?: { items?: { href?: string }; itemTypes?: { href?: string } };
  };
}
interface GallagherEvent {
  id?: string;
  time?: string;
  message?: string;
  source?: { name?: string };
  type?: { name?: string };
  group?: { name?: string };
  cardholder?: { name?: string; firstName?: string; lastName?: string };
  door?: { name?: string };
}

const OFFLINE = /^(controlleroffline|notpolled|devicenotresponding|offline|commsfailure|notresponding)$/i;

/** Gallagher statusFlags → online, door state, lock state and tamper. */
export function fromFlags(kind: AccessPoint["kind"], item: Item): AccessPoint {
  const flags = (item.statusFlags ?? []).map((f) => f.toLowerCase());
  const has = (f: string) => flags.includes(f.toLowerCase());
  const point: AccessPoint = { kind, externalId: item.id ?? "", name: item.name ?? `Item ${item.id}` };
  if (flags.length) point.online = !flags.some((f) => OFFLINE.test(f));
  if (has("tamper")) point.tamper = true;
  else if (flags.length) point.tamper = false;
  if (kind === "door") {
    point.doorState = has("forced") ? "forced" : has("openTooLong") ? "held_open" : has("open") ? "open" : has("closed") ? "closed" : undefined;
    point.lockState = has("unlocked") ? "unlocked" : has("locked") || has("secure") ? "locked" : undefined;
  }
  if (item.statusText) point.statusText = item.statusText;
  return point;
}

export function fromGallagherEvent(e: GallagherEvent): AccessEventReading | null {
  const at = Date.parse(e.time ?? "");
  if (!Number.isFinite(at) || !e.id) return null;
  const what = [e.group?.name, e.type?.name, e.message].filter(Boolean).join(" ");
  const person = e.cardholder?.name ?? ([e.cardholder?.firstName, e.cardholder?.lastName].filter(Boolean).join(" ") || undefined);
  const point = e.door?.name ?? e.source?.name;
  return {
    at,
    category: categorize(what),
    description: e.type?.name ?? e.message ?? "Event",
    ...(person ? { person } : {}),
    ...(point ? { point } : {}),
    key: e.id,
  };
}

/**
 * Gallagher readers and controllers (T-series readers on Controller 6000 / 7000), through Command
 * Centre's REST API: added once, with an API key from a REST client item in Command Centre (and the
 * REST API licence). Doors and their status, readers and controllers online or not, tamper, and the
 * events. The API key is only sent over HTTPS (port 8904 by default).
 */
export class GallagherAdapter implements CameraBrandAdapter {
  readonly meta: BrandMeta = {
    key: "gallagher",
    displayName: "Gallagher Command Centre",
    supportStatus: "unverified",
    authMethods: ["API key (GGL-API-KEY, HTTPS only)"],
    defaultPorts: { http: 8904, https: 8904 },
    defaultProtocol: "https",
    httpsOnly: true,
    credentials: "secret",
    capabilities: ["access-control", "connection-test"],
    defaultTimeoutMs: 15000,
    deviceKind: "access",
    notes:
      "Add the Command Centre server once (HTTPS, port 8904), with the API key of a REST client item (Configuration → Services and workstations → " +
      "REST client; the REST API licence is needed). Doors (open, forced, held open, locked), readers and controllers (online, tamper) and events.",
  };

  constructor(private readonly http: CameraHttpClient) {}

  private async get<T>(camera: CameraConfig, path: string): Promise<T> {
    requireHttps(camera, "The Command Centre API key");
    const res = await this.http.request(camera, { path, accept: "application/json", auth: { authorization: `GGL-API-KEY ${camera.password}` } });
    if (res.status === 404) throw new CameraApiError("API_UNAVAILABLE", `Command Centre has no ${path.split("?")[0]} (is the REST API licensed and enabled?)`, { httpStatus: 404 });
    if (res.status < 200 || res.status >= 300) throw new CameraApiError("API_ERROR", `Command Centre answered HTTP ${res.status} for ${path.split("?")[0]}`, { httpStatus: res.status, transient: res.status >= 500 });
    return json<T>(res.body, `Command Centre ${path.split("?")[0]}`);
  }

  private async all<T>(camera: CameraConfig, first: string, pages = 10): Promise<T[]> {
    const out: T[] = [];
    let path: string | undefined = first;
    for (let i = 0; path && i < pages; i++) {
      const page: Page<T> = await this.get<Page<T>>(camera, path);
      out.push(...(page.results ?? []));
      path = page.next?.href ? samePath(camera, page.next.href) : undefined;
    }
    return out;
  }

  private discover(camera: CameraConfig) {
    return this.get<Discovery>(camera, "/api");
  }

  async getDeviceInfo(camera: CameraConfig): Promise<DeviceInfo> {
    const d = await this.discover(camera);
    return { deviceName: "Command Centre", model: "Gallagher Command Centre", ...(d.version ? { firmwareVersion: d.version } : {}) };
  }

  async getStorageStatus(camera: CameraConfig): Promise<StorageReading> {
    await this.discover(camera);
    return { devices: [] };
  }

  testConnection(camera: CameraConfig) {
    return runAccessDiagnostics(this, camera);
  }

  async getAccessStatus(camera: CameraConfig, afterMs: number): Promise<AccessReading> {
    const d = await this.discover(camera);
    const fields = "fields=id,name,statusFlags,statusText";
    const href = (h: string | undefined, fallback: string) => (h ? samePath(camera, h) : fallback);
    const doorsPath = href(d.features?.doors?.doors?.href, "/api/doors");
    const points: AccessPoint[] = (await this.all<Item>(camera, `${doorsPath}?${fields}&top=1000`)).map((i) => fromFlags("door", i)).filter((p) => p.externalId);

    // Readers and controllers are items of their types (named "… Reader …", "Controller 6000" …).
    const itemsPath = href(d.features?.items?.items?.href, "/api/items");
    const typesPath = href(d.features?.items?.itemTypes?.href, "/api/items/types");
    const types = (await this.get<{ itemTypes?: { id?: string; name?: string }[] }>(camera, typesPath).catch(() => ({ itemTypes: [] }))).itemTypes ?? [];
    for (const t of types) {
      const kind = /reader/i.test(t.name ?? "") ? "reader" : /controller/i.test(t.name ?? "") ? "controller" : null;
      if (!kind || !t.id) continue;
      const items = await this.all<Item>(camera, `${itemsPath}?type=${encodeURIComponent(t.id)}&${fields}&top=1000`, 5);
      for (const i of items) {
        const p = fromFlags(kind, i);
        if (p.externalId) points.push({ ...p, model: t.name });
      }
    }

    let events: AccessEventReading[] = [];
    let eventsError: string | undefined;
    try {
      const eventsPath = href(d.features?.events?.events?.href, "/api/events");
      const after = encodeURIComponent(new Date(afterMs - 1000).toISOString());
      const list: GallagherEvent[] = [];
      let path: string | undefined = `${eventsPath}?after=${after}&top=200&fields=defaults,cardholder,door`;
      for (let i = 0; path && i < 5; i++) {
        const page: { events?: GallagherEvent[]; next?: { href?: string } } = await this.get(camera, path);
        list.push(...(page.events ?? []));
        path = page.events?.length && page.next?.href ? samePath(camera, page.next.href) : undefined;
      }
      events = list.map(fromGallagherEvent).filter((e): e is AccessEventReading => e !== null).sort((a, b) => a.at - b.at);
    } catch (err) {
      eventsError = err instanceof CameraApiError ? err.message : "could not be read";
    }
    return { points, events, ...(eventsError ? { eventsError } : {}) };
  }
}
