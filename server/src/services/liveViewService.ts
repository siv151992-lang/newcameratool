import { registry } from "../integrations/registry.js";
import type { Snapshot } from "../integrations/snapshot.js";
import { HttpError } from "../lib/errors.js";
import { getCameraConfig, getCameraRow } from "./cameraService.js";
import { getMonitoringSettings } from "./settingsService.js";

/** The camera's current picture, fetched with its stored credentials. Never stored. */
export async function getSnapshot(orgId: string, id: string): Promise<Snapshot> {
  const row = await getCameraRow(id, orgId);
  const adapter = registry.get(row.brand_key);
  if (!adapter.getSnapshot) {
    throw new HttpError(422, "LIVE_VIEW_UNAVAILABLE", `Live view is not available for ${adapter.meta.displayName} cameras yet`);
  }
  const { requestTimeoutMs } = await getMonitoringSettings();
  return adapter.getSnapshot(await getCameraConfig(id, requestTimeoutMs));
}
