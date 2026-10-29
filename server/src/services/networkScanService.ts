import http from "node:http";
import net from "node:net";
import { z } from "zod";
import { pool } from "../db/pool.js";
import { probeOnvifEndpoint } from "../integrations/onvif/discovery.js";
import { HttpError } from "../lib/errors.js";
import { hostGuard } from "../security/hostGuardInstance.js";
import { type Actor, audit } from "./auditService.js";

/** At most this many addresses per scan (a /22). */
export const MAX_SCAN_ADDRESSES = 1024;
/**
 * Ports cameras answer on: web, HTTPS, RTSP, and the Hikvision (8000) and Dahua (37777) SDK ports.
 * `web` is the one read to tell the brand. Tunable for tests (which cannot use port 80).
 */
export const scanPorts = { all: [80, 443, 554, 8000, 37777], web: 80 };
const CONNECT_TIMEOUT_MS = 700;
const HTTP_TIMEOUT_MS = 2500;
const CONCURRENCY = 128;

export const scanRequestSchema = z.object({
  /** 192.168.1.0/24, 192.168.1.10-192.168.1.60, 192.168.1.10-60 or one address. */
  range: z.string().trim().min(7).max(40),
}).strict();

export interface FoundDevice {
  ip: string;
  /** Ports that accepted a connection. */
  openPorts: number[];
  /** The brand the device looks like (an integration key), or null when not recognised. */
  brand: string | null;
  /** What gave it away, e.g. "Hikvision ISAPI login" or "ONVIF discovery". */
  evidence: string[];
  /** Where to reach it: its web port and protocol. */
  port: number;
  protocol: "http" | "https";
  /** It answered an ONVIF discovery probe. */
  onvif: boolean;
  /** Already registered in this organization (at this address). */
  alreadyAdded: boolean;
}

/** The IPv4 addresses a range means. Throws a 400 for anything else or more than MAX_SCAN_ADDRESSES. */
export function parseRange(input: string): string[] {
  const toInt = (ip: string) => {
    if (net.isIPv4(ip) !== true) throw new HttpError(400, "INVALID_RANGE", `${ip} is not an IPv4 address`);
    return ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);
  };
  const toIp = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  const s = input.replace(/\s+/g, "");
  let from: number, to: number;
  const cidr = /^([\d.]+)\/(\d{1,2})$/.exec(s);
  const dash = /^([\d.]+)-([\d.]+)$/.exec(s);
  if (cidr) {
    const bits = Number(cidr[2]);
    if (bits < 22 || bits > 32) throw new HttpError(400, "INVALID_RANGE", `Scan at most ${MAX_SCAN_ADDRESSES} addresses (a /22 or smaller)`);
    const base = toInt(cidr[1]!) & (bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0);
    from = base >>> 0;
    to = (base + 2 ** (32 - bits) - 1) >>> 0;
    // A network's own address and its broadcast address are no devices.
    if (bits <= 30) {
      from += 1;
      to -= 1;
    }
  } else if (dash) {
    from = toInt(dash[1]!);
    const end = dash[2]!;
    // 192.168.1.10-60: the last part only.
    to = /^\d{1,3}$/.test(end) ? toInt(dash[1]!.replace(/\d+$/, end)) : toInt(end);
  } else {
    from = to = toInt(s);
  }
  if (to < from) throw new HttpError(400, "INVALID_RANGE", "The range ends before it starts");
  if (to - from + 1 > MAX_SCAN_ADDRESSES) throw new HttpError(400, "INVALID_RANGE", `Scan at most ${MAX_SCAN_ADDRESSES} addresses at a time`);
  return Array.from({ length: to - from + 1 }, (_, i) => toIp(from + i));
}

/** Whether something accepts a TCP connection on the port. */
function isOpen(ip: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** A plain HTTP GET without any login: status, headers and the start of the body. */
function peek(ip: string, port: number, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string } | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: ip, port, path, timeout: HTTP_TIMEOUT_MS, headers: { "User-Agent": "CCTV-Monitor-Scan" } }, (res) => {
      let body = "";
      res.setEncoding("latin1");
      res.on("data", (c: string) => {
        if (body.length < 16_384) body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

/** Brands recognised from a device's unauthenticated web replies. */
const SIGNATURES: { brand: string; label: string; test: RegExp }[] = [
  { brand: "hikvision", label: "Hikvision", test: /hikvision|ISAPI|DNVRS-Webs|App-webs|doc\/page\/login\.asp/i },
  { brand: "dahua", label: "Dahua", test: /dahua|\/RPC2|RPC2_Login|WEB SERVICE|Login to [0-9A-Z]{8,}/i },
  { brand: "uniview", label: "Uniview", test: /uniview|\/LAPI\//i },
  { brand: "hanwha", label: "Hanwha Vision (Wisenet)", test: /wisenet|hanwha|samsung techwin|stw-cgi/i },
  { brand: "axis", label: "Axis", test: /\baxis\b|axis-cgi/i },
  { brand: "reolink", label: "Reolink", test: /reolink/i },
  { brand: "bosch", label: "Bosch", test: /bosch|rcp\.xml/i },
  { brand: "panasonic", label: "Panasonic / i-PRO", test: /panasonic|i-pro|cgi-bin\/camctrl/i },
];

/** What the device is, from what it answers without a login (and the ports it has open). */
async function identify(ip: string, open: number[]): Promise<Omit<FoundDevice, "alreadyAdded">> {
  const evidence: string[] = [];
  let brand: string | null = null;
  const web = open.includes(scanPorts.web) ? scanPorts.web : null;
  if (web) {
    // Hikvision answers its API's login challenge even to strangers; the others are told by their pages.
    for (const path of ["/ISAPI/System/deviceInfo", "/"]) {
      const r = await peek(ip, web, path);
      if (!r) continue;
      const text = [r.headers.server, r.headers["www-authenticate"], r.body.slice(0, 16_384)].filter(Boolean).join(" ");
      const hit = path === "/ISAPI/System/deviceInfo" && (r.status === 401 || r.status === 200) && /digest|basic/i.test(String(r.headers["www-authenticate"] ?? "")) && !/RPC2|dahua/i.test(text)
        ? SIGNATURES[0]!
        : SIGNATURES.find((sig) => sig.test.test(text));
      if (hit) {
        brand = hit.brand;
        evidence.push(hit === SIGNATURES[0] && path !== "/" ? "Hikvision ISAPI login" : `${hit.label} web page`);
        break;
      }
    }
  }
  if (!brand && open.includes(8000)) {
    brand = "hikvision";
    evidence.push("Hikvision SDK port 8000");
  }
  if (!brand && open.includes(37777)) {
    brand = "dahua";
    evidence.push("Dahua SDK port 37777");
  }
  const onvif = await probeOnvifEndpoint(ip, 1500).catch(() => undefined);
  if (onvif) evidence.push(`ONVIF discovery (port ${onvif.port})`);
  if (!brand && onvif) brand = "onvif";
  if (open.includes(554)) evidence.push("RTSP video port 554");
  const protocol = web ? "http" : open.includes(443) ? "https" : onvif?.protocol ?? "http";
  const port = web ?? (open.includes(443) ? 443 : onvif?.port ?? 80);
  return { ip, openPorts: open, brand, evidence, port, protocol, onvif: Boolean(onvif) };
}

const ipNumber = (ip: string) => ip.split(".").reduce((a, o) => a * 256 + Number(o), 0);

/** Runs `fn` over the items, at most `limit` at a time. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

/**
 * Looks for cameras in an address range: which addresses accept connections on the usual camera
 * ports, then what each one is, from what it answers without a login and from ONVIF discovery. Only
 * addresses inside the allowed camera networks are touched, and no credentials are ever sent.
 */
export async function scanNetwork(orgId: string, range: string, actor: Actor, ip?: string | null) {
  const started = Date.now();
  const all = parseRange(range);
  const allowed: string[] = [];
  for (const a of all) if (await hostGuard.allows(a)) allowed.push(a);
  if (!allowed.length) {
    throw new HttpError(400, "HOST_NOT_ALLOWED", "None of these addresses is inside the allowed camera networks (Settings → Camera networks)");
  }
  // Every address and port at once (bounded): a camera is anything with one of them open.
  const probes = allowed.flatMap((a) => scanPorts.all.map((port) => ({ a, port })));
  const results = await mapLimited(probes, CONCURRENCY, async (p) => ((await isOpen(p.a, p.port)) ? p : null));
  const openByIp = new Map<string, number[]>();
  for (const r of results) if (r) openByIp.set(r.a, [...(openByIp.get(r.a) ?? []), r.port]);
  const found = await mapLimited([...openByIp.entries()], 16, ([a, ports]) => identify(a, ports.sort((x, y) => x - y)));
  const { rows } = await pool.query<{ host: string }>(
    "SELECT DISTINCT host FROM cameras WHERE organization_id = $1 AND deleted_at IS NULL AND host = ANY($2::text[])",
    [orgId, found.map((f) => f.ip)],
  );
  const registered = new Set(rows.map((r) => r.host));
  const devices: FoundDevice[] = found
    .map((f) => ({ ...f, alreadyAdded: registered.has(f.ip) }))
    .sort((x, y) => ipNumber(x.ip) - ipNumber(y.ip));
  await audit({ actor, ip, organizationId: orgId, action: "camera.network_scan", entityType: "camera", entityId: null, details: { range, scanned: allowed.length, found: devices.length } });
  return { range, scanned: allowed.length, skipped: all.length - allowed.length, devices, durationMs: Date.now() - started };
}
