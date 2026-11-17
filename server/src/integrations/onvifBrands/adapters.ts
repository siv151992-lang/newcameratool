import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { OnvifBrandAdapter } from "../common/onvifBrandAdapter.js";
import type { BrandMeta } from "../types.js";

/**
 * Leading brands whose own storage APIs are not public (or differ by model), listed under their
 * own names and read over ONVIF (Profile S and G), which they implement: storage, recording
 * status, days of recordings, playback, device information and the live stream address. Brands
 * sold on Hikvision or Dahua firmware are better read with those adapters: Camera brands →
 * Detect on one of their cameras finds the right one.
 */
interface OnvifBrand {
  key: string;
  displayName: string;
  /** Where ONVIF is turned on in the camera's web page, and anything else worth knowing. */
  howTo: string;
  /** The brand's own picture address, tried before ONVIF's. */
  snapshotPath?: string;
}

const BRANDS: OnvifBrand[] = [
  { key: "vivotek", displayName: "Vivotek", howTo: "ONVIF is on by default; use a camera user of the Administrator or Operator group.", snapshotPath: "/cgi-bin/viewer/video.jpg" },
  { key: "avigilon", displayName: "Avigilon", howTo: "Turn on ONVIF in the camera's web page (Setup → ONVIF) and add an ONVIF user there." },
  { key: "pelco", displayName: "Pelco", howTo: "Turn on ONVIF (and its user) in the camera's web page (System → ONVIF)." },
  { key: "honeywell", displayName: "Honeywell", howTo: "Turn on ONVIF in the camera's web page. Some Honeywell series run Hikvision or Dahua firmware: Detect finds the faster adapter." },
  { key: "tiandy", displayName: "Tiandy", howTo: "Turn on ONVIF in the camera's web page (Network → Advanced → ONVIF) and add an ONVIF user." },
  { key: "milesight", displayName: "Milesight", howTo: "Turn on ONVIF in the camera's web page (Network → ONVIF)." },
  { key: "mobotix", displayName: "Mobotix", howTo: "Turn on ONVIF in the camera's web page (Admin Menu → Network Setup → ONVIF).", snapshotPath: "/record/current.jpg" },
  { key: "tplink-vigi", displayName: "TP-Link VIGI", howTo: "ONVIF is on by default on VIGI cameras; use the camera's admin user." },
  { key: "matrix", displayName: "Matrix (India)", howTo: "Turn on ONVIF in the camera's web page (Network → ONVIF)." },
  { key: "godrej", displayName: "Godrej", howTo: "Turn on ONVIF in the camera's web page. Some Godrej models run Hikvision, Dahua or Uniview firmware: Detect finds the faster adapter." },
];

class OnvifNamedAdapter extends OnvifBrandAdapter {
  override readonly meta: BrandMeta;
  protected override readonly snapshotPath?: string;

  constructor(client: CameraHttpClient, brand: OnvifBrand) {
    super(client);
    this.snapshotPath = brand.snapshotPath;
    this.meta = {
      key: brand.key,
      displayName: brand.displayName,
      supportStatus: "unverified",
      authMethods: ["ws-security (ONVIF)", "digest"],
      defaultPorts: { http: 80, https: 443 },
      capabilities: ["storage-status", "recording-status", "device-info", "connection-test", "live-view", "playback", "multiple-storage-devices"],
      storageEndpoint: "ONVIF GetStorageDevices (device service)",
      defaultTimeoutMs: 10000,
      notes:
        `Read over ONVIF (Profile S and G): storage, recording status, days of recordings and playback, and the live stream address. ${brand.howTo} ` +
        "Keep the camera's clock right (NTP).",
    };
  }
}

export function onvifBrandAdapters(http: CameraHttpClient): OnvifBrandAdapter[] {
  return BRANDS.map((b) => new OnvifNamedAdapter(http, b));
}
