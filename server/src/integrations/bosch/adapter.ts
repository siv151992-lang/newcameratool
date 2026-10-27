import { OnvifBrandAdapter } from "../common/onvifBrandAdapter.js";
import type { BrandMeta } from "../types.js";

/**
 * Bosch IP cameras (CPP firmware: FLEXIDOME, DINION, AUTODOME, MIC, NBN/NDE…). Bosch's own
 * protocol (RCP+) is not used: its storage commands are not publicly documented. Bosch cameras
 * implement ONVIF Profile S and G, so everything is read over ONVIF; the picture comes from
 * Bosch's snapshot address first.
 */
export class BoschAdapter extends OnvifBrandAdapter {
  override readonly meta: BrandMeta = {
    key: "bosch",
    displayName: "Bosch",
    supportStatus: "unverified",
    authMethods: ["ws-security (ONVIF)", "digest"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "live-view", "playback", "multiple-storage-devices"],
    storageEndpoint: "ONVIF GetStorageDevices (device service)",
    defaultTimeoutMs: 10000,
    notes:
      "Read over ONVIF (Profile S and G), which Bosch cameras implement: storage, recording status, the SD card's recordings " +
      "and playback, and the live stream address. Pictures from /snap.jpg. In the camera's web page, add an ONVIF user " +
      "(Configuration → General → User Management) or use a camera user with ONVIF access, and keep the camera's clock right (NTP).",
  };

  protected override readonly snapshotPath = "/snap.jpg?JpegSize=M";
}
