import { CameraApiError, type CameraBrandAdapter, type CameraConfig, type RecordingRange } from "../integrations/types.js";

const DAY_MS = 86_400_000;
/** How far back the recordings are listed; a camera that refuses a long search is asked a shorter one. */
const LOOKBACK_DAYS = [400, 90, 31, 7, 1, 0.5];
const REFUSALS = ["API_ERROR", "INVALID_RESPONSE", "TIMEOUT"];

/**
 * Days of recordings on the camera, for every brand that can tell: the brand's own report where it
 * has one (Hikvision, Uniview, Reolink, ONVIF brands); otherwise worked out from its list of
 * recordings (Dahua and CP Plus V-series, Hanwha, Axis): the oldest recording against the camera's
 * time now; otherwise over ONVIF (Panasonic and other brands without a list of their own).
 * Undefined when nothing can tell (the camera page then says the brand does not report it).
 */
export async function recordingRangeOf(adapter: CameraBrandAdapter, cfg: CameraConfig, onvif?: CameraBrandAdapter): Promise<RecordingRange | null | undefined> {
  if (adapter.getRecordingRange) {
    try {
      return await adapter.getRecordingRange(cfg);
    } catch (err) {
      // Firmware that refuses the brand's long search may still list a shorter period.
      if (!adapter.listRecordings || !(err instanceof CameraApiError) || !REFUSALS.includes(err.code)) throw err;
      // Only the real oldest recording counts here; a lower bound ("at least") from a short search
      // says less than the refusal (the last value is kept).
      const listed = await rangeFromListing(adapter, cfg).catch(() => undefined);
      if (listed === undefined || listed?.atLeast) throw err;
      return listed;
    }
  }
  if (adapter.listRecordings) return rangeFromListing(adapter, cfg);
  if (onvif?.getRecordingRange && onvif !== adapter) return onvif.getRecordingRange(cfg);
  return undefined;
}

async function rangeFromListing(adapter: CameraBrandAdapter, cfg: CameraConfig): Promise<RecordingRange | null> {
  const now = Date.now();
  let lastError: unknown;
  for (const days of LOOKBACK_DAYS) {
    try {
      const list = await adapter.listRecordings!(cfg, now - days * DAY_MS, now + DAY_MS);
      const first = list.segments.reduce<number | undefined>((min, s) => (min === undefined || s.start < min ? s.start : min), undefined);
      if (first === undefined) return null;
      const held = Math.max(0, (list.nowMs - first) / DAY_MS);
      // Recordings from the very start of a shortened search: the card may hold more.
      const atLeast = first - (list.nowMs - days * DAY_MS) < DAY_MS;
      return { oldest: new Date(first).toISOString().slice(0, 19), days: Math.round(held * 100) / 100, ...(atLeast ? { atLeast } : {}) };
    } catch (err) {
      lastError = err;
      if (!(err instanceof CameraApiError) || !REFUSALS.includes(err.code)) throw err;
    }
  }
  throw lastError;
}
