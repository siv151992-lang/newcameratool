import { HIKVISION_STORAGE_PATH, HikvisionAdapter } from "../hikvision/adapter.js";
import type { BrandMeta } from "../types.js";

/**
 * Prama Hikvision (India) cameras and NVRs run Hikvision firmware: the same ISAPI, streams and
 * playback. Listed as their own brand so they show as Prama; everything else is Hikvision's.
 */
export class PramaAdapter extends HikvisionAdapter {
  override readonly meta: BrandMeta = {
    key: "prama",
    displayName: "Prama (Hikvision India)",
    supportStatus: "supported",
    authMethods: ["digest", "basic (HTTPS only)"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "live-view", "playback", "multiple-storage-devices", "nas"],
    storageEndpoint: `GET ${HIKVISION_STORAGE_PATH}`,
    defaultTimeoutMs: 10000,
    notes:
      "Prama Hikvision cameras and NVRs use Hikvision's ISAPI with HTTP Digest authentication: storage, recording " +
      "(Recording/status, or the newest recording on the storage), live video, recordings and NVR channels work as for Hikvision.",
    compatibility: "Prama Hikvision India models with Hikvision firmware (ISAPI).",
  };
}
