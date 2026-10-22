import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A simulated Hikvision camera exposing the ISAPI storage and device-info endpoints behind
 * HTTP Digest authentication. Used by automated tests and for local demos
 * (npm run mock-camera). Its device info identifies it as SIMULATED so it is never
 * mistaken for real hardware.
 */

export interface MockDisk {
  id: number | string;
  name?: string;
  type?: string;
  status?: string;
  capacityMb?: number | string;
  freeMb?: number | string;
  property?: string;
  formatType?: string;
}

export type MockMode = "ok" | "auth-fail" | "not-found" | "server-error" | "hang" | "basic-only" | "garbage";

export function storageXml(disks: MockDisk[]): string {
  const hdd = (d: MockDisk) =>
    [
      "<hdd>",
      `<id>${d.id}</id>`,
      d.name !== undefined ? `<hddName>${d.name}</hddName>` : "",
      "<hddPath></hddPath>",
      d.type !== undefined ? `<hddType>${d.type}</hddType>` : "<hddType>SATA</hddType>",
      d.status !== undefined ? `<status>${d.status}</status>` : "",
      d.capacityMb !== undefined ? `<capacity>${d.capacityMb}</capacity>` : "",
      d.freeMb !== undefined ? `<freeSpace>${d.freeMb}</freeSpace>` : "",
      d.property !== undefined ? `<property>${d.property}</property>` : "",
      d.formatType !== undefined ? `<formatType>${d.formatType}</formatType>` : "",
      "</hdd>",
    ].join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<storage version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<hddList version="1.0" xmlns="http://www.hikvision.com/ver10/XMLSchema">${disks.map(hdd).join("")}</hddList>
<nasList version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<supportMountType opt="NFS,SMB/CIFS"/><authentication opt="SMB/CIFS"/></nasList>
<workMode>quota</workMode>
</storage>`;
}

export function recordingXml(status: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<RecordingStatus version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<status>${status}</status>
<TrackStatusList><TrackStatus><id>101</id><videoRecordStatus>${status}</videoRecordStatus><audioRecordStatus>${status}</audioRecordStatus></TrackStatus></TrackStatusList>
</RecordingStatus>`;
}

export const DEFAULT_DEVICE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<DeviceInfo version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema">
<deviceName>Simulated Camera</deviceName><deviceID>00000000-0000</deviceID>
<model>SIMULATED-HIKVISION</model><serialNumber>SIM0000000001</serialNumber>
<macAddress>00:00:00:00:00:01</macAddress><firmwareVersion>V0.0.0</firmwareVersion>
<firmwareReleasedDate>build 000000</firmwareReleasedDate><deviceType>IPCamera</deviceType>
</DeviceInfo>`;

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

export class MockHikvisionCamera {
  mode: MockMode = "ok";
  storage: string;
  deviceInfo = DEFAULT_DEVICE_INFO;
  /** Value of <status> in the recording-status response: recording | idle | error. */
  recording = "recording";
  /**
   * false: like many real IP cameras, Recording/status is missing (404) and recording is only
   * visible through the recording search (System/time, ContentMgmt/search, record/tracks/101).
   */
  recordingStatusApi = true;
  /** Search mode: the camera's UTC offset, and whether search replies are in UTC (as some firmware does). */
  utcOffsetMinutes = 0;
  searchRepliesUtc = false;
  /** Delay before every reply, to behave like a real camera on a network (load tests). */
  latencyMs = 0;
  /** Search mode: how many days of recordings the card holds (the oldest segment starts then). */
  recordedDays = 30;
  requests: { path: string; authorized: boolean }[] = [];
  private server?: http.Server;
  private readonly nonces = new Set<string>();
  private readonly realm = "IP Camera(SIM)";

  constructor(
    public username = "admin",
    public password = "Sim-Passw0rd!",
    disks: MockDisk[] = [{ id: 1, name: "hdde", status: "ok", capacityMb: 121942, freeMb: 56362, property: "RW", formatType: "EXT4" }],
  ) {
    this.storage = storageXml(disks);
  }

  setDisks(disks: MockDisk[]) {
    this.storage = storageXml(disks);
  }

  private challenge(res: http.ServerResponse) {
    const nonce = randomBytes(16).toString("hex");
    if (this.nonces.size > 200_000) this.nonces.clear(); // bounded for long load tests
    this.nonces.add(nonce);
    if (this.mode === "basic-only") {
      res.setHeader("WWW-Authenticate", `Basic realm="${this.realm}"`);
    } else {
      res.setHeader("WWW-Authenticate", `Digest qop="auth", realm="${this.realm}", nonce="${nonce}", stale="FALSE"`);
    }
    res.statusCode = 401;
    res.end("<ResponseStatus><statusCode>4</statusCode><statusString>Unauthorized</statusString></ResponseStatus>");
  }

  private verify(header: string | undefined, method: string): boolean {
    if (!header?.startsWith("Digest ")) return false;
    const p: Record<string, string> = {};
    for (const m of header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) p[m[1]!] = m[2] ?? m[3]!;
    if (!p.nonce || !this.nonces.has(p.nonce) || p.username !== this.username || p.realm !== this.realm) return false;
    const ha1 = md5(`${this.username}:${this.realm}:${this.password}`);
    const ha2 = md5(`${method}:${p.uri}`);
    const expected = md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
    return expected === p.response;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (this.latencyMs > 0) setTimeout(() => this.respond(req, res, body), this.latencyMs);
      else this.respond(req, res, body);
    });
  }

  private respond(req: http.IncomingMessage, res: http.ServerResponse, body = "") {
    const path = req.url ?? "/";
    if (this.mode === "hang") return; // never respond: exercises timeouts
    const authorized = this.mode !== "auth-fail" && this.verify(req.headers.authorization, req.method ?? "GET");
    this.requests.push({ path, authorized });
    if (!authorized) return this.challenge(res);
    res.setHeader("Content-Type", "application/xml");
    if (this.mode === "server-error") {
      res.statusCode = 500;
      return res.end("Internal error");
    }
    if (this.mode === "garbage") return res.end("<storage><hddList><hdd>broken");
    const routes: Record<string, () => string> = {
      "/ISAPI/ContentMgmt/Storage": () => this.storage,
      "/ISAPI/System/deviceInfo": () => this.deviceInfo,
      ...(this.recordingStatusApi ? { "/ISAPI/ContentMgmt/Recording/status": () => recordingXml(this.recording) } : this.searchRoutes(body)),
    };
    if (this.mode === "not-found" || !routes[path]) {
      res.statusCode = 404;
      return res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ResponseStatus version="1.0" xmlns="http://www.hikvision.com/ver10/XMLSchema"><requestURL>${path}</requestURL><statusCode>4</statusCode><statusString>Invalid Operation</statusString><subStatusCode>notSupport</subStatusCode></ResponseStatus>`,
      );
    }
    res.end(routes[path]!());
  }

  private searchRoutes(searchBody: string): Record<string, () => string> {
    const wall = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
    const offsetMs = this.utcOffsetMinutes * 60_000;
    const now = Date.now() + offsetMs; // camera local wall clock
    const tz = `${this.utcOffsetMinutes < 0 ? "-" : "+"}${String(Math.floor(Math.abs(this.utcOffsetMinutes) / 60)).padStart(2, "0")}:${String(Math.abs(this.utcOffsetMinutes) % 60).padStart(2, "0")}`;
    const reply = (ms: number) => wall(this.searchRepliesUtc ? ms - offsetMs : ms);
    // recording: the current segment ends now; error: continuous recording stopped 2 hours ago;
    // idle: nothing recorded and recording is turned off.
    const lastEnd = this.recording === "recording" ? now - 20_000 : this.recording === "error" ? now - 2 * 3600_000 : undefined;
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
    return {
      "/ISAPI/System/time": () => `<?xml version="1.0" encoding="UTF-8"?><Time version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><timeMode>NTP</timeMode><localTime>${wall(now).slice(0, 19)}${tz}</localTime></Time>`,
      "/ISAPI/ContentMgmt/search": () => {
        // Segments: the oldest (recordedDays ago) when the requested period reaches back to it, and
        // the one being written (recording) or last written (error).
        const from = Date.parse(/<startTime>([^<]+)<\/startTime>/.exec(searchBody)?.[1] ?? "") || now;
        const oldestStart = now - this.recordedDays * 86_400_000;
        const items: [number, number][] = [];
        if (this.recording !== "idle" && from <= oldestStart) items.push([oldestStart, oldestStart + 3600_000]);
        if (lastEnd !== undefined && this.recording === "recording") items.push([lastEnd - 3600_000, lastEnd]);
        if (items.length === 0) {
          return `<?xml version="1.0" encoding="UTF-8"?><CMSearchResult version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><responseStatus>false</responseStatus><responseStatusStrg>NO MATCHES</responseStatusStrg><numOfMatches>0</numOfMatches></CMSearchResult>`;
        }
        const matches = items.map(([a, b]) => `<searchMatchItem><trackID>101</trackID><timeSpan><startTime>${reply(a)}</startTime><endTime>${reply(b)}</endTime></timeSpan></searchMatchItem>`).join("");
        return `<?xml version="1.0" encoding="UTF-8"?><CMSearchResult version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><responseStatus>true</responseStatus><responseStatusStrg>OK</responseStatusStrg><numOfMatches>${items.length}</numOfMatches><matchList>${matches}</matchList></CMSearchResult>`;
      },
      "/ISAPI/ContentMgmt/record/tracks/101": () =>
        `<?xml version="1.0" encoding="UTF-8"?><Track version="2.0" xmlns="http://www.hikvision.com/ver20/XMLSchema"><id>101</id><Enable>${this.recording === "idle" ? "false" : "true"}</Enable><TrackSchedule><ScheduleBlockList><ScheduleBlock>${days
          .map((d) => `<ScheduleAction><id>1</id><ScheduleActionStartTime><DayOfWeek>${d}</DayOfWeek><TimeOfDay>00:00:00</TimeOfDay></ScheduleActionStartTime><ScheduleActionEndTime><DayOfWeek>${d}</DayOfWeek><TimeOfDay>24:00:00</TimeOfDay></ScheduleActionEndTime><Actions><Record>true</Record><ActionRecordingMode>CMR</ActionRecordingMode></Actions></ScheduleAction>`)
          .join("")}</ScheduleBlock></ScheduleBlockList></TrackSchedule></Track>`,
    };
  }

  async start(port = 0, host = "127.0.0.1"): Promise<number> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async stop() {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
