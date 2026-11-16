import { describe, expect, it } from "vitest";
import type { CameraHttpClient, CameraRequest } from "../../src/integrations/http/cameraHttpClient.js";
import { createRegistry } from "../../src/integrations/registry.js";
import { ReolinkAdapter } from "../../src/integrations/reolink/adapter.js";
import { parseReolinkChannels, parseReolinkStorage } from "../../src/integrations/reolink/parser.js";
import type { CameraConfig } from "../../src/integrations/types.js";

const camera: CameraConfig = { host: "10.0.0.20", port: 443, protocol: "https", username: "admin", password: "Reo-Pass-1", timeoutMs: 5000 };

/** Answers like a Reolink RLC-811A (API as documented in Reolink's HTTP API guide). */
function reolink() {
  const calls: { path: string; cmd: string; token?: string }[] = [];
  const searches: { onlyStatus: number; StartTime: { year: number; mon: number; day: number } }[] = [];
  const http = {
    request: async (_c: CameraConfig, req: CameraRequest) => {
      const [entry] = JSON.parse(req.body ?? "[{}]") as { cmd: string; param: { User?: { userName: string; password: string } } }[];
      const token = /[?&]token=([^&]+)/.exec(req.path)?.[1];
      calls.push({ path: req.path, cmd: entry!.cmd, token });
      const json = (o: object) => ({ status: 200, headers: {}, body: JSON.stringify([{ cmd: entry!.cmd, ...o }]) });
      if (entry!.cmd === "Login") {
        return entry!.param.User?.password === "Reo-Pass-1"
          ? json({ code: 0, value: { Token: { leaseTime: 3600, name: "tok123" } } })
          : json({ code: 1, error: { detail: "login failed", rspCode: -7 } });
      }
      if (token !== "tok123") return json({ code: 1, error: { detail: "please login first", rspCode: -6 } });
      if (entry!.cmd === "GetHddInfo") return json({ code: 0, value: { HddInfo: [{ capacity: 122_000, format: 1, id: 0, mount: 1, size: 30_500, storageType: 2 }] } });
      if (entry!.cmd === "GetTime") return json({ code: 0, value: { Time: { year: 2026, mon: 11, day: 16, hour: 12, min: 0, sec: 0 } } });
      if (entry!.cmd === "Search") {
        const q = (entry as unknown as { param: { Search: { onlyStatus: number; StartTime: { year: number; mon: number; day: number } } } }).param.Search;
        searches.push(q);
        const { year, mon } = q.StartTime;
        if (q.onlyStatus === 0) {
          return json({ code: 0, value: { SearchResult: { channel: 0, File: [
            { StartTime: { year, mon, day: q.StartTime.day, hour: 9, min: 30, sec: 0 }, EndTime: { year, mon, day: q.StartTime.day, hour: 9, min: 40, sec: 0 }, name: "b.mp4" },
            { StartTime: { year, mon, day: q.StartTime.day, hour: 6, min: 0, sec: 0 }, EndTime: { year, mon, day: q.StartTime.day, hour: 6, min: 15, sec: 0 }, name: "a.mp4" },
          ] } } });
        }
        // Recordings from 20 October to today (16 November).
        const table = mon === 11 ? "1".repeat(16) + "0".repeat(14) : mon === 10 ? "0".repeat(19) + "1".repeat(12) : "0".repeat(30);
        return json({ code: 0, value: { SearchResult: { channel: 0, Status: [{ mon, table, year }] } } });
      }
      if (entry!.cmd === "GetDevInfo") return json({ code: 0, value: { DevInfo: { model: "RLC-811A", serial: "00000000001", firmVer: "v3.1.0.2368_23062700", name: "Gate" } } });
      return json({ code: 0, value: { rspCode: 200 } });
    },
  } as unknown as CameraHttpClient;
  return { http, calls, searches };
}

describe("Reolink", () => {
  it("logs in, reads the SD card and the device, and logs out", async () => {
    const { http, calls } = reolink();
    const adapter = new ReolinkAdapter(http);
    const storage = await adapter.getStorageStatus(camera);
    expect(storage.devices).toMatchObject([{ id: "0", name: "SD card 1", healthStatus: "healthy", totalBytes: 122_000 * 1024 * 1024, freeBytes: 30_500 * 1024 * 1024 }]);
    expect(storage.usedPercentage).toBe(75);
    expect(await adapter.getDeviceInfo(camera)).toEqual({ model: "RLC-811A", serialNumber: "00000000001", firmwareVersion: "v3.1.0.2368_23062700", deviceName: "Gate" });
    expect(calls.map((c) => c.cmd)).toEqual(["Login", "GetHddInfo", "Logout", "Login", "GetDevInfo", "Logout"]);
  });

  it("reads the days of recordings from the recording search: the oldest day's first file", async () => {
    const { http, calls, searches } = reolink();
    const range = await new ReolinkAdapter(http).getRecordingRange(camera);
    // 20 October 06:00 to 16 November 12:00 (the camera's clock).
    expect(range).toEqual({ oldest: "2026-10-20T06:00:00", days: 27.3 });
    expect(searches.map((q) => [q.onlyStatus, q.StartTime.mon, q.StartTime.day])).toEqual([[1, 11, 1], [1, 10, 1], [0, 10, 20]]);
    expect(calls.at(-1)?.cmd).toBe("Logout");
  });

  it("refuses to send the password over plain HTTP", async () => {
    const { http, calls } = reolink();
    await expect(new ReolinkAdapter(http).getStorageStatus({ ...camera, protocol: "http", port: 80 })).rejects.toMatchObject({ code: "AUTH_METHOD_INSECURE" });
    expect(calls).toEqual([]);
  });

  it("reports a refused login", async () => {
    const { http } = reolink();
    await expect(new ReolinkAdapter(http).getStorageStatus({ ...camera, password: "wrong" })).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("marks an unformatted or unmounted card, and skips nothing silently", () => {
    const r = parseReolinkStorage({ HddInfo: [{ capacity: 1000, format: 0, id: 0, mount: 0, size: 0 }, { capacity: 1000, format: 1, id: 1, mount: 0, size: 1000, storageType: 1 }] });
    expect(r.devices.map((d) => [d.name, d.healthStatus, d.rawStatus])).toEqual([["Storage 1", "unhealthy", "unformatted"], ["HDD 2", "unhealthy", "not mounted"]]);
    expect(parseReolinkStorage({ HddInfo: [] }).devices).toEqual([]);
  });

  it("reads an NVR's channels (numbered from 0 by the NVR)", () => {
    expect(parseReolinkChannels({ status: [{ channel: 1, name: "Yard", online: 0 }, { channel: 0, name: "Gate", online: 1 }] })).toEqual([
      { channel: 1, name: "Gate", online: true },
      { channel: 2, name: "Yard", online: false },
    ]);
  });

  it("knows brands sold on other brands' firmware", () => {
    const registry = createRegistry();
    expect(["HiLook", "HiWatch", "Annke", "LTS"].map((b) => registry.resolveKey(b))).toEqual(["hikvision", "hikvision", "hikvision", "hikvision"]);
    expect(["Lorex", "IC Realtime", "Imou"].map((b) => registry.resolveKey(b))).toEqual(["dahua", "dahua", "dahua"]);
    expect(["Vivotek", "TP-Link VIGI", "Milesight", "Matrix COMSEC", "Sony"].map((b) => registry.resolveKey(b))).toEqual(["vivotek", "tplink-vigi", "milesight", "matrix", "onvif"]);
    expect(registry.resolveKey("Reolink")).toBe("reolink");
  });
});
