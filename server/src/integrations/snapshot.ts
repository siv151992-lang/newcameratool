import type { CameraHttpClient } from "./http/cameraHttpClient.js";
import { CameraApiError, type CameraConfig } from "./types.js";

/** A still picture from the camera, for the live view. Only JPEG and PNG are passed on. */
export interface Snapshot {
  contentType: "image/jpeg" | "image/png";
  data: Buffer;
}

const MAX_BYTES = 10 * 1024 * 1024;

export async function fetchSnapshot(http: CameraHttpClient, camera: CameraConfig, path: string): Promise<Snapshot> {
  const res = await http.request(camera, { path, accept: "image/jpeg, image/png;q=0.9, */*;q=0.1", binary: { maxBytes: MAX_BYTES } });
  if (res.status === 404 || res.status === 501) throw new CameraApiError("API_UNAVAILABLE", "This camera does not offer pictures over its web API");
  if (res.status >= 400) throw new CameraApiError("API_ERROR", `The camera answered HTTP ${res.status} when asked for a picture`, { httpStatus: res.status });
  const data = res.raw ?? Buffer.alloc(0);
  // Decide the type from the bytes, never from the camera's header, so nothing else can be served.
  if (data[0] === 0xff && data[1] === 0xd8) return { contentType: "image/jpeg", data };
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { contentType: "image/png", data };
  throw new CameraApiError("INVALID_RESPONSE", "The camera did not return a picture");
}
