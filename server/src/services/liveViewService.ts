import { registry } from "../integrations/registry.js";
import type { Snapshot } from "../integrations/snapshot.js";
import { HttpError } from "../lib/errors.js";
import { getCameraConfig, getCameraRow } from "./cameraService.js";
import { getMonitoringSettings } from "./settingsService.js";

/** The camera's current picture, fetched with its stored credentials. Never stored. */
export async function getSnapshot(orgId: string, id: string, channel?: number): Promise<Snapshot> {
  const row = await getCameraRow(id, orgId);
  const adapter = registry.get(row.brand_key);
  const { requestTimeoutMs } = await getMonitoringSettings();
  const config = await getCameraConfig(id, requestTimeoutMs);
  // A channel only means something on an NVR.
  const ch = row.device_type === "nvr" ? channel : undefined;
  if (adapter.getSnapshot) return adapter.getSnapshot(config, ch);
  // ONVIF gives the device's first picture only: never show it as another channel's.
  if (ch && ch > 1) throw new HttpError(422, "LIVE_VIEW_UNAVAILABLE", `Pictures of NVR channels are not available for ${adapter.meta.displayName}. Use video.`);
  // No picture API of its own (custom integrations): most IP cameras give one over ONVIF.
  const onvif = onvifAdapter();
  if (!onvif?.getSnapshot) throw new HttpError(422, "LIVE_VIEW_UNAVAILABLE", `Live view is not available for ${adapter.meta.displayName} cameras`);
  try {
    return await onvif.getSnapshot(config);
  } catch (err) {
    throw new HttpError(422, "LIVE_VIEW_UNAVAILABLE", `${adapter.meta.displayName} has no picture API of its own, and over ONVIF: ${(err as Error).message}. Turn on ONVIF in the camera.`);
  }
}

/** The ONVIF integration, used for brands without their own live view; undefined if it is off. */
export function onvifAdapter() {
  try {
    return registry.get("onvif");
  } catch {
    return undefined;
  }
}
