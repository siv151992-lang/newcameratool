import { describe, expect, it } from "vitest";
import { HttpApiAdapter, json } from "../../src/integrations/common/httpApiAdapter.js";
import type { CameraHttpClient, CameraRequest } from "../../src/integrations/http/cameraHttpClient.js";
import { aggregate } from "../../src/integrations/storageMath.js";
import { CameraApiError, type BrandMeta, type CameraConfig } from "../../src/integrations/types.js";

/** A brand as the guide writes one: meta, the storage request, a picture address and its error answers. */
class AcmeAdapter extends HttpApiAdapter {
  readonly meta: BrandMeta = {
    key: "acme", displayName: "Acme", supportStatus: "unverified", authMethods: ["digest"], defaultPorts: { http: 80, https: 443 },
    capabilities: ["storage-status", "connection-test"], notes: "Example brand.",
  };
  protected readonly storage = {
    path: "/api/v1/storage",
    parse: (body: string) => {
      const j = json<{ disks: { id: string; totalMB: number; freeMB: number }[] }>(body, "storage answer");
      return aggregate(j.disks.map((d) => ({ id: d.id, healthStatus: "healthy" as const, totalBytes: d.totalMB * 1048576, freeBytes: d.freeMB * 1048576 })));
    },
  };
  protected readonly snapshotPath = (channel = 1) => `/api/v1/picture?ch=${channel}`;
  protected override describeError(body: string) {
    return /bad password/.test(body) ? new CameraApiError("AUTH_FAILED", "The camera refused the login") : undefined;
  }
}

const camera: CameraConfig = { host: "10.0.0.40", port: 80, protocol: "http", username: "admin", password: "pw", timeoutMs: 5000 };
function fake(answer: (path: string) => { status: number; body?: string; raw?: Buffer }) {
  const paths: string[] = [];
  const http = { request: async (_c: CameraConfig, r: CameraRequest) => (paths.push(r.path), { headers: {}, body: "", ...answer(r.path) }) } as unknown as CameraHttpClient;
  return { http, paths };
}

describe("HttpApiAdapter (common base for plain HTTP APIs)", () => {
  it("reads storage with the brand's request and parser", async () => {
    const { http } = fake(() => ({ status: 200, body: JSON.stringify({ disks: [{ id: "sd", totalMB: 100, freeMB: 25 }] }) }));
    const r = await new AcmeAdapter(http).getStorageStatus(camera);
    expect(r.usedPercentage).toBe(75);
  });

  it("turns the brand's own error answers and a missing API into clear errors", async () => {
    await expect(new AcmeAdapter(fake(() => ({ status: 401, body: "bad password" })).http).getStorageStatus(camera)).rejects.toMatchObject({ code: "AUTH_FAILED" });
    await expect(new AcmeAdapter(fake(() => ({ status: 404 })).http).getStorageStatus(camera)).rejects.toMatchObject({ code: "API_UNAVAILABLE" });
    await expect(new AcmeAdapter(fake(() => ({ status: 200, body: "<html>" })).http).getStorageStatus(camera)).rejects.toMatchObject({ code: "INVALID_RESPONSE", message: "The camera's storage answer is not JSON" });
  });

  it("uses the brand's picture address, and ONVIF for what the brand does not declare", async () => {
    const { http, paths } = fake((p) => (p.startsWith("/api/v1/picture") ? { status: 200, raw: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) } : { status: 500, body: "" }));
    const acme = new AcmeAdapter(http);
    expect((await acme.getSnapshot(camera, 2)).contentType).toBe("image/jpeg");
    expect(paths).toEqual(["/api/v1/picture?ch=2"]);
    await acme.getDeviceInfo(camera).catch(() => undefined);
    expect(paths.at(-1)).toBe("/onvif/device_service");
  });
});
