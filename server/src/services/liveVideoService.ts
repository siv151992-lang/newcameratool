import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { config } from "../config.js";
import { registry } from "../integrations/registry.js";
import type { CameraConfig } from "../integrations/types.js";
import { HttpError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { getCameraConfig, getCameraRow } from "./cameraService.js";
import { getMonitoringSettings } from "./settingsService.js";

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

const base = () => config.LIVE_VIDEO_URL!.replace(/\/+$/, "");

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
  if (!adapter.rtspPath) throw new HttpError(422, "LIVE_VIDEO_UNAVAILABLE", `Live video is not available for ${adapter.meta.displayName} cameras yet`);
  const { requestTimeoutMs } = await getMonitoringSettings();
  const src = rtspUrl(await getCameraConfig(cameraId, requestTimeoutMs), adapter.rtspPath);
  const name = streamName(cameraId);
  const hash = createHash("sha256").update(src).digest("hex");
  let res: Response;
  try {
    if (registered.get(name) === hash && (await streamExists(name))) return name;
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
  registered.set(name, hash);
  return name;
}
