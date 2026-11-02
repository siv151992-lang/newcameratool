import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { MockHikvisionCamera } from "./mockHikvision.js";

/**
 * Simulated access control systems for tests and demos: a Hikvision access controller (ISAPI), a
 * Suprema BioStar 2 server and a Gallagher Command Centre server, each with readers, doors and an
 * event log that tests change (a reader goes offline, a door is forced, a card is refused).
 */

export interface MockReader { id: string; name: string; model?: string; online: boolean; tamper?: boolean }
export interface MockDoor { id: string; name: string; state: "open" | "closed" | "forced" | "held_open"; locked: boolean }

/** A Hikvision access controller: AcsWorkStatus and AcsEvent on top of the simulated camera. */
export class MockHikvisionAccess extends MockHikvisionCamera {
  doors: MockDoor[] = [{ id: "1", name: "Door 1", state: "closed", locked: true }, { id: "2", name: "Door 2", state: "closed", locked: true }];
  readers: MockReader[] = [{ id: "1", name: "Reader 1", online: true }, { id: "2", name: "Reader 2", online: true }];
  hostTamper = false;
  events: { major: number; minor: number; time: string; name?: string; doorNo?: number; serialNo: number }[] = [];
  private serial = 0;

  constructor(username = "admin", password = "Sim-Passw0rd!") {
    super(username, password);
    this.deviceInfo = this.deviceInfo.replace(/<deviceName>[^<]*<\/deviceName>/, "<deviceName>Main entrance</deviceName>").replace(/<model>[^<]*<\/model>/, "<model>DS-K1T671M</model>");
    this.custom = ({ path, method, body }) => {
      if (path === "/ISAPI/AccessControl/AcsWorkStatus?format=json") {
        return {
          contentType: "application/json",
          body: JSON.stringify({
            AcsWorkStatus: {
              doorLockStatus: this.doors.map((d) => (d.locked ? 0 : 1)),
              doorStatus: this.doors.map(() => 4),
              magneticStatus: this.doors.map((d) => (d.state === "closed" ? 0 : 1)),
              cardReaderOnlineStatus: this.readers.map((r) => (r.online ? 1 : 0)),
              cardReaderAntiDismantleStatus: this.readers.map((r) => (r.tamper ? 1 : 0)),
              hostAntiDismantleStatus: this.hostTamper ? "open" : "close",
            },
          }),
        };
      }
      if (path === "/ISAPI/AccessControl/AcsEvent?format=json" && method === "POST") {
        const cond = (JSON.parse(body || "{}") as { AcsEventCond?: { startTime?: string; searchResultPosition?: number; maxResults?: number } }).AcsEventCond ?? {};
        const from = Date.parse(cond.startTime ?? "1970-01-01T00:00:00Z");
        const all = this.events.filter((e) => Date.parse(e.time) >= from);
        const pos = cond.searchResultPosition ?? 0;
        const page = all.slice(pos, pos + (cond.maxResults ?? 30));
        return {
          contentType: "application/json",
          body: JSON.stringify({ AcsEvent: { searchID: "x", totalMatches: all.length, responseStatusStrg: pos + page.length < all.length ? "MORE" : "OK", numOfMatches: page.length, InfoList: page } }),
        };
      }
      return undefined;
    };
  }

  /** Adds an event to the controller's log (major 5 minor 1: card accepted; 5/9: unknown card; 5/27: door forced …). */
  addEvent(major: number, minor: number, opts: { name?: string; doorNo?: number; at?: number } = {}) {
    this.events.push({ major, minor, time: new Date(opts.at ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, "+00:00"), serialNo: ++this.serial, ...(opts.name ? { name: opts.name } : {}), ...(opts.doorNo ? { doorNo: opts.doorNo } : {}) });
  }
}

abstract class MockHttpsServer {
  protected server?: https.Server | http.Server;
  requests: { method: string; path: string }[] = [];
  protected abstract handle(req: http.IncomingMessage, body: string, res: http.ServerResponse): void;

  async start(port = 0, host = "127.0.0.1", tls?: { cert: string; key: string }): Promise<number> {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        this.requests.push({ method: req.method ?? "GET", path: req.url ?? "/" });
        this.handle(req, Buffer.concat(chunks).toString("utf8"), res);
      });
    };
    this.server = tls ? https.createServer(tls, handler) : http.createServer(handler);
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async stop() {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  protected send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }
}

/** Suprema BioStar 2: login with a session header, devices, doors, event types and event search. */
export class MockBioStar2 extends MockHttpsServer {
  readers: MockReader[] = [
    { id: "544100001", name: "Lobby BioStation 3", model: "BioStation 3", online: true },
    { id: "542200002", name: "Server room BioEntry W2", model: "BioEntry W2", online: true },
    { id: "546300003", name: "Car park BioEntry P2", model: "BioEntry P2", online: true },
  ];
  doors: { id: string; name: string }[] = [{ id: "1", name: "Lobby door" }, { id: "2", name: "Server room door" }];
  events: { id: string; datetime: string; code: string; device: string; door?: string; user?: string }[] = [];
  private sessions = new Set<string>();
  private nextId = 1;
  static readonly TYPES: Record<string, string> = {
    "4865": "IDENTIFY_SUCCESS_FACE",
    "4867": "IDENTIFY_SUCCESS_FINGERPRINT",
    "5123": "IDENTIFY_FAIL_FACE",
    "6401": "ACCESS_DENIED",
    "20992": "DOOR_OPENED",
    "21248": "DOOR_CLOSED",
    "21504": "DOOR_FORCED_OPEN",
    "21760": "DOOR_HELD_OPEN",
    "25344": "TAMPER_ON",
    "25600": "TAMPER_OFF",
  };

  constructor(public username = "admin", public password = "BioStar-Pass1!") {
    super();
  }

  addEvent(code: string, device: string, opts: { door?: string; user?: string; at?: number } = {}) {
    this.events.push({ id: String(this.nextId++), datetime: new Date(opts.at ?? Date.now()).toISOString(), code, device, ...opts });
  }

  protected handle(req: http.IncomingMessage, body: string, res: http.ServerResponse) {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/api/login" && req.method === "POST") {
      const u = (JSON.parse(body || "{}") as { User?: { login_id?: string; password?: string } }).User;
      if (u?.login_id !== this.username || u?.password !== this.password) return this.send(res, 401, { Response: { code: "1", message: "Login failed" } });
      const id = randomBytes(16).toString("hex");
      this.sessions.add(id);
      return this.send(res, 200, { User: { user_id: "1", name: "Administrator" } }, { "bs-session-id": id });
    }
    const session = req.headers["bs-session-id"];
    if (typeof session !== "string" || !this.sessions.has(session)) return this.send(res, 401, { Response: { code: "1", message: "Login required" } });
    if (path === "/api/logout") {
      this.sessions.delete(session);
      return this.send(res, 200, {});
    }
    const device = (id: string) => this.readers.find((r) => r.id === id);
    if (path === "/api/devices") {
      return this.send(res, 200, { DeviceCollection: { total: String(this.readers.length), rows: this.readers.map((r) => ({ id: r.id, name: r.name, device_type_id: { id: "1", name: r.model }, status: r.online ? "1" : "0" })) } });
    }
    if (path === "/api/doors") return this.send(res, 200, { DoorCollection: { total: String(this.doors.length), rows: this.doors } });
    if (path === "/api/event_types") return this.send(res, 200, { EventTypeCollection: { rows: Object.entries(MockBioStar2.TYPES).map(([code, name]) => ({ code, name })) } });
    if (path === "/api/events/search" && req.method === "POST") {
      const q = (JSON.parse(body || "{}") as { Query?: { limit?: number; conditions?: { column: string; values: string[] }[] } }).Query ?? {};
      const range = q.conditions?.find((c) => c.column === "datetime")?.values ?? [];
      const from = Date.parse(range[0] ?? "1970-01-01"), to = Date.parse(range[1] ?? "2999-01-01");
      const rows = this.events.filter((e) => Date.parse(e.datetime) >= from && Date.parse(e.datetime) <= to).slice(0, q.limit ?? 200).map((e) => ({
        id: e.id, datetime: e.datetime, event_type_id: { code: e.code },
        device_id: { id: e.device, name: device(e.device)?.name ?? e.device },
        ...(e.door ? { door_id: [{ id: e.door, name: this.doors.find((d) => d.id === e.door)?.name }] } : {}),
        ...(e.user ? { user_id: { user_id: "7", name: e.user } } : {}),
      }));
      return this.send(res, 200, { EventCollection: { rows } });
    }
    return this.send(res, 404, { Response: { code: "404", message: "Not found" } });
  }
}

/** Gallagher Command Centre: API key, discovery, doors, item types, items and events. */
export class MockGallagher extends MockHttpsServer {
  readers: MockReader[] = [
    { id: "601", name: "T15 Reader - Reception", model: "HBUS Terminal", online: true },
    { id: "602", name: "T20 Reader - Warehouse", model: "HBUS Terminal", online: true },
  ];
  controllers: MockReader[] = [{ id: "501", name: "Controller 6000 - Block A", model: "Controller 6000", online: true }];
  doors: MockDoor[] = [{ id: "701", name: "Reception door", state: "closed", locked: true }, { id: "702", name: "Warehouse door", state: "closed", locked: true }];
  events: { id: string; time: string; type: string; group: string; source: string; cardholder?: string; door?: string }[] = [];
  private nextId = 1000;

  constructor(public apiKey = "AB12-CD34-EF56-0789-AB12-CD34-EF56-0789") {
    super();
  }

  addEvent(type: string, group: string, source: string, opts: { cardholder?: string; door?: string; at?: number } = {}) {
    this.events.push({ id: String(this.nextId++), time: new Date(opts.at ?? Date.now()).toISOString(), type, group, source, ...opts });
  }

  /** Without the RESTStatus licence: no status subscriptions (403). */
  statusLicence = true;

  private flagsOf(id: string): { statusFlags: string[]; statusText: string } | undefined {
    const r = [...this.readers, ...this.controllers].find((x) => x.id === id);
    if (r) return { statusFlags: r.online ? (r.tamper ? ["tamper"] : []).concat(r.model?.startsWith("Controller") ? [] : ["normal"]) : ["controllerOffline"], statusText: r.online ? "Online" : "Controller offline.\n3 message(s) pending." };
    const d = this.doors.find((x) => x.id === id);
    if (d) {
      const state = d.state === "closed" ? ["closed"] : ["open", ...(d.state === "forced" ? ["forced"] : d.state === "held_open" ? ["openTooLong"] : [])];
      return { statusFlags: [...state, d.locked ? "locked" : "unlocked", "secure"], statusText: d.state === "closed" ? "Closed, secure" : "Open" };
    }
    return undefined;
  }

  protected handle(req: http.IncomingMessage, body: string, res: http.ServerResponse) {
    if (req.headers.authorization !== `GGL-API-KEY ${this.apiKey}`) return this.send(res, 401, { message: "Unauthorised" });
    const host = `https://${req.headers.host}`;
    const url = new URL(req.url ?? "/", host);
    if (url.pathname === "/api") {
      return this.send(res, 200, {
        version: "9.10.1234",
        features: {
          doors: { doors: { href: `${host}/api/doors` } },
          events: { events: { href: `${host}/api/events` } },
          items: { items: { href: `${host}/api/items` }, itemTypes: { href: `${host}/api/items/types` }, updates: { href: `${host}/api/items/updates` } },
        },
      });
    }
    if (url.pathname === "/api/doors") {
      // The search page knows no status for items nobody monitors: "unknown".
      const withStatus = (url.searchParams.get("fields") ?? "").includes("statusFlags");
      return this.send(res, 200, { results: this.doors.map((d) => ({ id: d.id, name: d.name, ...(withStatus ? { statusFlags: ["unknown"], statusText: "Unknown" } : {}) })) });
    }
    if (url.pathname === "/api/items/updates" && req.method === "POST") {
      if (!this.statusLicence) return this.send(res, 403, { message: "The site does not have the RESTStatus licence" });
      const ids = (JSON.parse(body || "{}") as { itemIds?: string[] }).itemIds ?? [];
      const updates = ids.map((id) => ({ id, ...this.flagsOf(id) })).filter((u) => u.statusFlags);
      return this.send(res, 200, { updates, next: { href: `${host}/api/items/updates?bookmark=x` } });
    }
    if (url.pathname === "/api/items/types") return this.send(res, 200, { itemTypes: [{ id: "11", name: "HBUS Terminal" }, { id: "12", name: "Controller 6000" }, { id: "1", name: "Cardholder", canonicalTypeName: "cardholder" }, { id: "14", name: "HBUS Door Module" }] });
    if (url.pathname === "/api/items") {
      const list = url.searchParams.get("type") === "11" ? this.readers : url.searchParams.get("type") === "12" ? this.controllers : [];
      // Item search gives no status (fields: href, id, name, type, division …).
      return this.send(res, 200, { results: list.map((r) => ({ id: r.id, name: r.name, type: { id: url.searchParams.get("type"), name: r.model } })) });
    }
    if (url.pathname === "/api/events") {
      const after = Date.parse(url.searchParams.get("after") ?? "1970-01-01");
      const events = this.events.filter((e) => Date.parse(e.time) > after).map((e) => ({
        id: e.id, time: e.time, message: `${e.type} at ${e.source}`, type: { name: e.type }, group: { name: e.group }, source: { name: e.source },
        ...(e.cardholder ? { cardholder: { name: e.cardholder } } : {}), ...(e.door ? { door: { name: e.door } } : {}),
      }));
      return this.send(res, 200, { events });
    }
    return this.send(res, 404, { message: "Not found" });
  }
}
