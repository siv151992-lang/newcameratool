import { randomBytes } from "node:crypto";
import net from "node:net";
import { digestAuthorization, parseChallenge } from "../integrations/http/cameraHttpClient.js";
import { logger } from "../lib/logger.js";
import { hostGuard } from "../security/hostGuardInstance.js";
import { interleavedChannel, startsKeyframe, type VideoCodec, videoTrack } from "./rtpKeyframes.js";

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
  /**
   * Where playback starts, in UTC epoch ms: sent on PLAY as Range: clock=…, for ONVIF replay and for
   * brands whose firmware may ignore the start time in the address (played again without it if refused).
   */
  startUtcMs?: number;
  /** Playback speed asked of the camera (RTSP Scale), above 1. */
  scale?: number;
}

const TOKEN_TTL_MS = 12 * 3_600_000;
const MAX_TOKENS = 2000;
const MAX_MESSAGE_BYTES = 256 * 1024;
const CONNECT_TIMEOUT_MS = 10_000;
/** Video waiting for the video service beyond which the camera is not read until it catches up. */
const MAX_QUEUED_BYTES = 1024 * 1024;

const targets = new Map<string, ReplayTarget & { expires: number; streamName: string }>();
/** The last request each playback stream's camera refused, to show in the player (go2rtc only says "wrong response"). */
const refusals = new Map<string, { request: string; status: string; at: number }>();

/** What the camera last refused for this playback stream, in the last two minutes. */
export function lastRefusal(streamName: string): { request: string; status: string } | undefined {
  const r = refusals.get(streamName);
  return r && Date.now() - r.at < 120_000 ? { request: r.request, status: r.status } : undefined;
}

/**
 * Per camera (host:port): its last login challenge, answered at once on the next connection instead
 * of after a refusal (a round trip less on every play and seek; a stale one is just refused and
 * answered again), and when it refused a clock range (not asked again for an hour).
 */
const challenges = new Map<string, { scheme: "digest" | "basic"; params: Record<string, string>; nc: number; at: number }>();
const CHALLENGE_REUSE_MS = 10 * 60_000;
const rangeRefusedAt = new Map<string, number>();
const RANGE_REFUSAL_MS = 3_600_000;

/** What happened to each playback stream's last connection, to explain a recording that does not play. */
interface Trace {
  port: number;
  /** go2rtc connected to the relay for this playback. */
  contacted: boolean;
  /** Why the camera's RTSP port could not be reached. */
  connectError?: string;
  /** The last request the camera answered, and whether PLAY was accepted. */
  lastAnswered?: string;
  played: boolean;
  /** Video packets the camera sent. */
  frames: number;
  /** The camera hung up (rather than the player). */
  cameraClosed: boolean;
  /** A request sent that the camera never answered. */
  unanswered?: string;
  /** When (epoch ms) go2rtc came, the camera's port answered, each method was first sent and last accepted, and video began. */
  at: { contact?: number; connected?: number; sent: Record<string, number>; accepted: Record<string, number>; firstVideo?: number; keyframes: number[] };
}
const traces = new Map<string, Trace>();

/** How long each step of the last start took, in ms (from what the relay saw); absent steps are left out. */
export interface PlaybackTimings {
  /** The camera's RTSP port answered the connection. */
  connect?: number;
  /** The camera described the recording (including a login round trip). */
  describe?: number;
  setup?: number;
  /** The camera accepted PLAY (it looks for the recording at the start time). */
  play?: number;
  /** After accepting PLAY, until it sent the first video. */
  firstVideo?: number;
  /** From go2rtc connecting to the relay to the first video. */
  total?: number;
  /** From the first video to the first full picture (key frame): what a player waits before showing anything. */
  firstPicture?: number;
  /** How often the camera sends a full picture (its I-frame interval), once two or more have come. */
  pictureInterval?: number;
}

export function playbackTimings(streamName: string): PlaybackTimings | undefined {
  const a = traces.get(streamName)?.at;
  if (!a?.contact) return undefined;
  const span = (from?: number, to?: number) => (from !== undefined && to !== undefined && to >= from ? to - from : undefined);
  const out: PlaybackTimings = {
    connect: span(a.contact, a.connected),
    describe: span(a.sent.DESCRIBE, a.accepted.DESCRIBE),
    setup: span(a.sent.SETUP, a.accepted.SETUP),
    play: span(a.sent.PLAY, a.accepted.PLAY),
    firstVideo: span(a.accepted.PLAY, a.firstVideo),
    total: span(a.contact, a.firstVideo),
    firstPicture: span(a.firstVideo, a.keyframes[0]),
    pictureInterval: a.keyframes.length >= 2 ? Math.round((a.keyframes.at(-1)! - a.keyframes[0]!) / (a.keyframes.length - 1)) : undefined,
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as PlaybackTimings;
}

/** A camera with no free connection (453) is asked again after 1, 2 and 3 seconds. */
const BUSY_RETRIES = 3;
/** Tunable for tests. */
export const busyRetry = { ms: 1000 };

const STATUS_HINTS: [RegExp, string][] = [
  [/^401\b/, "the camera refused the user name or password for playback"],
  [/^403\b/, "the camera user is not allowed to play recordings: give it the Playback permission, or use the admin account"],
  [/^(404|454)\b/, "the camera has no recording at this address or time"],
  [/^(400|451|457|459|461)\b/, "the camera did not accept the request; its firmware may need another playback address"],
  [/^(500|503)\b/, "the camera could not serve it now (too many playbacks at once, or its storage is busy)"],
  [/^453\b/, "all the camera's video connections are in use (live views, other playbacks, an NVR or video management software such as Milestone pulling its streams). Close other views of this camera, or free a connection on the camera, and try again"],
];

/**
 * Why this session's playback did not play, in words, from what the relay saw; undefined when
 * nothing is known (playback not prepared through the relay).
 */
export function playbackDiagnosis(streamName: string): string | undefined {
  const t = traces.get(streamName);
  if (!t) return undefined;
  const refusal = lastRefusal(streamName);
  if (refusal) {
    const hint = STATUS_HINTS.find(([re]) => re.test(refusal.status))?.[1];
    return `The camera answered "${refusal.status}" to ${refusal.request}${hint ? `: ${hint}` : ""}.`;
  }
  if (t.connectError) return `The camera could not be reached on its RTSP port ${t.port}: ${t.connectError}.`;
  if (!t.contacted) {
    return "The video service (go2rtc) did not connect to the server's playback relay. Check PLAYBACK_RELAY_URL: go2rtc must reach the API at that address (rtsp://api:8554 in Docker Compose).";
  }
  if (t.played && t.frames === 0) {
    return t.cameraClosed
      ? "The camera accepted playback but closed the connection without sending video (often no recording at that time, or a recording the camera cannot stream)."
      : "The camera accepted playback but sent no video.";
  }
  if (t.unanswered && t.cameraClosed) return `The camera closed the connection without answering ${t.unanswered}.`;
  if (t.unanswered) return `The camera did not answer ${t.unanswered}.`;
  if (t.cameraClosed && t.frames === 0) return `The camera closed the connection${t.lastAnswered ? ` after answering ${t.lastAnswered}` : ""} without sending video.`;
  return undefined;
}

const connectReason = (err: Error & { code?: string }) =>
  err.code === "ECONNREFUSED" ? "connection refused (RTSP is turned off in the camera, or on another port)"
  : err.message === "timed out" || err.code === "ETIMEDOUT" ? "no answer within 10 seconds (a firewall, or the camera is offline)"
  : err.code === "EHOSTUNREACH" || err.code === "ENETUNREACH" ? "no route to the camera"
  : err.code === "ECONNRESET" ? "the camera dropped the connection"
  : err.message;
/** The token each playback stream uses now, so choosing a new time retires the old one. */
const byStream = new Map<string, string>();

/** The clock time for a Range header: 20261024T101500Z. */
export const clockTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, "") + "Z";

/**
 * A stream part's address as the camera expects it. go2rtc addresses each stream part by appending
 * its control name to the playback address, query included: path?starttime=…&endtime=…/trackID=1.
 * The camera then reads "…Z/trackID=1" as the time (and plays from the first recording on the card,
 * or refuses SETUP). The part goes before the query: path/trackID=1?starttime=…&endtime=….
 */
export function controlBeforeQuery(uri: string): string {
  const q = uri.indexOf("?");
  if (q < 0) return uri;
  const slash = uri.indexOf("/", q);
  if (slash < 0) return uri;
  const base = uri.slice(0, q).replace(/\/+$/, "");
  return `${base}/${uri.slice(slash + 1)}?${uri.slice(q + 1, slash)}`;
}

/** Forgets a playback that is over (a downloaded clip's one-off stream): its address stops working. */
export function releaseReplay(streamName: string): void {
  const token = byStream.get(streamName);
  if (token) targets.delete(token);
  byStream.delete(streamName);
  refusals.delete(streamName);
  traces.delete(streamName);
}

/** Registers a playback and returns the address go2rtc should play (relayBase: rtsp://host:port). */
export function registerReplay(relayBase: string, streamName: string, target: ReplayTarget): string {
  const now = Date.now();
  for (const [t, v] of targets) if (v.expires < now) targets.delete(t);
  const previous = byStream.get(streamName);
  if (previous) targets.delete(previous);
  if (targets.size >= MAX_TOKENS) targets.delete(targets.keys().next().value!);
  const token = randomBytes(18).toString("base64url");
  targets.set(token, { ...target, expires: now + TOKEN_TTL_MS, streamName });
  refusals.delete(streamName);
  if (traces.size > 2000) traces.clear();
  traces.set(streamName, { port: target.port, contacted: false, played: false, frames: 0, cameraClosed: false, at: { sent: {}, accepted: {}, keyframes: [] } });
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
  let target: (ReplayTarget & { streamName?: string }) | undefined;
  let camera: net.Socket | undefined;
  let cameraOrigin = "";
  let relayPrefix = "";
  let challenge: { scheme: "digest" | "basic"; params: Record<string, string>; nc: number; at: number } | undefined;
  let cameraKey = "";
  /** The video track: its codec and control name (from DESCRIBE), and its interleaved channel (from SETUP). */
  let video: { codec: VideoCodec; control?: string; channel?: number } | undefined;
  /** Requests waiting for the camera to answer, by CSeq, to resend once after a login challenge. */
  const pending = new Map<string, { message: RtspMessage; retried: boolean; scaled?: boolean; unscaled?: boolean; ranged?: boolean; unranged?: boolean; busyTries?: number }>();
  /** Messages for the camera before its connection is up. */
  let queue: Buffer[] | undefined = [];
  let fromClient: Buffer = Buffer.alloc(0);
  let fromCamera: Buffer = Buffer.alloc(0);

  const trace = () => (target?.streamName ? traces.get(target.streamName) : undefined);
  const close = () => {
    client.destroy();
    camera?.destroy();
  };
  // RTSP replies and video packets go out at once (no waiting to batch small packets).
  client.setNoDelay(true);
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
      challenge.nc += 1;
      setHeader(m, "Authorization", digestAuthorization(challenge.params, target.username, target.password, method, uri, undefined, challenge.nc.toString(16).padStart(8, "0")));
    }
  };

  /** Sends a request on to the camera: its address, the login, the replay headers and the speed. */
  const sendRequest = (m: RtspMessage, unscaled = false, unranged = false) => {
    const [method = "", uri = "", version = "RTSP/1.0"] = m.first.split(" ");
    const cameraUri = uri === "*" ? uri : controlBeforeQuery(cameraOrigin + (uri.slice(relayPrefix.length) || "/"));
    const out: RtspMessage = { first: `${method} ${cameraUri} ${version}`, headers: m.headers.filter(([k]) => k.toLowerCase() !== "authorization"), body: m.body };
    const play = method.toUpperCase() === "PLAY";
    if (target!.onvif) {
      if (["DESCRIBE", "SETUP", "PLAY", "PAUSE"].includes(method.toUpperCase())) setHeader(out, "Require", "onvif-replay");
      if (play && target!.startUtcMs !== undefined) setHeader(out, "Range", `clock=${clockTime(target!.startUtcMs)}-`);
    }
    // Other brands: the start time as a clock range too, for firmware that ignores it in the address.
    const refusedAt = rangeRefusedAt.get(cameraKey);
    const ranged = play && !target!.onvif && !unranged && target!.startUtcMs !== undefined && !(refusedAt && Date.now() - refusedAt < RANGE_REFUSAL_MS);
    if (ranged) setHeader(out, "Range", `clock=${clockTime(target!.startUtcMs!)}-`);
    const scaled = play && !unscaled && (target!.scale ?? 1) > 1;
    if (scaled) setHeader(out, "Scale", target!.scale!.toFixed(1));
    authorize(out, method, cameraUri);
    const cseq = header(m, "CSeq");
    if (cseq) pending.set(cseq, { message: m, retried: pending.get(cseq)?.retried ?? false, scaled, unscaled, ranged, unranged, busyTries: pending.get(cseq)?.busyTries });
    const t = trace();
    if (t) {
      t.unanswered = `${method} ${uri === "*" ? uri : controlBeforeQuery(uri.slice(relayPrefix.length) || "/")}`.slice(0, 300);
      t.at.sent[method.toUpperCase()] ??= Date.now();
    }
    toCamera(serialize(out));
  };

  /** The camera's addresses in its replies point back here. */
  const toRelay = (s: string) => s.replace(/rtsps?:\/\/[^/\s"';,]+/gi, relayPrefix);

  const onCameraMessage = (m: RtspMessage) => {
    const cseq = header(m, "CSeq");
    const request = cseq ? pending.get(cseq) : undefined;
    if (request) pending.delete(cseq!);
    const t = trace();
    if (t && request) {
      const [method = "", uri = ""] = request.message.first.split(" ");
      t.lastAnswered = `${method} ${uri.startsWith(relayPrefix) ? controlBeforeQuery(uri.slice(relayPrefix.length)) : uri}`.slice(0, 300);
      if (t.unanswered === t.lastAnswered) t.unanswered = undefined;
      if (/^RTSP\/\S+\s+2\d\d\b/.test(m.first)) t.at.accepted[method.toUpperCase()] = Date.now();
      if (method.toUpperCase() === "PLAY" && /^RTSP\/\S+\s+2\d\d\b/.test(m.first)) t.played = true;
    }
    if (/^RTSP\/\S+\s+401\b/.test(m.first) && request && !request.retried) {
      const offered = m.headers.filter(([k]) => k.toLowerCase() === "www-authenticate").map(([, v]) => v);
      const digest = offered.find((v) => /^digest\s/i.test(v));
      const basic = offered.find((v) => /^basic\b/i.test(v));
      if (digest || basic) {
        challenge = { ...(digest ? { scheme: "digest" as const, params: parseChallenge(digest) } : { scheme: "basic" as const, params: {} }), nc: 0, at: Date.now() };
        if (challenges.size > 5000) challenges.clear();
        challenges.set(cameraKey, challenge);
        pending.set(cseq!, { message: request.message, retried: true });
        sendRequest(request.message, request.unscaled, request.unranged);
        return;
      }
    }
    // The camera refused to play faster: play at normal speed instead.
    if (request?.scaled && !/^RTSP\/\S+\s+2\d\d\b/.test(m.first)) {
      logger.info({ status: m.first, host: target?.host }, "Recording playback: the camera refused fast playback; playing at normal speed");
      pending.set(cseq!, { ...request, scaled: false, unscaled: true });
      sendRequest(request.message, true, request.unranged);
      return;
    }
    // The camera refused the clock range: play with the start time in the address only.
    if (request?.ranged && !/^RTSP\/\S+\s+2\d\d\b/.test(m.first)) {
      logger.info({ status: m.first, host: target?.host }, "Recording playback: the camera refused a clock range; playing from the time in the address");
      if (rangeRefusedAt.size > 5000) rangeRefusedAt.clear();
      rangeRefusedAt.set(cameraKey, Date.now());
      pending.set(cseq!, { ...request, ranged: false, unranged: true });
      sendRequest(request.message, request.unscaled, true);
      return;
    }
    // All the camera's connections in use (Hikvision: 453 Not Enough Bandwidth): usually the playback
    // just replaced by a seek, which the camera frees a moment later. Ask again, a few times.
    if (request && /^RTSP\/\S+\s+453\b/.test(m.first) && (request.busyTries ?? 0) < BUSY_RETRIES) {
      const tries = (request.busyTries ?? 0) + 1;
      logger.info({ status: m.first, host: target?.host, tries }, "Recording playback: the camera has no free connection; asking again");
      setTimeout(() => {
        if (client.destroyed || camera?.destroyed) return;
        pending.set(cseq!, { ...request, busyTries: tries });
        sendRequest(request.message, request.unscaled, request.unranged);
      }, busyRetry.ms * tries);
      return;
    }
    if (request && !/^RTSP\/\S+\s+2\d\d\b/.test(m.first)) {
      // The request as the camera got it (its path, without the relay's token or any credentials).
      const [method = "", uri = ""] = request.message.first.split(" ");
      const path = uri.startsWith(relayPrefix) ? controlBeforeQuery(uri.slice(relayPrefix.length)) : uri;
      const refusal = { request: `${method} ${path}`.slice(0, 300), status: m.first.replace(/^RTSP\/\S+\s+/, "").slice(0, 100), at: Date.now() };
      logger.warn({ ...refusal, host: target?.host }, "Recording playback: the camera refused a request");
      if (target?.streamName) {
        if (refusals.size > 2000) refusals.clear();
        refusals.set(target.streamName, refusal);
      }
    }
    for (const name of ["Content-Base", "Content-Location", "RTP-Info"]) {
      const v = header(m, name);
      if (v) setHeader(m, name, toRelay(v));
    }
    if (/sdp/i.test(header(m, "Content-Type") ?? "")) {
      video = videoTrack(m.body.toString("utf8")) ?? video;
      m.body = Buffer.from(toRelay(m.body.toString("utf8")), "utf8");
    }
    // The channel the video comes on: the SETUP of the video track (or the first SETUP).
    if (request && video && /^SETUP\b/i.test(request.message.first) && /^RTSP\/\S+\s+2\d\d\b/.test(m.first)) {
      const uri = request.message.first.split(" ")[1] ?? "";
      const isVideo = video.control ? uri.split("?")[0]!.endsWith(video.control.replace(/^.*\//, "")) : false;
      const ch = interleavedChannel(header(m, "Transport") ?? header(request.message, "Transport"));
      if (ch !== undefined && (isVideo || video.channel === undefined)) video.channel = ch;
    }
    client.write(serialize(m));
  };

  const connect = async (t: ReplayTarget) => {
    const { address } = await hostGuard.resolve(t.host);
    camera = net.connect({ host: address, port: t.port, noDelay: true });
    camera.setTimeout(CONNECT_TIMEOUT_MS, () => camera!.destroy(new Error("timed out")));
    camera.once("connect", () => {
      camera!.setTimeout(0);
      for (const data of queue ?? []) camera!.write(data);
      queue = undefined;
    });
    camera.on("data", (chunk) => {
      fromCamera = fromCamera.length ? Buffer.concat([fromCamera, chunk]) : chunk;
      try {
        fromCamera = readRtsp(fromCamera, onCameraMessage, (frame) => {
          const t = trace();
          if (t) {
            t.frames += 1;
            t.at.firstVideo ??= Date.now();
            // Full pictures among the first few seconds (parts of one picture count once).
            if (video && video.channel === frame[1] && t.at.keyframes.length < 6 && startsKeyframe(frame.subarray(4), video.codec)) {
              const now = Date.now();
              if (!t.at.keyframes.length || now - t.at.keyframes.at(-1)! > 100) t.at.keyframes.push(now);
            }
          }
          client.write(frame);
        });
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "Recording playback: unreadable reply from the camera");
        close();
        return;
      }
      // The video service is not keeping up (overloaded, restarting): stop reading the camera until
      // it has caught up, so video does not pile up in memory (TCP then slows the camera down).
      if (client.writableLength > MAX_QUEUED_BYTES && !camera!.isPaused()) {
        camera!.pause();
        client.once("drain", () => camera?.resume());
      }
    });
    let connected = false;
    camera.once("connect", () => {
      connected = true;
      const tr = trace();
      if (tr) tr.at.connected = Date.now();
    });
    camera.on("error", (err) => {
      logger.warn({ err: err.message, host: t.host }, "Recording playback: the camera connection failed");
      const tr = trace();
      if (tr && !connected) tr.connectError = connectReason(err);
      close();
    });
    camera.on("close", () => {
      const tr = trace();
      if (tr && connected && !client.destroyed) tr.cameraClosed = true;
      close();
    });
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
      const tr = traces.get(found.streamName);
      if (tr) {
        tr.contacted = true;
        // A new start (go2rtc reconnecting): time it afresh.
        tr.at = { contact: Date.now(), sent: {}, accepted: {}, keyframes: [] };
      }
      const host = net.isIP(found.host) === 6 ? `[${found.host}]` : found.host;
      cameraOrigin = `rtsp://${host}:${found.port}`;
      cameraKey = `${found.host}:${found.port}`;
      const known = challenges.get(cameraKey);
      if (known && Date.now() - known.at < CHALLENGE_REUSE_MS) challenge = known;
      void connect(found).catch((err) => {
        logger.warn({ err: (err as Error).message, host: found.host }, "Recording playback: the camera cannot be contacted");
        const tr = traces.get(found.streamName);
        if (tr) tr.connectError = (err as Error).message;
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
    fromClient = fromClient.length ? Buffer.concat([fromClient, chunk]) : chunk;
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
