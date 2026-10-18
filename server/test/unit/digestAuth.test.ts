import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HikvisionAdapter } from "../../src/integrations/hikvision/adapter.js";
import { CameraHttpClient, digestAuthorization, parseChallenge } from "../../src/integrations/http/cameraHttpClient.js";
import { CameraApiError, type CameraConfig } from "../../src/integrations/types.js";
import { HostGuard } from "../../src/security/hostGuard.js";
import { MockHikvisionCamera } from "../../src/testing/mockHikvision.js";

describe("digestAuthorization", () => {
  it("matches the RFC 2617 reference vector", () => {
    const header = digestAuthorization(
      { realm: "testrealm@host.com", qop: "auth,auth-int", nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque: "5ccc069c403ebaf9f0171e9517f40e41" },
      "Mufasa",
      "Circle Of Life",
      "GET",
      "/dir/index.html",
      "0a4f113b",
      "00000001",
    );
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain("qop=auth");
    expect(header).toContain('opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    expect(header).not.toContain("Circle Of Life");
  });

  it("supports SHA-256", () => {
    const header = digestAuthorization({ realm: "r", nonce: "n", qop: "auth", algorithm: "SHA-256" }, "u", "p", "GET", "/", "c");
    expect(header).toMatch(/algorithm=SHA-256/);
    expect(header).toMatch(/response="[0-9a-f]{64}"/);
  });

  it("parses challenges with quoted commas", () => {
    expect(parseChallenge('Digest realm="IP, Camera", nonce="abc", qop="auth", stale=FALSE')).toEqual({
      realm: "IP, Camera", nonce: "abc", qop: "auth", stale: "FALSE",
    });
  });
});

describe("CameraHttpClient + HikvisionAdapter against a simulated camera", () => {
  const cam = new MockHikvisionCamera("admin", "S3cret-pass");
  const guard = new HostGuard({ allowedNetworks: "10.0.0.0/8", allowLoopback: true });
  const adapter = new HikvisionAdapter(new CameraHttpClient(guard));
  let config: CameraConfig;

  beforeAll(async () => {
    const port = await cam.start();
    config = { host: "127.0.0.1", port, protocol: "http", username: "admin", password: "S3cret-pass", timeoutMs: 1500 };
  });
  afterAll(() => cam.stop());
  beforeEach(() => {
    cam.mode = "ok";
    cam.requests = [];
  });

  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return "none";
    } catch (e) {
      return (e as CameraApiError).code;
    }
  };

  it("authenticates with digest and retrieves storage", async () => {
    const r = await adapter.getStorageStatus(config);
    expect(r.usedPercentage).toBe(53.78);
    expect(cam.requests.map((x) => x.authorized)).toEqual([false, true]);
  });

  it("reports wrong passwords as AUTH_FAILED", async () => {
    expect(await codeOf(adapter.getStorageStatus({ ...config, password: "wrong" }))).toBe("AUTH_FAILED");
  });

  it("refuses to send Basic credentials over plain HTTP", async () => {
    cam.mode = "basic-only";
    expect(await codeOf(adapter.getStorageStatus(config))).toBe("AUTH_METHOD_INSECURE");
  });

  it("classifies a missing endpoint as API_UNAVAILABLE", async () => {
    cam.mode = "not-found";
    expect(await codeOf(adapter.getStorageStatus(config))).toBe("API_UNAVAILABLE");
  });

  it("classifies server errors as transient API_ERROR", async () => {
    cam.mode = "server-error";
    await expect(adapter.getStorageStatus(config)).rejects.toMatchObject({ code: "API_ERROR", transient: true });
  });

  it("classifies malformed bodies as INVALID_RESPONSE", async () => {
    cam.mode = "garbage";
    expect(await codeOf(adapter.getStorageStatus(config))).toBe("INVALID_RESPONSE");
  });

  it("times out on unresponsive devices", async () => {
    cam.mode = "hang";
    const started = Date.now();
    await expect(adapter.getStorageStatus({ ...config, timeoutMs: 1000 })).rejects.toMatchObject({ code: "TIMEOUT", transient: true });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("classifies refused connections as UNREACHABLE", async () => {
    expect(await codeOf(adapter.getStorageStatus({ ...config, port: 1 }))).toBe("UNREACHABLE");
  });

  it("refuses hosts outside the allowed networks before connecting", async () => {
    const strict = new HikvisionAdapter(new CameraHttpClient(new HostGuard({ allowedNetworks: "10.0.0.0/8" })));
    expect(await codeOf(strict.getStorageStatus(config))).toBe("HOST_NOT_ALLOWED");
    expect(await codeOf(strict.getStorageStatus({ ...config, host: "169.254.169.254" }))).toBe("HOST_NOT_ALLOWED");
  });

  it("produces step-by-step diagnostics", async () => {
    const ok = await adapter.testConnection(config);
    expect(ok.ok).toBe(true);
    expect(ok.steps.map((s) => [s.key, s.status])).toEqual([
      ["reachability", "passed"], ["authentication", "passed"], ["api", "passed"], ["storage", "passed"],
    ]);
    expect(ok.deviceInfo?.model).toBe("SIMULATED-HIKVISION");

    const bad = await adapter.testConnection({ ...config, password: "nope" });
    expect(bad.reachable).toBe(true);
    expect(bad.steps.find((s) => s.key === "authentication")?.status).toBe("failed");
    expect(bad.error?.code).toBe("AUTH_FAILED");

    const down = await adapter.testConnection({ ...config, port: 1 });
    expect(down.reachable).toBe(false);
    expect(down.steps.map((s) => s.status)).toEqual(["failed", "skipped", "skipped", "skipped"]);
  });
});
