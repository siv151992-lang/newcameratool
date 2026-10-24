import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { config } from "../config.js";
import { registry } from "../integrations/registry.js";
import type { CameraConfig } from "../integrations/types.js";
import { HttpError } from "../lib/errors.js";
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
  try {
    if (registered.get(name) === hash && (await streamExists(name))) return name;
    const res = await fetch(`${base()}/api/streams?name=${encodeURIComponent(name)}&src=${encodeURIComponent(src)}`, { method: "PUT", signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    throw new HttpError(502, "LIVE_VIDEO_SERVICE", "The live video service is not answering. Check that the go2rtc container is running.");
  }
  registered.set(name, hash);
  return name;
}
