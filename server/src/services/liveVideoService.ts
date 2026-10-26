import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { config } from "../config.js";
import { registry } from "../integrations/registry.js";
import type { CameraBrandAdapter, CameraConfig, RecordingList } from "../integrations/types.js";
import { HttpError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { getCameraConfig, getCameraRow } from "./cameraService.js";
import { onvifAdapter } from "./liveViewService.js";
import { getMonitoringSettings } from "./settingsService.js";
import { registerReplay } from "./rtspReplayRelay.js";
import { probeReason, probeRtsp } from "./rtspProbe.js";

/**
 * Smooth live video through go2rtc (LIVE_VIDEO_URL): the server registers the camera's RTSP stream
 * there and passes the browser's WebSocket through (liveVideoProxy). go2rtc is only reachable from
 * the server's own network; browsers never see the camera address or password.
 */

export const RTSP_PORT = 554;
export const liveVideoEnabled = () => Boolean(config.LIVE_VIDEO_URL);
export const streamName = (cameraId: string) => `camera_${cameraId}`;

export function rtspUrl(camera: Pick<CameraConfig, "host" | "username" | "password">, path: string): string {
  const host = isIP(camera.host) === 6 ? `[${camera.host}]` : camera.host;
  return `rtsp://${encodeURIComponent(camera.username)}:${encodeURIComponent(camera.password)}@${host}:${RTSP_PORT}${path}`;
}

/**
 * An RTSP address the camera gave (ONVIF) with the stored credentials, always at the camera's own
 * address: the host in the reply is ignored, so a camera cannot point go2rtc elsewhere.
 */
export function withCredentials(uri: string, camera: Pick<CameraConfig, "host" | "username" | "password">): string {
  const u = new URL(uri);
  if (u.protocol !== "rtsp:" && u.protocol !== "rtsps:") throw new Error(`not an RTSP address (${u.protocol})`);
  u.hostname = isIP(camera.host) === 6 ? `[${camera.host}]` : camera.host;
  u.username = encodeURIComponent(camera.username);
  u.password = encodeURIComponent(camera.password);
  return u.toString();
}

const base = () => config.LIVE_VIDEO_URL!.replace(/\/+$/, "");
const relayBase = () => config.PLAYBACK_RELAY_URL;

/** Streams this process registered, by a hash of their source: re-registered when the camera changes. */
const registered = new Map<string, string>();

async function streamExists(name: string): Promise<boolean> {
  const res = await fetch(`${base()}/api/streams`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return false;
  return name in ((await res.json()) as Record<string, unknown>);
}

/** Makes sure go2rtc has this camera's stream; returns its name. */
export async function prepareStream(orgId: string, cameraId: string): Promise<string> {
  if (!liveVideoEnabled()) throw new HttpError(404, "LIVE_VIDEO_OFF", "Smooth live video is not set up on this server");
  const row = await getCameraRow(cameraId, orgId);
  const adapter = registry.get(row.brand_key);
  const { requestTimeoutMs } = await getMonitoringSettings();
  const config = await getCameraConfig(cameraId, requestTimeoutMs);
  let src: string;
  if (adapter.rtspPath) src = await chooseLiveSource(cameraId, adapter, config);
  else {
    // Asked from the camera (ONVIF), for ONVIF cameras and brands without a stream path of their own.
    const via = adapter.liveRtspUrl ? adapter : onvifAdapter();
    if (!via?.liveRtspUrl) throw new HttpError(422, "LIVE_VIDEO_UNAVAILABLE", `Live video is not available for ${adapter.meta.displayName} cameras`);
    try {
      src = withCredentials(await via.liveRtspUrl(config), config);
    } catch (err) {
      throw new HttpError(422, "LIVE_VIDEO_UNAVAILABLE", `The camera's video address could not be read over ONVIF: ${(err as Error).message}. Turn on ONVIF in the camera.`);
    }
  }
  const name = streamName(cameraId);
  const hash = createHash("sha256").update(src).digest("hex");
  try {
    if (registered.get(name) === hash && (await streamExists(name))) return name;
  } catch {
    // checked again when the stream is added
  }
  await putStream(name, src);
  registered.set(name, hash);
  return name;
}

/** Per camera: the live address that answered, for a while, so opening the view stays quick. */
const liveSources = new Map<string, { key: string; src: string; at: number }>();
const LIVE_SOURCE_TTL_MS = 10 * 60_000;

/**
 * The live address to give go2rtc: the brand's stream path, or the first of its other paths (and
 * then the address the camera gives over ONVIF) that the camera really serves. Each is checked with
 * an RTSP DESCRIBE, so a camera whose usual stream is off or named differently still plays, and
 * one that refuses them all is explained (login refused, or no such stream).
 */
async function chooseLiveSource(cameraId: string, adapter: CameraBrandAdapter, config: CameraConfig): Promise<string> {
  const paths = [adapter.rtspPath!, ...(adapter.rtspFallbacks ?? [])];
  const key = createHash("sha256").update(JSON.stringify([config.host, config.username, config.password, paths])).digest("hex");
  const cached = liveSources.get(cameraId);
  if (cached && cached.key === key && Date.now() - cached.at < LIVE_SOURCE_TTL_MS) return cached.src;
  const remember = (src: string) => {
    if (liveSources.size > 5000) liveSources.clear();
    liveSources.set(cameraId, { key, src, at: Date.now() });
    return src;
  };
  const tried: { path: string; status: number }[] = [];
  for (const path of paths) {
    const status = await probeRtsp({ host: config.host, port: RTSP_PORT, path, username: config.username, password: config.password }).catch(() => 0);
    tried.push({ path, status });
    if (status === 200) return remember(rtspUrl(config, path));
    // No answer at all: the RTSP port is not reachable from here; let the video service try as before.
    if (status === 0) return rtspUrl(config, adapter.rtspPath!);
  }
  // Last, the address the camera itself gives over ONVIF.
  const onvif = onvifAdapter();
  if (onvif?.liveRtspUrl) {
    try {
      const uri = new URL(await onvif.liveRtspUrl(config));
      const path = `${uri.pathname}${uri.search}`;
      const status = await probeRtsp({ host: config.host, port: uri.port ? Number(uri.port) : RTSP_PORT, path, username: config.username, password: config.password }).catch(() => 0);
      tried.push({ path: `${path} (ONVIF)`, status });
      if (status === 200) return remember(withCredentials(uri.toString(), config));
    } catch {
      // ONVIF is optional
    }
  }
  logger.warn({ cameraId, tried }, "Live video: the camera served none of its stream addresses");
  const refused = tried.find((t) => t.status === 401 || t.status === 403);
  throw new HttpError(
    422,
    "LIVE_VIDEO_UNAVAILABLE",
    `The camera's video could not be opened: ${probeReason(refused?.status ?? tried[0]!.status)}. Tried ${tried.map((t) => `${t.path} (${t.status || "no answer"})`).join(", ")}.` +
      (refused ? "" : " Turn on a stream in H.264 in the camera's video settings, or turn on ONVIF."),
  );
}

/** Adds (or replaces) a go2rtc stream. */
async function putStream(name: string, src: string) {
  let res: Response;
  try {
    res = await fetch(`${base()}/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`, { method: "PUT", signal: AbortSignal.timeout(5000) });
  } catch (err) {
    logger.warn({ err: (err as Error).message, url: base() }, "Live video service unreachable");
    throw new HttpError(502, "LIVE_VIDEO_SERVICE", `The live video service (go2rtc at ${base()}) is not answering. Check that the go2rtc container is running: docker compose ps go2rtc`);
  }
  // go2rtc adds the stream, then saves it to its config file; with a read-only config that save
  // fails (HTTP 400) although the stream works. What counts is that the stream exists now.
  if (!res.ok && !(await streamExists(name).catch(() => false))) {
    const reason = (await res.text().catch(() => "")).trim().slice(0, 200);
    logger.warn({ status: res.status, reason }, "Live video service refused the camera stream");
    throw new HttpError(502, "LIVE_VIDEO_SERVICE", `The live video service refused the camera stream (HTTP ${res.status}${reason ? `: ${reason}` : ""}). See: docker compose logs go2rtc`);
  }
}

// ------------------------------------------------------------------ playback of recordings

/** Per camera: the last day listed, to turn a chosen local time into the camera's playback time. */
const lastListing = new Map<string, RecordingList>();
const DAY_MS = 86_400_000;
const wall = (ms: number) => new Date(ms).toISOString().slice(0, 19);

/** One session's playback stream of a camera (each viewer plays their own time). */
export const playbackStreamName = (cameraId: string, sessionId: string) => `playback_${cameraId}_${sessionId.slice(0, 12)}`;

/** The camera's adapter for playback; brands without playback of their own are asked over ONVIF (Profile G). */
async function playbackAdapter(orgId: string, cameraId: string) {
  const row = await getCameraRow(cameraId, orgId);
  const own = registry.get(row.brand_key);
  const plays = (a: typeof own | undefined) => Boolean(a?.listRecordings && (a.playbackRtspPath || a.replayRtspUrl));
  const adapter = plays(own) ? own : onvifAdapter();
  if (!adapter || !plays(adapter)) {
    throw new HttpError(422, "PLAYBACK_UNAVAILABLE", `Playing recordings is not available for ${own.meta.displayName} cameras yet`);
  }
  const { requestTimeoutMs } = await getMonitoringSettings();
  return { adapter, own, config: await getCameraConfig(cameraId, requestTimeoutMs) };
}

/** Recorded periods on the camera's storage on `date` (YYYY-MM-DD, camera local time). */
export async function listRecordings(orgId: string, cameraId: string, date: string) {
  const { adapter, own, config } = await playbackAdapter(orgId, cameraId);
  const from = Date.parse(`${date}T00:00:00Z`);
  const to = from + DAY_MS;
  let result: RecordingList;
  try {
    result = await adapter.listRecordings!(config, from, to);
  } catch (err) {
    if (adapter === own) throw err;
    throw new HttpError(422, "PLAYBACK_UNAVAILABLE", `${own.meta.displayName} recordings are read over ONVIF (Profile G), which failed: ${(err as Error).message}. Turn on ONVIF in the camera.`);
  }
  lastListing.set(cameraId, result);
  const segments = result.segments
    .filter((s) => s.end > from && s.start < to)
    .map((s) => ({ start: wall(Math.max(s.start, from)), end: wall(Math.min(s.end, to)) }));
  return { date, cameraNow: wall(result.nowMs), segments, playsFromRecordingStart: result.playsFromRecordingStart ?? false };
}

/** Per camera and month: the days holding recordings, kept briefly so paging the calendar is quick. */
const dayCache = new Map<string, { at: number; days: string[] }>();

/** The days of `month` (YYYY-MM, camera local time) with recordings on the camera's storage. */
export async function recordedDays(orgId: string, cameraId: string, month: string): Promise<string[]> {
  const key = `${cameraId}:${month}`;
  const cached = dayCache.get(key);
  if (cached && Date.now() - cached.at < 120_000) return cached.days;
  const { adapter, config } = await playbackAdapter(orgId, cameraId);
  const from = Date.parse(`${month}-01T00:00:00Z`);
  const next = new Date(from);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const to = next.getTime();
  const list = await adapter.listRecordings!(config, from, to);
  const days = new Set<string>();
  for (const s of list.segments) {
    // Every day the recording touches, within the month.
    for (let d = Math.max(Math.floor(s.start / DAY_MS) * DAY_MS, from); d < Math.min(s.end, to); d += DAY_MS) days.add(wall(d).slice(0, 10));
  }
  const result = [...days].sort();
  if (dayCache.size > 2000) dayCache.clear();
  dayCache.set(key, { at: Date.now(), days: result });
  return result;
}

/**
 * When the recordings on the camera begin (camera local time, YYYY-MM-DDTHH:MM:SS), or null when it
 * holds none: from the camera's recording range where it reports one, else from its recordings of
 * the last 400 days.
 */
export async function oldestRecording(orgId: string, cameraId: string): Promise<string | null> {
  const { adapter, own, config } = await playbackAdapter(orgId, cameraId);
  const ranged = own.getRecordingRange ? own : adapter.getRecordingRange ? adapter : undefined;
  if (ranged) {
    const range = await ranged.getRecordingRange!(config).catch(() => undefined);
    if (range !== undefined) return range?.oldest ?? null;
  }
  const now = Date.now();
  const list = await adapter.listRecordings!(config, now - 400 * DAY_MS, now + DAY_MS);
  const first = list.segments[0];
  return first ? wall(first.start) : null;
}

/**
 * Points this session's playback stream at the recordings from `start` (camera local time).
 * Returns the time playback really starts (the recording's start, for brands that play by id).
 */
export async function preparePlayback(orgId: string, cameraId: string, sessionId: string, start: string, speed = 1): Promise<string> {
  if (!liveVideoEnabled()) throw new HttpError(404, "LIVE_VIDEO_OFF", "Playing recordings needs the live video service (go2rtc), which is not set up on this server");
  const { adapter, config } = await playbackAdapter(orgId, cameraId);
  const local = Date.parse(`${start}Z`);
  const listing = lastListing.get(cameraId);
  const shift = listing?.shiftMs ?? 0;
  const segment = listing?.segments.find((s) => s.start <= local && local < s.end) ?? listing?.segments.find((s) => s.start > local);
  const fromStart = listing?.playsFromRecordingStart && segment;
  const utcSegment = segment && { ...segment, start: segment.start - shift, end: segment.end - shift };
  const name = playbackStreamName(cameraId, sessionId);
  if (adapter.playbackRtspPath) {
    const path = adapter.playbackRtspPath(local - shift, utcSegment);
    // Faster than normal: through the relay, which asks the camera for it (RTSP Scale).
    const src = speed > 1
      ? registerReplay(relayBase(), name, { host: config.host, port: RTSP_PORT, path, username: config.username, password: config.password, onvif: false, scale: speed })
      : rtspUrl(config, path);
    await putStream(name, src);
    return fromStart ? wall(segment.start) : start;
  }
  // ONVIF replay: go2rtc plays through the relay, which adds the start time the camera needs.
  let uri: URL;
  try {
    uri = new URL(await adapter.replayRtspUrl!(config, utcSegment));
  } catch (err) {
    throw new HttpError(422, "PLAYBACK_UNAVAILABLE", `The camera's recording address could not be read over ONVIF: ${(err as Error).message}`);
  }
  if (uri.protocol !== "rtsp:") throw new HttpError(422, "PLAYBACK_UNAVAILABLE", `The camera gave a recording address that cannot be played (${uri.protocol})`);
  // A time in a gap plays from the next recording.
  const startUtc = Math.max(local - shift, utcSegment?.start ?? -Infinity);
  const relayed = registerReplay(relayBase(), name, {
    host: config.host,
    port: uri.port ? Number(uri.port) : RTSP_PORT,
    path: `${uri.pathname}${uri.search}`,
    username: config.username,
    password: config.password,
    onvif: true,
    startUtcMs: startUtc,
    scale: speed > 1 ? speed : undefined,
  });
  await putStream(name, relayed);
  return wall(startUtc + shift);
}
