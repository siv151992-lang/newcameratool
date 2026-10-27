import { describe, expect, it } from "vitest";
import { BoschAdapter } from "../../src/integrations/bosch/adapter.js";
import type { CameraHttpClient, CameraRequest } from "../../src/integrations/http/cameraHttpClient.js";
import { ONVIF_DEVICE_SERVICE_PATH } from "../../src/integrations/onvif/adapter.js";
import { createRegistry } from "../../src/integrations/registry.js";
import type { CameraConfig } from "../../src/integrations/types.js";

const camera: CameraConfig = { host: "10.0.0.30", port: 80, protocol: "http", username: "service", password: "pw", timeoutMs: 5000 };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function fake(snapStatus: number) {
  const paths: string[] = [];
  const http = {
    request: async (_c: CameraConfig, req: CameraRequest) => {
      paths.push(req.path);
      if (req.path.startsWith("/snap.jpg")) return { status: snapStatus, headers: {}, body: "", raw: snapStatus === 200 ? JPEG : Buffer.alloc(0) };
      // Anything else (ONVIF SOAP): a fault, enough to see where the adapter went.
      return { status: 500, headers: {}, body: "<s:Envelope><s:Body><s:Fault><s:Reason><s:Text>not here</s:Text></s:Reason></s:Fault></s:Body></s:Envelope>" };
    },
  } as unknown as CameraHttpClient;
  return { http, paths };
}

describe("Bosch", () => {
  it("takes the picture from Bosch's snapshot address", async () => {
    const { http, paths } = fake(200);
    const picture = await new BoschAdapter(http).getSnapshot(camera);
    expect(picture.contentType).toBe("image/jpeg");
    expect(paths).toEqual(["/snap.jpg?JpegSize=M"]);
  });

  it("falls back to ONVIF's picture on models without it", async () => {
    const { http, paths } = fake(404);
    await new BoschAdapter(http).getSnapshot(camera).catch(() => undefined);
    expect(paths[0]).toBe("/snap.jpg?JpegSize=M");
    expect(paths.slice(1).every((p) => p.startsWith("/onvif/"))).toBe(true);
    expect(paths.length).toBeGreaterThan(1);
  });

  it("reads storage over ONVIF, and is its own brand", async () => {
    const { http, paths } = fake(200);
    await new BoschAdapter(http).getStorageStatus(camera).catch(() => undefined);
    expect(paths[0]).toBe(ONVIF_DEVICE_SERVICE_PATH);
    const registry = createRegistry();
    expect(registry.resolveKey("Bosch")).toBe("bosch");
    expect(registry.resolveKey("Bosch Security")).toBe("bosch");
    expect(registry.get("bosch").meta).toMatchObject({ displayName: "Bosch", supportStatus: "unverified" });
  });
});
