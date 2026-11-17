import { describe, expect, it } from "vitest";
import { recordingRangeOf } from "../../src/monitoring/recordingRange.js";
import { CameraApiError, type CameraBrandAdapter, type CameraConfig } from "../../src/integrations/types.js";

const cfg = { host: "10.0.0.5", port: 80, protocol: "http", username: "admin", password: "x", timeoutMs: 1000 } as CameraConfig;
const DAY = 86_400_000;
const now = Date.parse("2026-11-17T12:00:00Z");

describe("days of recordings for every brand", () => {
  it("works it out from the list of recordings when the brand does not report it (Dahua, Hanwha, Axis)", async () => {
    const asked: number[] = [];
    const adapter = {
      listRecordings: async (_c: CameraConfig, from: number) => {
        asked.push(Math.round((Date.now() - from) / DAY));
        return { segments: [{ start: now - 20 * DAY, end: now - 10 * DAY }, { start: now - 9 * DAY, end: now }], nowMs: now, shiftMs: 0 };
      },
    } as unknown as CameraBrandAdapter;
    expect(await recordingRangeOf(adapter, cfg)).toEqual({ oldest: "2026-10-28T12:00:00", days: 20 });
    expect(asked).toEqual([400]);
  });

  it("asks a shorter period when the camera refuses a long search, and says the card may hold more", async () => {
    const adapter = {
      listRecordings: async (_c: CameraConfig, from: number) => {
        if (Date.now() - from > 31 * DAY) throw new CameraApiError("API_ERROR", "Camera reported: Invalid Content (badParameters)");
        return { segments: [{ start: now - 30.5 * DAY, end: now }], nowMs: now, shiftMs: 0 };
      },
    } as unknown as CameraBrandAdapter;
    expect(await recordingRangeOf(adapter, cfg)).toMatchObject({ days: 30.5, atLeast: true });
  });

  it("uses the brand's own report first, then ONVIF, and says when nothing can tell", async () => {
    const own = { getRecordingRange: async () => ({ oldest: "2026-11-01T00:00:00", days: 16 }), listRecordings: async () => { throw new Error("not used"); } } as unknown as CameraBrandAdapter;
    expect((await recordingRangeOf(own, cfg))?.days).toBe(16);
    const onvif = { getRecordingRange: async () => ({ oldest: "2026-11-10T00:00:00", days: 7 }) } as unknown as CameraBrandAdapter;
    expect((await recordingRangeOf({} as CameraBrandAdapter, cfg, onvif))?.days).toBe(7);
    expect(await recordingRangeOf({} as CameraBrandAdapter, cfg)).toBeUndefined();
    const empty = { listRecordings: async () => ({ segments: [], nowMs: now, shiftMs: 0 }) } as unknown as CameraBrandAdapter;
    expect(await recordingRangeOf(empty, cfg)).toBeNull();
  });
});
