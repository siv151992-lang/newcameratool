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
export const streamName = (cameraId: string, channel?: number) => `camera_${cameraId}${channel ? `_c${channel}` : ""}`;

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
export async function prepareStream(orgId: string, cameraId: string, channel?: number): Promise<string> {
  if (!liveVideoEnabled()) throw new HttpError(404, "LIVE_VIDEO_OFF", "Smooth live video is not set up on this server");
  const row = await getCameraRow(cameraId, orgId);
  const adapter = registry.get(row.brand_key);
  const { requestTimeoutMs } = await getMonitoringSettings();
  const config = await getCameraConfig(cameraId, requestTimeoutMs);
  let src: string;
  if (channel && row.device_type === "nvr") {
    // A channel of an NVR: that channel's stream paths.
    if (!adapter.channelRtspPaths) throw new HttpError(422, "LIVE_VIDEO_UNAVAILABLE", `Live video of NVR channels is not available for ${adapter.meta.displayName}`);
    src = await chooseLiveSource(`${cameraId}:c${channel}`, adapter, config, adapter.channelRtspPaths(channel), false);
  } else if (adapter.rtspPath) src = await chooseLiveSource(cameraId, adapter, config);
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
  const name = streamName(cameraId, channel && row.device_type === "nvr" ? channel : undefined);
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
async function chooseLiveSource(cameraId: string, adapter: CameraBrandAdapter, config: CameraConfig, candidates?: string[], useOnvif = true): Promise<string> {
  const paths = candidates ?? [adapter.rtspPath!, ...(adapter.rtspFallbacks ?? [])];
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
    if (status === 0) return rtspUrl(config, paths[0]!);
  }
  // Last, the address the camera itself gives over ONVIF.
  const onvif = useOnvif ? onvifAdapter() : undefined;
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

/**
 * Per camera: the days listed lately (by the day's start), to turn a chosen local time into the
 * camera's playback time without searching the camera again (a Hikvision search takes seconds, and
 * the player lists the days either side too, so one listing per camera was always the wrong day).
 */
const listings = new Map<string, Map<number, { list: RecordingList; at: number }>>();
/** Per camera: its clock's offset from UTC, learned when its recordings are listed (camera time now vs ours). */
const clockOffsets = new Map<string, number>();
const LISTING_DAYS_KEPT = 7;
function rememberListing(key: string, list: RecordingList, day: number) {
  if (listings.size > 5000) {
    listings.clear();
    clockOffsets.clear();
  }
  const days = listings.get(key) ?? new Map<number, { list: RecordingList; at: number }>();
  days.delete(day);
  days.set(day, { list, at: Date.now() });
  while (days.size > LISTING_DAYS_KEPT) days.delete(days.keys().next().value!);
  listings.set(key, days);
  // Time zones are whole quarter hours; this also absorbs a camera clock a few minutes off.
  clockOffsets.set(key, Math.round((list.nowMs - Date.now()) / 900_000) * 900_000);
}
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
/** Key for per-camera caches: the camera, or one NVR channel. */
const listingKey = (cameraId: string, channel?: number) => (channel ? `${cameraId}:c${channel}` : cameraId);

export async function listRecordings(orgId: string, cameraId: string, date: string, channel?: number) {
  const { adapter, own, config } = await playbackAdapter(orgId, cameraId);
  const from = Date.parse(`${date}T00:00:00Z`);
  const to = from + DAY_MS;
  let result: RecordingList;
  try {
    result = await adapter.listRecordings!(config, from, to, channel);
  } catch (err) {
    if (adapter === own) throw err;
    throw new HttpError(422, "PLAYBACK_UNAVAILABLE", `${own.meta.displayName} recordings are read over ONVIF (Profile G), which failed: ${(err as Error).message}. Turn on ONVIF in the camera.`);
  }
  rememberListing(listingKey(cameraId, channel), result, from);
  const segments = result.segments
    .filter((s) => s.end > from && s.start < to)
    .map((s) => ({ start: wall(Math.max(s.start, from)), end: wall(Math.min(s.end, to)) }));
  return { date, cameraNow: wall(result.nowMs), segments, playsFromRecordingStart: result.playsFromRecordingStart ?? false };
}

/** Per camera and month: the days holding recordings, kept briefly so paging the calendar is quick. */
const dayCache = new Map<string, { at: number; days: string[] }>();

/** The days of `month` (YYYY-MM, camera local time) with recordings on the camera's storage. */
export async function recordedDays(orgId: string, cameraId: string, month: string, channel?: number): Promise<string[]> {
  const key = `${listingKey(cameraId, channel)}:${month}`;
  const cached = dayCache.get(key);
  if (cached && Date.now() - cached.at < 120_000) return cached.days;
  const { adapter, config } = await playbackAdapter(orgId, cameraId);
  const from = Date.parse(`${month}-01T00:00:00Z`);
  const next = new Date(from);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const to = next.getTime();
  const list = await adapter.listRecordings!(config, from, to, channel);
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
export async function oldestRecording(orgId: string, cameraId: string, channel?: number): Promise<string | null> {
  const { adapter, own, config } = await playbackAdapter(orgId, cameraId);
  // The recording range is the device's (all channels): an NVR channel is searched instead.
  const ranged = channel && channel > 1 ? undefined : own.getRecordingRange ? own : adapter.getRecordingRange ? adapter : undefined;
  if (ranged) {
    const range = await ranged.getRecordingRange!(config).catch(() => undefined);
    if (range !== undefined) return range?.oldest ?? null;
  }
  const now = Date.now();
  const list = await adapter.listRecordings!(config, now - 400 * DAY_MS, now + DAY_MS, channel);
  const first = list.segments[0];
  return first ? wall(first.start) : null;
}

/** A listing this recent is used even for a time after its last recording (the next one may not be in it yet). */
const LISTING_FRESH_MS = 60_000;

/**
 * The day listing that covers `local` (camera local time): one listed lately (holding that time in a
 * recording, or listed within the last minute), else that day's, read now.
 */
async function listingFor(adapter: CameraBrandAdapter, config: CameraConfig, cameraId: string, local: number, channel?: number): Promise<RecordingList | undefined> {
  const key = listingKey(cameraId, channel);
  const day = Math.floor(local / DAY_MS) * DAY_MS;
  const days = listings.get(key);
  const known = days?.get(day);
  if (known && (Date.now() - known.at < LISTING_FRESH_MS || known.list.segments.some((s) => s.start <= local && local < s.end))) return known.list;
  // A recording that runs on from the day before, listed with that day.
  const before = days?.get(day - DAY_MS);
  if (before?.list.segments.some((s) => s.start <= local && local < s.end)) return before.list;
  // After a restart, or a time not in any day listed lately: list that day.
  try {
    const list = await adapter.listRecordings!(config, day, day + DAY_MS, channel);
    rememberListing(key, list, day);
    return list;
  } catch {
    return known?.list;
  }
}

/** Per camera (or NVR channel): which of the brand's playback paths the camera served, for a while. */
const playbackVariants = new Map<string, { variant: number; at: number }>();
const PLAYBACK_VARIANT_TTL_MS = 10 * 60_000;

export type PlaybackPick = { path: string; checked: boolean } | { refused: { path: string; status: number }[] };

/**
 * The first of `paths` the camera serves (RTSP DESCRIBE answered 200), trying the one that worked
 * last time first. When the camera's RTSP port does not answer from here at all, the first path is
 * used unchecked (the video service may still reach it). A refused login stops the search: every
 * path uses the same login.
 */
export async function pickPlaybackPath(paths: string[], probe: (path: string) => Promise<number>, preferred = 0): Promise<PlaybackPick & { variant?: number }> {
  const order = [...new Set([Math.min(preferred, paths.length - 1), ...paths.keys()])];
  const refused: { path: string; status: number }[] = [];
  for (const i of order) {
    const status = await probe(paths[i]!).catch(() => 0);
    if (status === 200) return { path: paths[i]!, checked: true, variant: i };
    if (status === 0 && refused.length === 0) return { path: paths[i]!, checked: false, variant: i };
    refused.push({ path: paths[i]!, status });
    if (status === 401 || status === 403) break;
  }
  return { refused };
}

/**
 * Points this session's playback stream at the recordings from `start` (camera local time).
 * Returns the time playback really starts: the next recording's start for a time in a gap, and
 * the recording's start for brands that play by id.
 *
 * The brand's playback address is checked with the camera first (as live video is), then its other
 * addresses (the sub stream, other firmware), then ONVIF replay, so a camera that refuses one way
 * still plays, and one that refuses all is explained instead of failing in the player.
 */
export async function preparePlayback(orgId: string, cameraId: string, sessionId: string, start: string, speed = 1, channel?: number): Promise<{ start: string; via: string }> {
  if (!liveVideoEnabled()) throw new HttpError(404, "LIVE_VIDEO_OFF", "Playing recordings needs the live video service (go2rtc), which is not set up on this server");
  const { adapter, config } = await playbackAdapter(orgId, cameraId);
  const local = Date.parse(`${start}Z`);
  const listing = await listingFor(adapter, config, cameraId, local, channel);
  const shift = listing?.shiftMs ?? 0;
  const segment = listing?.segments.find((s) => s.start <= local && local < s.end) ?? listing?.segments.find((s) => s.start > local);
  const fromStart = listing?.playsFromRecordingStart && segment;
  // A time in a gap (or before the first recording of the day) plays from the next recording.
  const playFrom = segment && segment.start > local ? segment.start : local;
  const utcSegment = segment && { ...segment, start: segment.start - shift, end: segment.end - shift };
  const name = playbackStreamName(cameraId, sessionId);
  const startedAt = (via: string) => ({ start: wall(fromStart ? segment.start : playFrom), via });

  let refused: { path: string; status: number }[] = [];
  if (adapter.playbackRtspPath && !(listing?.viaOnvif && adapter.replayRtspUrl)) {
    let paths: string[];
    try {
      paths = [adapter.playbackRtspPath(playFrom - shift, utcSegment, channel), ...(adapter.playbackRtspFallbacks?.(playFrom - shift, utcSegment, channel) ?? [])];
    } catch (err) {
      throw new HttpError(422, "PLAYBACK_UNAVAILABLE", (err as Error).message);
    }
    const key = listingKey(cameraId, channel);
    const known = playbackVariants.get(key);
    const recent = known && Date.now() - known.at < PLAYBACK_VARIANT_TTL_MS && known.variant < paths.length;
    // The address served a moment ago is used without asking the camera again (each seek, speed
    // change and resume prepares playback anew); a refusal is still explained by the relay.
    const pick: PlaybackPick & { variant?: number } = recent
      ? { path: paths[known.variant]!, checked: false, variant: known.variant }
      : await pickPlaybackPath(
        paths,
        (path) => probeRtsp({ host: config.host, port: RTSP_PORT, path, username: config.username, password: config.password }),
        0,
      );
    if ("path" in pick) {
      if (pick.checked) {
        if (playbackVariants.size > 5000) playbackVariants.clear();
        playbackVariants.set(key, { variant: pick.variant ?? 0, at: Date.now() });
      }
      // Through the relay when faster than normal (it asks the camera for it: RTSP Scale), and for
      // brands whose firmware may ignore the start time in the address (it adds it as a clock range).
      const offset = clockOffsets.get(listingKey(cameraId, channel));
      const clockStart = adapter.playbackClockRange && offset !== undefined ? playFrom - offset : undefined;
      // Also every address with a query (a start time): go2rtc appends the stream part after the query,
      // which the relay puts back before it (otherwise the camera misreads the time). Always through
      // the relay, so a recording that does not play can be explained from what the camera answered.
      const src = registerReplay(relayBase(), name, { host: config.host, port: RTSP_PORT, path: pick.path, username: config.username, password: config.password, onvif: false, scale: speed > 1 ? speed : undefined, startUtcMs: clockStart });
      await putStream(name, src);
      return startedAt(pick.path.split("?")[0]!);
    }
    refused = pick.refused;
    logger.warn({ cameraId, refused }, "Playback: the camera served none of its playback addresses");
    if (refused.some((r) => r.status === 401 || r.status === 403)) {
      throw new HttpError(422, "PLAYBACK_UNAVAILABLE", `The camera's recordings could not be opened: ${probeReason(401)}. Recordings may need the camera user's playback permission.`);
    }
  }

  // ONVIF replay (Profile G): the brand's own, or the camera's standard one when its own was refused.
  const via = adapter.replayRtspUrl ? adapter : onvifAdapter();
  const triedText = refused.length ? ` The camera refused ${refused.map((r) => `${r.path.split("?")[0]} (${r.status})`).join(", ")}.` : "";
  if (!via?.replayRtspUrl) {
    throw new HttpError(422, "PLAYBACK_UNAVAILABLE", `The camera's recordings could not be opened.${triedText} Turn on ONVIF in the camera, or set its recording to H.264.`);
  }
  let uri: URL;
  try {
    // A brand's own recording id means nothing to ONVIF: let the camera pick its recording.
    uri = new URL(await via.replayRtspUrl(config, via === adapter ? utcSegment : undefined));
  } catch (err) {
    throw new HttpError(422, "PLAYBACK_UNAVAILABLE", `The camera's recording address could not be read over ONVIF: ${(err as Error).message}.${triedText}`);
  }
  if (uri.protocol !== "rtsp:") throw new HttpError(422, "PLAYBACK_UNAVAILABLE", `The camera gave a recording address that cannot be played (${uri.protocol})`);
  // The relay adds the start time the camera needs.
  const startUtc = playFrom - shift;
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
  return { start: wall(startUtc + shift), via: "ONVIF replay" };
}
