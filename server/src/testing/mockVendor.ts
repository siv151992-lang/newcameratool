import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A simulated camera from a fictional vendor ("Acme Vision") that no built-in adapter knows.
 * It serves a JSON storage API at /api/v1/storage (paged with ?page=) and an XML one at
 * /cgi-bin/storage.xml, behind HTTP Digest authentication. Used to exercise configurable API
 * integrations in tests and demos; its model is SIMULATED-ACME so it is never mistaken for hardware.
 */

export interface VendorDisk {
  slot: string;
  label: string;
  sizeMiB: number | string;
  freeMiB: number | string;
  state: string;
  access?: string;
}

export const DEFAULT_VENDOR_DISKS: VendorDisk[] = [
  { slot: "sd0", label: "microSD", sizeMiB: 122_070, freeMiB: 30_517, state: "Normal", access: "RW" },
  { slot: "sd1", label: "Slot 2", sizeMiB: 0, freeMiB: 0, state: "NoCard" },
];

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

export class MockVendorCamera {
  disks: VendorDisk[] = DEFAULT_VENDOR_DISKS.map((d) => ({ ...d }));
  mode: "ok" | "auth-fail" | "server-error" | "garbage" = "ok";
  requests: { path: string; authorized: boolean }[] = [];
  private server?: http.Server;
  private readonly nonces = new Set<string>();
  private readonly realm = "AcmeVision";

  /** "hanwha" answers Hanwha Vision SUNAPI (stw-cgi) requests instead of the Acme API. */
  constructor(public username = "admin", public password = "Acme-Passw0rd!", public profile: "acme" | "hanwha" | "panasonic" | "uniview" = "acme") {}

  private verify(header: string | undefined, method: string): boolean {
    if (!header?.startsWith("Digest ")) return false;
    const p: Record<string, string> = {};
    for (const m of header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) p[m[1]!] = m[2] ?? m[3]!;
    if (!p.nonce || !this.nonces.has(p.nonce) || p.username !== this.username) return false;
    const ha1 = md5(`${this.username}:${this.realm}:${this.password}`);
    const ha2 = md5(`${method}:${p.uri}`);
    return md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`) === p.response;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, requestBody = "") {
    const url = new URL(req.url ?? "/", "http://camera");
    const authorized = this.mode !== "auth-fail" && this.verify(req.headers.authorization, req.method ?? "GET");
    this.requests.push({ path: url.pathname + url.search, authorized });
    if (!authorized) {
      const nonce = randomBytes(16).toString("hex");
      this.nonces.add(nonce);
      res.setHeader("WWW-Authenticate", `Digest qop="auth", realm="${this.realm}", nonce="${nonce}"`);
      res.statusCode = 401;
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    if (this.mode === "server-error") {
      res.statusCode = 500;
      return res.end(JSON.stringify({ error: "internal" }));
    }
    if (this.profile === "uniview") {
      // Like an IPC815SB-ADF14K-I0: storage only at Storage/Containers/DetailInfos (MiB), other paths "UnSupport".
      res.setHeader("Content-Type", "application/json");
      const reply = (code: number, data: unknown) =>
        JSON.stringify({ Response: { ResponseURL: url.pathname, CreatedID: -1, ResponseCode: code ? 4 : 0, SubResponseCode: 0, ResponseString: code ? "Not Supported" : "Succeed", StatusCode: code, StatusString: code ? "UnSupport" : "Succeed", Data: data } });
      const d = this.disks[0]!;
      if (url.pathname === "/LAPI/V1.0/Storage/Containers/DetailInfos") {
        return res.end(reply(0, { LocalHDDNum: 0, LocalHDDList: [], SDNum: 1, SDList: [{ ID: 1, RemainCapacity: Number(d.freeMiB), TotalCapacity: Number(d.sizeMiB), Manufacturer: "", Status: 3, Property: 0, FormatProgress: 0, GroupID: 0 }], NASNum: 0, NASList: [] }));
      }
      if (url.pathname.startsWith("/onvif/")) {
        // ONVIF Profile G: recording jobs and a recording summary (oldest recording 21 days ago).
        res.setHeader("Content-Type", "application/soap+xml");
        const env = (inner: string) => `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trc="http://www.onvif.org/ver10/recording/wsdl" xmlns:tse="http://www.onvif.org/ver10/search/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema"><s:Body>${inner}</s:Body></s:Envelope>`;
        const body = requestBody;
        if (body.includes("GetServices")) {
          return res.end(env(`<tds:GetServicesResponse><tds:Service><tds:Namespace>http://www.onvif.org/ver10/recording/wsdl</tds:Namespace><tds:XAddr>http://camera/onvif/recording_service</tds:XAddr></tds:Service><tds:Service><tds:Namespace>http://www.onvif.org/ver10/search/wsdl</tds:Namespace><tds:XAddr>http://camera/onvif/search_service</tds:XAddr></tds:Service></tds:GetServicesResponse>`));
        }
        if (body.includes("GetSystemDateAndTime")) {
          const d = new Date();
          const at = (x: Date) => `<tt:Date><tt:Year>${x.getUTCFullYear()}</tt:Year><tt:Month>${x.getUTCMonth() + 1}</tt:Month><tt:Day>${x.getUTCDate()}</tt:Day></tt:Date><tt:Time><tt:Hour>${x.getUTCHours()}</tt:Hour><tt:Minute>${x.getUTCMinutes()}</tt:Minute><tt:Second>${x.getUTCSeconds()}</tt:Second></tt:Time>`;
          return res.end(env(`<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:UTCDateTime>${at(d)}</tt:UTCDateTime><tt:LocalDateTime>${at(new Date(d.getTime() + 330 * 60_000))}</tt:LocalDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`));
        }
        if (body.includes("GetRecordingJobs")) {
          return res.end(env(`<trc:GetRecordingJobsResponse><trc:JobItem><trc:JobToken>RecordJob_1</trc:JobToken><trc:JobConfiguration><tt:RecordingToken>Recording_1</tt:RecordingToken><tt:Mode>Active</tt:Mode></trc:JobConfiguration></trc:JobItem></trc:GetRecordingJobsResponse>`));
        }
        if (body.includes("GetRecordingSummary")) {
          const from = new Date(Date.now() - 21 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
          return res.end(env(`<tse:GetRecordingSummaryResponse><tse:Summary><tt:DataFrom>${from}</tt:DataFrom><tt:DataUntil>${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}</tt:DataUntil><tt:NumberRecordings>1</tt:NumberRecordings></tse:Summary></tse:GetRecordingSummaryResponse>`));
        }
        res.statusCode = 400;
        return res.end(env(`<s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>ter:ActionNotSupported</s:Value></s:Subcode></s:Code><s:Reason><s:Text>Optional Action Not Implemented</s:Text></s:Reason></s:Fault>`));
      }
      if (url.pathname === "/LAPI/V1.0/System/DeviceInfo") {
        return res.end(reply(0, { ID: 0, DeviceName: "SIMULATED-UNIVIEW", DeviceModel: "SIMULATED-UNIVIEW", SerialNumber: "UNV0001", FirmwareVersion: "GIPC-B6203.15.6" }));
      }
      return res.end(reply(8, "null"));
    }
    if (this.profile === "panasonic") {
      if (url.pathname === "/cgi-bin/getinfo" && url.searchParams.get("FILE") === "1") {
        res.setHeader("Content-Type", "text/plain");
        return res.end("<HTML>\r\nMAC=00-80-45-00-00-01\r\nSERIAL=SIM0001\r\nVERSION=3.50\r\nNAME=SIMULATED-IPRO\r\nSDrec=on\r\nFIRMWARE=s32302\r\n</HTML>\r\n");
      }
      if (url.pathname === "/admin/setup_sdcard.html") {
        res.setHeader("Content-Type", "text/html");
        const d = this.disks[0]!;
        return res.end(`<html><head><script>\nvar gsSdMode = "sdrec";\nvar sRemSD = "${d.freeMiB}";\nvar sRemSD2 = "-";\nvar sTotalSD = "${d.sizeMiB}";\nvar sTotalSD2 = "-";\nvar sTotalSDplus = 0;\n</script></head><body></body></html>`);
      }
      res.statusCode = 404;
      return res.end("Not Found");
    }
    if (this.profile === "hanwha") {
      res.setHeader("Content-Type", "text/plain");
      const sub = url.pathname === "/stw-cgi/system.cgi" ? url.searchParams.get("msubmenu") : null;
      if (sub === "storageinfo") {
        return res.end(this.disks.map((d, i) => `Storage.${i}.Type=MicroSD\r\nStorage.${i}.Status=${d.state === "NoCard" ? "None" : d.state}\r\nStorage.${i}.TotalSpace=${d.sizeMiB}\r\nStorage.${i}.FreeSpace=${d.freeMiB}\r\n`).join(""));
      }
      if (url.pathname === "/stw-cgi/recording.cgi" && url.searchParams.get("msubmenu") === "storage") {
        return res.end("Enable=True\r\nOverWrite=True\r\nAutoDeleteEnable=True\r\nAutoDeleteDays=180\r\n");
      }
      if (url.pathname === "/stw-cgi/eventstatus.cgi") {
        return res.end("Channel.0.Connected=True\r\nSystemEvent.SDFail=False\r\nSystemEvent.SDFull=False\r\nSystemEvent.SDInsert=True\r\n");
      }
      if (sub === "deviceinfo") return res.end("Model=SIMULATED-WISENET\r\nSerialNumber=HANWHA0001\r\nFirmwareVersion=2.21.02\r\nConnectedMACAddress=00:09:18:00:00:01\r\n");
      return res.end("NG\r\nError Code: 600\r\nError Details: Submenu Not Found\r\n");
    }
    if (url.pathname === "/api/v1/storage") {
      res.setHeader("Content-Type", "application/json");
      if (this.mode === "garbage") return res.end("{\"result\": ");
      const page = Number(url.searchParams.get("page") ?? "1");
      const items = page === 1 ? this.disks : [];
      return res.end(JSON.stringify({ result: "ok", page, apiToken: "do-not-show-this", storage: { devices: items } }));
    }
    if (url.pathname === "/api/v1/system") {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ system: { model: "SIMULATED-ACME", serial: "ACME0001", firmware: "2.4.1" } }));
    }
    if (url.pathname === "/cgi-bin/storage.xml") {
      res.setHeader("Content-Type", "application/xml");
      const disk = (d: VendorDisk) =>
        `<Disk slot="${d.slot}"><Label>${d.label}</Label><SizeMiB>${d.sizeMiB}</SizeMiB><FreeMiB>${d.freeMiB}</FreeMiB><State>${d.state}</State>${d.access ? `<Access>${d.access}</Access>` : ""}</Disk>`;
      return res.end(`<?xml version="1.0"?><acme:Storage xmlns:acme="urn:acme"><Disks>${this.disks.map(disk).join("")}</Disks></acme:Storage>`);
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  }

  async start(port = 0, host = "127.0.0.1"): Promise<number> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => this.handle(req, res, Buffer.concat(chunks).toString("utf8")));
    });
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async stop() {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
