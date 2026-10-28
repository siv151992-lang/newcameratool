import { execFile } from "node:child_process";
import net from "node:net";
import { HttpError } from "../lib/errors.js";
import { HostNotAllowedError, normalizeHost } from "../security/hostGuard.js";
import { hostGuard } from "../security/hostGuardInstance.js";
import { getCameraRow } from "./cameraService.js";

const TRIES = 4;
const TIMEOUT_MS = 2000;
const RTSP_PORT = 554;

/** One port's answers: the time of each connection, or null where it got none. */
export interface PortPing {
  port: number;
  label: string;
  times: (number | null)[];
  /** Why the last try got no answer (refused, timed out, …). */
  error?: string;
  /** The address refused the connection: something is there, but nothing listens on this port. */
  refused?: boolean;
}
export interface PingResult {
  host: string;
  address: string;
  /** ICMP echo (the system's ping), when this server may send it; otherwise why not. */
  icmp: { times: (number | null)[] } | { unavailable: string };
  ports: PortPing[];
  /** Answered on any of them (a refused connection is an answer too). */
  reachable: boolean;
  /** A port accepted the connection. */
  portOpen: boolean;
}

/**
 * Pings a camera from this server: ICMP echo (when the system's ping is there and allowed) and a
 * TCP connection to its web port and RTSP port, four times each. Many cameras and networks drop
 * ICMP, so the ports show whether the camera itself answers. Only the camera's own address is
 * reached, after the same address check as every other request to it.
 */
export async function pingCamera(orgId: string, cameraId: string): Promise<PingResult> {
  const row = await getCameraRow(cameraId, orgId);
  let host: string;
  let address: string;
  try {
    host = normalizeHost(row.host);
    ({ address } = await hostGuard.resolve(host));
  } catch (err) {
    throw new HttpError(400, "HOST_NOT_ALLOWED", err instanceof HostNotAllowedError ? err.message : "Invalid camera address");
  }
  const ports = [{ port: row.port, label: row.protocol === "https" ? "HTTPS" : "HTTP" }];
  if (row.port !== RTSP_PORT) ports.push({ port: RTSP_PORT, label: "RTSP (video)" });
  const [icmp, ...tcp] = await Promise.all([icmpPing(address), ...ports.map((p) => tcpPing(address, p.port, p.label))]);
  const answered = (times: (number | null)[]) => times.some((t) => t !== null);
  return {
    host, address, icmp: icmp!, ports: tcp as PortPing[],
    reachable: ("times" in icmp! && answered(icmp.times)) || (tcp as PortPing[]).some((p) => answered(p.times) || p.refused),
    portOpen: (tcp as PortPing[]).some((p) => answered(p.times)),
  };
}

async function tcpPing(address: string, port: number, label: string): Promise<PortPing> {
  const times: (number | null)[] = [];
  let error: string | undefined;
  let refused = false;
  for (let i = 0; i < TRIES; i++) {
    const r = await connectOnce(address, port);
    times.push(r.ms);
    if (r.error) error = r.error;
    refused ||= Boolean(r.refused);
  }
  return { port, label, times, ...(times.every((t) => t === null) && error ? { error, ...(refused ? { refused } : {}) } : {}) };
}

function connectOnce(address: string, port: number): Promise<{ ms: number | null; error?: string; refused?: boolean }> {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const socket = net.connect({ host: address, port });
    const done = (r: { ms: number | null; error?: string; refused?: boolean }) => {
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(TIMEOUT_MS, () => done({ ms: null, error: `no answer within ${TIMEOUT_MS / 1000} s` }));
    socket.once("connect", () => done({ ms: Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10 }));
    socket.once("error", (err: Error & { code?: string }) =>
      done({ ms: null, refused: err.code === "ECONNREFUSED", error: err.code === "ECONNREFUSED" ? "connection refused: the address answered, but nothing listens on this port" : err.code === "EHOSTUNREACH" ? "no route to the camera" : (err.code ?? err.message) }),
    );
  });
}

/** The system's ping (no shell; the address is an IP from the address check). */
function icmpPing(address: string): Promise<PingResult["icmp"]> {
  const v6 = net.isIPv6(address);
  return new Promise((resolve) => {
    execFile("ping", [...(v6 ? ["-6"] : []), "-n", "-c", String(TRIES), "-i", "0.3", "-W", String(TIMEOUT_MS / 1000), address], { timeout: TRIES * TIMEOUT_MS + 3000 }, (err, stdout) => {
      const out = String(stdout ?? "");
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT") return resolve({ unavailable: "ping is not installed on this server" });
      resolve(parsePingOutput(out, TRIES) ?? { unavailable: "this server may not send ICMP ping (it needs the network permission to)" });
    });
  });
}

/** Each echo's time from ping's output (null for one lost), or null when ping did not run. */
export function parsePingOutput(out: string, tries: number): { times: (number | null)[] } | null {
  const seqTimes = new Map<number, number>();
  for (const m of out.matchAll(/(?:icmp_)?seq=(\d+).*?time[=<]([\d.]+)/g)) seqTimes.set(Number(m[1]), Number(m[2]));
  if (!seqTimes.size && !/packets transmitted/.test(out)) return null;
  // Sequence numbers start at 1 (Linux) or 0 (others).
  const first = Math.min(...seqTimes.keys(), 1);
  return { times: Array.from({ length: tries }, (_, i) => seqTimes.get(first + i) ?? null) };
}
