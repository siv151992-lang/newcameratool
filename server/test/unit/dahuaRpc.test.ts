import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DahuaAdapter } from "../../src/integrations/dahua/adapter.js";
import { parseRpcStorage, rpcPasswordHash } from "../../src/integrations/dahua/rpc.js";
import type { CameraHttpClient, CameraRequest } from "../../src/integrations/http/cameraHttpClient.js";
import type { CameraConfig } from "../../src/integrations/types.js";

const md5 = (s: string) => createHash("md5").update(s).digest("hex").toUpperCase();
const camera: CameraConfig = { host: "10.251.130.50", port: 443, protocol: "https", username: "admin", password: "Cp-Pass-123", timeoutMs: 5000 };

/** Like a CP Plus CP-UNC-TC81ZL6C-VMD-LQ: /cgi-bin is 404, the web page's RPC API is /cpapi2. */
function cpPlus(needsObject = false) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const http = {
    request: async (_cfg: CameraConfig, req: CameraRequest) => {
      const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
      calls.push({ path: req.path, body });
      const json = (o: object) => ({ status: 200, headers: {}, body: JSON.stringify({ id: body.id, ...o }) });
      if (req.path === "/cpapi2_Login") {
        const p = body.params as Record<string, string>;
        if (!p.password) return json({ result: false, session: "S1", params: { encryption: "Default", realm: "Login to CP", random: "R123" }, error: { code: 268632079, message: "" } });
        const ok = p.password === md5(`admin:R123:${md5("admin:Login to CP:Cp-Pass-123")}`);
        return json(ok ? { result: true, session: "S1", params: { keepAliveInterval: 60 } } : { result: false, error: { code: 268632085, message: "UserNotValidt" } });
      }
      if (req.path === "/cpapi2") {
        if (body.session !== "S1") return json({ result: false, error: { code: 287637505, message: "Invalid session" } });
        if (body.method === "storage.factory.instance") return json({ result: 7 });
        if (body.method === "storage.destroy") return json({ result: true });
        if (body.method === "storage.getDeviceAllInfo") {
          if (needsObject && body.object !== 7) return json({ result: false, error: { code: 268959743, message: "" } });
          return json({ result: true, params: { info: [{ Name: "/dev/mmc0", State: "Success", Detail: [{ Path: "/mnt/sd", Type: "ReadWrite", TotalBytes: 255_870_000_000, UsedBytes: 0, IsError: false }] }] } });
        }
        if (body.method === "magicBox.getSystemInfo") return json({ result: true, params: { deviceType: "CP-UNC-TC81ZL6C-VMD-LQ", serialNumber: "CP0001" } });
        if (body.method === "magicBox.getSoftwareVersion") return json({ result: true, params: { version: { Version: "3.120.00HD001.0.R" } } });
        return json({ result: true, params: null });
      }
      return { status: 404, headers: {}, body: "" };
    },
  } as unknown as CameraHttpClient;
  return { http, calls };
}

describe("Dahua RPC API (RPC2 / CP Plus cpapi2)", () => {
  it("hashes the password the way the camera asks", () => {
    expect(rpcPasswordHash("Default", "admin", "pw", "realm", "123")).toBe(md5(`admin:123:${md5("admin:realm:pw")}`));
    expect(rpcPasswordHash("Basic", "admin", "pw", "", "")).toBe(Buffer.from("admin:pw").toString("base64"));
    expect(() => rpcPasswordHash("WSSE", "a", "b", "", "")).toThrow(/does not support/);
  });

  it("reads storage and device information through /cpapi2 when CGI is off, logging in and out", async () => {
    const { http, calls } = cpPlus();
    const adapter = new DahuaAdapter(http);
    const storage = await adapter.getStorageStatus(camera);
    expect(storage.devices).toMatchObject([{ id: "/dev/mmc0", healthStatus: "healthy", totalBytes: 255_870_000_000, freeBytes: 255_870_000_000, writable: true }]);
    expect(await adapter.getDeviceInfo(camera)).toEqual({ model: "CP-UNC-TC81ZL6C-VMD-LQ", deviceName: "CP-UNC-TC81ZL6C-VMD-LQ", serialNumber: "CP0001", firmwareVersion: "3.120.00HD001.0.R" });
    // The password itself is never sent; the session is closed afterwards.
    expect(JSON.stringify(calls)).not.toContain("Cp-Pass-123");
    expect(calls.filter((c) => c.body.method === "global.logout")).toHaveLength(2);
    // CGI is tried once; the camera is then known to use /cpapi2.
    expect(calls.filter((c) => c.path.startsWith("/cgi-bin/"))).toHaveLength(1);
  });

  it("reads the disks through a storage object when the camera wants one", async () => {
    const { http, calls } = cpPlus(true);
    const storage = await new DahuaAdapter(http).getStorageStatus(camera);
    expect(storage.devices).toHaveLength(1);
    expect(calls.map((c) => c.body.method).filter((m) => String(m).startsWith("storage."))).toEqual([
      "storage.getDeviceAllInfo", "storage.factory.instance", "storage.getDeviceAllInfo", "storage.destroy",
    ]);
  });

  it("reports a refused login", async () => {
    const { http } = cpPlus();
    await expect(new DahuaAdapter(http).getStorageStatus({ ...camera, password: "wrong" })).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("marks a disk reporting an error as unhealthy", () => {
    expect(parseRpcStorage({ info: [{ Name: "/dev/sda", State: "Success", Detail: [{ TotalBytes: 100, UsedBytes: 50, IsError: true, Type: "ReadWrite" }] }] }).devices[0])
      .toMatchObject({ healthStatus: "unhealthy", usedPercentage: 50 });
  });
});
