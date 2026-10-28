import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HikvisionAdapter } from "../../src/integrations/hikvision/adapter.js";
import { CameraHttpClient } from "../../src/integrations/http/cameraHttpClient.js";
import type { CameraConfig } from "../../src/integrations/types.js";
import { HostGuard } from "../../src/security/hostGuard.js";
import { MockHikvisionCamera } from "../../src/testing/mockHikvision.js";

const DAY = 86_400_000;
const IST = 330; // India: UTC+05:30
const http = new CameraHttpClient(new HostGuard({ allowedNetworks: "10.0.0.0/8", allowLoopback: true }));

describe("Hikvision firmware that searches in UTC, in India, just after midnight", () => {
  const cam = new MockHikvisionCamera("admin", "Cam-Pass-123");
  let config: CameraConfig;
  // The camera's local time: 03:10 today (UTC is still yesterday, 21:40).
  const localNow = () => Date.now() + IST * 60_000;
  const today = Math.floor(localNow() / DAY) * DAY;
  beforeAll(async () => {
    cam.recordingStatusApi = false;
    cam.utcOffsetMinutes = IST;
    cam.searchRepliesUtc = true;
    cam.clockSkewMs = today + (3 * 60 + 10) * 60_000 - localNow();
    const port = await cam.start();
    config = { host: "127.0.0.1", port, protocol: "http", username: "admin", password: "Cam-Pass-123", timeoutMs: 5000 };
  });
  afterAll(() => cam.stop());

  it("finds today's recordings: today asked in UTC starts in the camera's future, so it asks the period it means", async () => {
    const list = await new HikvisionAdapter(http).listRecordings(config, today, today + DAY);
    expect(list.shiftMs).toBe(IST * 60_000);
    expect(list.segments.length).toBeGreaterThan(0);
    // The current recording, in local time: up to the camera's 03:10 (written 20 s ago).
    const latest = Math.max(...list.segments.map((s) => s.end));
    expect(Math.abs(latest - list.nowMs)).toBeLessThan(60_000);
    expect(new Date(list.nowMs).toISOString().slice(11, 16)).toBe("03:10");
  });

  it("and yesterday as before", async () => {
    const list = await new HikvisionAdapter(http).listRecordings(config, today - DAY, today);
    expect(list.shiftMs).toBe(IST * 60_000);
    expect(list.segments.length).toBeGreaterThan(0);
    expect(list.segments.every((s) => s.start >= today - DAY - 3600_000 && s.end <= today + 3600_000)).toBe(true);
  });
});
