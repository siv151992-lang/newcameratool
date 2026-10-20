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
      "/ISAPI/ContentMgmt/Recording/status": () => recordingXml(this.recording),
    };
    if (this.mode === "not-found" || !routes[path]) {
      res.statusCode = 404;
      return res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ResponseStatus version="1.0" xmlns="http://www.hikvision.com/ver10/XMLSchema"><requestURL>${path}</requestURL><statusCode>4</statusCode><statusString>Invalid Operation</statusString><subStatusCode>notSupport</subStatusCode></ResponseStatus>`,
      );
    }
    res.end(routes[path]!());
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
