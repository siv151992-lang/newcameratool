import { randomBytes } from "node:crypto";
import net from "node:net";
import { digestAuthorization, parseChallenge } from "../integrations/http/cameraHttpClient.js";
import { logger } from "../lib/logger.js";
import { hostGuard } from "../security/hostGuardInstance.js";

/**
 * ONVIF Profile G playback through go2rtc. go2rtc cannot send the two headers a replay server needs
 * on PLAY (Require: onvif-replay and Range: clock=<UTC start>-), so it connects here instead and
 * this relay passes the RTSP connection on to the camera, adding them. It also answers the
 * camera's login with the stored credentials, so go2rtc never sees them.
 *
 * It also plays recordings faster (2× to 16×) for any brand: go2rtc cannot ask for that either, so
 * fast playback goes through here and the relay adds Scale to PLAY; a camera that refuses it plays
 * at normal speed.
 *
 * Each playback gets its own address, rtsp://<relay>/r/<random token>/<camera path>: the token
 * picks the camera, start time and credentials, and the relay only ever connects to that camera.
 */

export interface ReplayTarget {
  /** The camera's own address (the host in the camera's reply is never used). */
  host: string;
  port: number;
  /** Path and query of the playback address (for ONVIF, the one the camera gave in GetReplayUri). */
  path: string;
  username: string;
  password: string;
  /** ONVIF replay: adds Require: onvif-replay, and Range from startUtcMs. */
  onvif: boolean;
  /** Where ONVIF playback starts, in UTC epoch ms. */
  startUtcMs?: number;
  /** Playback speed asked of the camera (RTSP Scale), above 1. */
  scale?: number;
}

const TOKEN_TTL_MS = 12 * 3_600_000;
const MAX_TOKENS = 2000;
const MAX_MESSAGE_BYTES = 256 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;

const targets = new Map<string, ReplayTarget & { expires: number }>();
/** The token each playback stream uses now, so choosing a new time retires the old one. */
const byStream = new Map<string, string>();

/** The clock time for a Range header: 20261024T101500Z. */
export const clockTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";

/** Registers a playback and returns the address go2rtc should play (relayBase: rtsp://host:port). */
export function registerReplay(relayBase: string, streamName: string, target: ReplayTarget): string {
  const now = Date.now();
  for (const [t, v] of targets) if (v.expires < now) targets.delete(t);
  const previous = byStream.get(streamName);
  if (previous) targets.delete(previous);
  if (targets.size >= MAX_TOKENS) targets.delete(targets.keys().next().value!);
  const token = randomBytes(18).toString("base64url");
  targets.set(token, { ...target, expires: now + TOKEN_TTL_MS });
  byStream.set(streamName, token);
  return `${relayBase.replace(/\/+$/, "")}/r/${token}${target.path.startsWith("/") ? "" : "/"}${target.path}`;
}

interface RtspMessage {
  /** Request line or status line. */
  first: string;
  headers: [string, string][];
  body: Buffer;
}

const header = (m: RtspMessage, name: string) => m.headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
const setHeader = (m: RtspMessage, name: string, value: string | undefined) => {
  m.headers = m.headers.filter(([k]) => k.toLowerCase() !== name.toLowerCase());
  if (value !== undefined) m.headers.push([name, value]);
};

function serialize(m: RtspMessage): Buffer {
  setHeader(m, "Content-Length", m.body.length > 0 ? String(m.body.length) : undefined);
  const head = [m.first, ...m.headers.map(([k, v]) => `${k}: ${v}`), "", ""].join("\r\n");
  return Buffer.concat([Buffer.from(head, "utf8"), m.body]);
}

/**
 * Splits an RTSP byte stream into messages and interleaved ($) data frames, in order. Returns what
 * is left over (an incomplete message); throws on a message too large to be RTSP.
 */
export function readRtsp(buf: Buffer, onMessage: (m: RtspMessage) => void, onFrame: (frame: Buffer) => void): Buffer {
  let offset = 0;
  while (offset < buf.length) {
    if (buf[offset] === 0x24) {
      if (buf.length - offset < 4) break;
      const end = offset + 4 + buf.readUInt16BE(offset + 2);
      if (end > buf.length) break;
      onFrame(buf.subarray(offset, end));
      offset = end;
      continue;
    }
    const headEnd = buf.indexOf("\r\n\r\n", offset);
    if (headEnd < 0) {
      if (buf.length - offset > MAX_MESSAGE_BYTES) throw new Error("RTSP message too large");
      break;
    }
    const lines = buf.subarray(offset, headEnd).toString("utf8").split("\r\n");
    const headers = lines.slice(1).flatMap((l): [string, string][] => {
      const i = l.indexOf(":");
      return i > 0 ? [[l.slice(0, i).trim(), l.slice(i + 1).trim()]] : [];
    });
    const length = Number(headers.find(([k]) => k.toLowerCase() === "content-length")?.[1] ?? 0) || 0;
    if (length > MAX_MESSAGE_BYTES) throw new Error("RTSP message too large");
    const end = headEnd + 4 + length;
    if (end > buf.length) break;
    onMessage({ first: lines[0]!, headers, body: Buffer.from(buf.subarray(headEnd + 4, end)) });
    offset = end;
  }
  return buf.subarray(offset);
}

/** Handles one connection from go2rtc. */
function relayConnection(client: net.Socket) {
  let target: ReplayTarget | undefined;
  let camera: net.Socket | undefined;
  let cameraOrigin = "";
  let relayPrefix = "";
  let challenge: { scheme: "digest" | "basic"; params: Record<string, string> } | undefined;
  let nc = 0;
  /** Requests waiting for the camera to answer, by CSeq, to resend once after a login challenge. */
  const pending = new Map<string, { message: RtspMessage; retried: boolean; scaled?: boolean; unscaled?: boolean }>();
  /** Messages for the camera before its connection is up. */
  let queue: Buffer[] | undefined = [];
  let fromClient: Buffer = Buffer.alloc(0);
  let fromCamera: Buffer = Buffer.alloc(0);

  const close = () => {
    client.destroy();
    camera?.destroy();
  };
  client.on("error", close).on("close", close);
  client.setTimeout(60_000, close);

  const reply = (m: RtspMessage, status: string) => {
    const cseq = header(m, "CSeq");
    client.write(`RTSP/1.0 ${status}\r\n${cseq ? `CSeq: ${cseq}\r\n` : ""}\r\n`);
  };

  const toCamera = (data: Buffer) => {
    if (queue) queue.push(data);
    else camera!.write(data);
  };

  const authorize = (m: RtspMessage, method: string, uri: string) => {
    if (!challenge || !target) return;
    if (challenge.scheme === "basic") {
      setHeader(m, "Authorization", `Basic ${Buffer.from(`${target.username}:${target.password}`).toString("base64")}`);
    } else {
      nc += 1;
      setHeader(m, "Authorization", digestAuthorization(challenge.params, target.username, target.password, method, uri, undefined, nc.toString(16).padStart(8, "0")));
    }
  };

  /** Sends a request on to the camera: its address, the login, the replay headers and the speed. */
  const sendRequest = (m: RtspMessage, unscaled = false) => {
    const [method = "", uri = "", version = "RTSP/1.0"] = m.first.split(" ");
    const cameraUri = uri === "*" ? uri : cameraOrigin + (uri.slice(relayPrefix.length) || "/");
    const out: RtspMessage = { first: `${method} ${cameraUri} ${version}`, headers: m.headers.filter(([k]) => k.toLowerCase() !== "authorization"), body: m.body };
    const play = method.toUpperCase() === "PLAY";
    if (target!.onvif) {
      if (["DESCRIBE", "SETUP", "PLAY", "PAUSE"].includes(method.toUpperCase())) setHeader(out, "Require", "onvif-replay");
      if (play && target!.startUtcMs !== undefined) setHeader(out, "Range", `clock=${clockTime(target!.startUtcMs)}-`);
    }
    const scaled = play && !unscaled && (target!.scale ?? 1) > 1;
    if (scaled) setHeader(out, "Scale", target!.scale!.toFixed(1));
    authorize(out, method, cameraUri);
    const cseq = header(m, "CSeq");
    if (cseq) pending.set(cseq, { message: m, retried: pending.get(cseq)?.retried ?? false, scaled, unscaled });
    toCamera(serialize(out));
  };

  /** The camera's addresses in its replies point back here. */
  const toRelay = (s: string) => s.replace(/rtsps?:\/\/[^/\s"';,]+/gi, relayPrefix);

  const onCameraMessage = (m: RtspMessage) => {
    const cseq = header(m, "CSeq");
    const request = cseq ? pending.get(cseq) : undefined;
    if (request) pending.delete(cseq!);
    if (/^RTSP\/\S+\s+401\b/.test(m.first) && request && !request.retried) {
      const offered = m.headers.filter(([k]) => k.toLowerCase() === "www-authenticate").map(([, v]) => v);
      const digest = offered.find((v) => /^digest\s/i.test(v));
      const basic = offered.find((v) => /^basic\b/i.test(v));
      if (digest || basic) {
        challenge = digest ? { scheme: "digest", params: parseChallenge(digest) } : { scheme: "basic", params: {} };
        pending.set(cseq!, { message: request.message, retried: true });
        sendRequest(request.message, request.unscaled);
        return;
      }
    }
    // The camera refused to play faster: play at normal speed instead.
    if (request?.scaled && !/^RTSP\/\S+\s+2\d\d\b/.test(m.first)) {
      logger.info({ status: m.first, host: target?.host }, "Recording playback: the camera refused fast playback; playing at normal speed");
      pending.set(cseq!, { ...request, scaled: false, unscaled: true });
      sendRequest(request.message, true);
      return;
    }
    for (const name of ["Content-Base", "Content-Location", "RTP-Info"]) {
      const v = header(m, name);
      if (v) setHeader(m, name, toRelay(v));
    }
    if (/sdp/i.test(header(m, "Content-Type") ?? "")) m.body = Buffer.from(toRelay(m.body.toString("utf8")), "utf8");
    client.write(serialize(m));
  };

  const connect = async (t: ReplayTarget) => {
    const { address } = await hostGuard.resolve(t.host);
    camera = net.connect({ host: address, port: t.port });
    camera.setTimeout(CONNECT_TIMEOUT_MS, () => camera!.destroy(new Error("timed out")));
    camera.once("connect", () => {
      camera!.setTimeout(0);
      for (const data of queue ?? []) camera!.write(data);
      queue = undefined;
    });
    camera.on("data", (chunk) => {
      fromCamera = Buffer.concat([fromCamera, chunk]);
      try {
        fromCamera = readRtsp(fromCamera, onCameraMessage, (frame) => client.write(frame));
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "Recording playback: unreadable reply from the camera");
        close();
      }
    });
    camera.on("error", (err) => {
      logger.warn({ err: err.message, host: t.host }, "Recording playback: the camera connection failed");
      close();
    });
    camera.on("close", close);
  };

  const onClientMessage = (m: RtspMessage) => {
    const uri = m.first.split(" ")[1] ?? "";
    if (!target) {
      const match = /^rtsp:\/\/[^/]+\/r\/([A-Za-z0-9_-]{24})(?=\/|$)/.exec(uri);
      const found = match ? targets.get(match[1]!) : undefined;
      if (!found || found.expires < Date.now()) {
        reply(m, "404 Not Found");
        return;
      }
      target = found;
      relayPrefix = match![0];
      const host = net.isIP(found.host) === 6 ? `[${found.host}]` : found.host;
      cameraOrigin = `rtsp://${host}:${found.port}`;
      void connect(found).catch((err) => {
        logger.warn({ err: (err as Error).message, host: found.host }, "Recording playback: the camera cannot be contacted");
        reply(m, "503 Service Unavailable");
        close();
      });
    } else if (uri !== "*" && !uri.startsWith(relayPrefix)) {
      reply(m, "404 Not Found");
      return;
    }
    sendRequest(m);
  };

  client.on("data", (chunk) => {
    fromClient = Buffer.concat([fromClient, chunk]);
    try {
      fromClient = readRtsp(fromClient, onClientMessage, (frame) => (target ? toCamera(Buffer.from(frame)) : undefined));
    } catch {
      close();
    }
  });
}

let server: net.Server | undefined;

/** Starts the relay on `port` (all interfaces: go2rtc reaches it over the Docker network). */
export function startReplayRelay(port: number, host = "0.0.0.0"): Promise<net.Server> {
  if (server) return Promise.resolve(server);
  const s = net.createServer(relayConnection);
  server = s;
  return new Promise((resolve, reject) => {
    s.once("error", reject);
    s.listen(port, host, () => {
      s.off("error", reject);
      logger.info({ port }, "Recording playback relay listening");
      resolve(s);
    });
  });
}

export function stopReplayRelay(): Promise<void> {
  const s = server;
  server = undefined;
  return new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
}
