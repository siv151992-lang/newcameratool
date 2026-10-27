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
      if (entry!.cmd === "GetDevInfo") return json({ code: 0, value: { DevInfo: { model: "RLC-811A", serial: "00000000001", firmVer: "v3.1.0.2368_23062700", name: "Gate" } } });
      return json({ code: 0, value: { rspCode: 200 } });
    },
  } as unknown as CameraHttpClient;
  return { http, calls };
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
    expect(["Bosch", "Vivotek", "TP-Link VIGI", "Milesight"].map((b) => registry.resolveKey(b))).toEqual(["onvif", "onvif", "onvif", "onvif"]);
    expect(registry.resolveKey("Reolink")).toBe("reolink");
  });
});
