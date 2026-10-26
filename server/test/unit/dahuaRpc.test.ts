import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DahuaAdapter } from "../../src/integrations/dahua/adapter.js";
import { DahuaRpc, parseRpcStorage, rpcPasswordHash } from "../../src/integrations/dahua/rpc.js";
import type { CameraHttpClient, CameraRequest } from "../../src/integrations/http/cameraHttpClient.js";
import type { CameraConfig } from "../../src/integrations/types.js";

const md5 = (s: string) => createHash("md5").update(s).digest("hex").toUpperCase();
const camera: CameraConfig = { host: "10.251.130.50", port: 443, protocol: "https", username: "admin", password: "Cp-Pass-123", timeoutMs: 5000 };

/** Like a CP Plus CP-UNC-TC81ZL6C-VMD-LQ: /cgi-bin is 404, the web page's RPC API is /cpapi2. */
function cpPlus(needsObject = false, web5 = false) {
  let pages = 0;
  const calls: { path: string; body: Record<string, unknown>; contentType?: string }[] = [];
  const http = {
    request: async (_cfg: CameraConfig, req: CameraRequest) => {
      const body = req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {};
      if (req.path === "/") pages++;
      else calls.push({ path: req.path, body, contentType: req.contentType });
      // The web page hands out a cookie; Web5.0 firmware refuses a login without it.
      if (req.path === "/") return { status: 200, headers: { "set-cookie": ["WebClientHttpsSessionID=PAGE1; path=/; HttpOnly"] }, body: "<html></html>" };
      if (web5 && req.path === "/cpapi2_Login" && !String(req.cookie).includes("WebClientHttpsSessionID=PAGE1")) return { status: 400, headers: {}, body: "" };
      // Web5.0 firmware: every request carries the SHA-256 of its body as ETag.
      if (web5 && req.path.startsWith("/cpapi2") && req.headers?.ETag !== createHash("sha256").update(req.body!).digest("hex")) return { status: 400, headers: {}, body: "" };
      // Web5.0 firmware: only user.signin logs in; global.login is a bad request.
      if (web5 && req.path === "/cpapi2_Login" && body.method !== "user.signin") return { status: 400, headers: {}, body: "" };
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
  return { http, calls, pages: () => pages };
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

  it("logs in with user.signin (Web5.0) when the camera refuses global.login (HTTP 400)", async () => {
    const { http, calls, pages } = cpPlus(false, true);
    const adapter = new DahuaAdapter(http);
    expect((await adapter.getStorageStatus(camera)).devices).toHaveLength(1);
    await adapter.getDeviceInfo(camera);
    const logins = calls.filter((c) => c.path === "/cpapi2_Login").map((c) => [c.body.method, (c.body.params as { clientType: string }).clientType]);
    // global.login is tried once; user.signin is then used for both logins.
    expect(logins).toEqual([
      ["global.login", "Web3.0"], ["user.signin", "Web5.0"], ["user.signin", "Web5.0"],
      ["user.signin", "Web5.0"], ["user.signin", "Web5.0"],
    ]);
    // The second step sends the challenge back, as the CP Plus page does.
    expect(calls.find((c) => c.body.method === "user.signin" && c.body.session)?.body.params).toMatchObject({ clientType: "Web5.0", realm: "Login to CP", random: "R123", passwordType: "Default", authorityType: "Default" });
    // The page is opened before each login for its cookie (also before /RPC2, which this camera lacks).
    expect(pages()).toBe(3);
  });

  it("reports a refused login", async () => {
    const { http } = cpPlus();
    await expect(new DahuaAdapter(http).getStorageStatus({ ...camera, password: "wrong" })).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("logs in with the challenge a CP Plus camera sends", async () => {
    // As captured from a CP-UNC-TC81ZL6C-VMD-LQ (authorityType and qop are lists; random is negative).
    const challenge = { error: { code: 268632079, message: "Component error: login challenge!" }, id: 8, params: { authorityType: ["Default"], authorization: "", encryption: "Default", opaque: "206da593220355afcb40abf239824edd", qop: ["auth"], random: "-620111643", realm: "Login to 29f1fc5f4a16e81104f1ef6aa431f36d" }, result: false, session: "11eff635868cd7ddf4632556afe073d2" };
    let second: Record<string, unknown> | undefined;
    const http = {
      request: async (_c: CameraConfig, req: CameraRequest) => {
        const body = JSON.parse(req.body!) as Record<string, unknown>;
        if ((body.params as { password?: string }).password === "") return { status: 200, headers: {}, body: JSON.stringify(challenge) };
        second = body;
        return { status: 200, headers: {}, body: JSON.stringify({ id: body.id, result: true, session: challenge.session, params: { keepAliveInterval: 60 } }) };
      },
    } as unknown as CameraHttpClient;
    expect(await new DahuaRpc(http).login(camera, "/cpapi2")).toBe(challenge.session);
    expect(second).toMatchObject({
      method: "global.login",
      session: challenge.session,
      params: { userName: "admin", clientType: "Web3.0", loginType: "Direct", authorityType: "Default", passwordType: "Default", password: md5(`admin:-620111643:${md5("admin:Login to 29f1fc5f4a16e81104f1ef6aa431f36d:Cp-Pass-123")}`) },
    });
  });

  it("marks a disk reporting an error as unhealthy", () => {
    expect(parseRpcStorage({ info: [{ Name: "/dev/sda", State: "Success", Detail: [{ TotalBytes: 100, UsedBytes: 50, IsError: true, Type: "ReadWrite" }] }] }).devices[0])
      .toMatchObject({ healthStatus: "unhealthy", usedPercentage: 50 });
  });
});
