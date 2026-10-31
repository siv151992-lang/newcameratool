import type { CameraHttpClient } from "./http/cameraHttpClient.js";
import { CameraApiError, type CameraConfig } from "./types.js";

/** Nothing at all from the camera for this long (cameras send a heartbeat every few seconds): reconnect. */
export const EVENT_STREAM_IDLE_MS = 90_000;

/**
 * Opens a camera's event stream at `path` and feeds its bytes to `push` until it ends. Digest login
 * as for every other request; a camera without the stream rejects with API_UNAVAILABLE.
 */
export async function readEventStream(
  http: CameraHttpClient,
  camera: CameraConfig,
  path: string,
  push: (chunk: Buffer) => void,
  signal: AbortSignal,
  onOpen?: () => void,
): Promise<void> {
  const res = await http.request(camera, {
    path,
    accept: "multipart/mixed, application/xml, text/plain, */*",
    stream: { onData: push, idleMs: EVENT_STREAM_IDLE_MS, signal },
  });
  if (!res.done) {
    const missing = res.status === 404 || res.status === 405 || res.status === 501;
    throw new CameraApiError(missing ? "API_UNAVAILABLE" : "API_ERROR", missing
      ? `The camera has no event stream at ${path} (HTTP ${res.status})`
      : `The camera refused its event stream (HTTP ${res.status})`, { httpStatus: res.status });
  }
  onOpen?.();
  await res.done;
}
