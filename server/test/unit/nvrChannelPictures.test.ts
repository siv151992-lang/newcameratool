import { describe, expect, it } from "vitest";
import type { CameraHttpClient, CameraRequest } from "../../src/integrations/http/cameraHttpClient.js";
import type { CameraConfig } from "../../src/integrations/types.js";
import { UniviewAdapter } from "../../src/integrations/uniview/adapter.js";

const camera: CameraConfig = { host: "10.0.0.9", port: 80, protocol: "http", username: "admin", password: "x", timeoutMs: 5000 };
function recorder() {
  const paths: string[] = [];
  const http = { request: async (_c: CameraConfig, r: CameraRequest) => (paths.push(r.path), { status: 200, headers: { "content-type": "image/jpeg" }, body: "", raw: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }) } as unknown as CameraHttpClient;
  return { http, paths };
}

describe("Uniview pictures", () => {
  it("asks for the camera's own channel 0, and an NVR's channel N as N (channel 1 included)", async () => {
    const { http, paths } = recorder();
    const uniview = new UniviewAdapter(http);
    await uniview.getSnapshot(camera).catch(() => undefined);
    await uniview.getSnapshot(camera, 1).catch(() => undefined);
    await uniview.getSnapshot(camera, 4).catch(() => undefined);
    expect(paths).toEqual([
      "/LAPI/V1.0/Channels/0/Media/Video/Streams/0/Snapshot",
      "/LAPI/V1.0/Channels/1/Media/Video/Streams/0/Snapshot",
      "/LAPI/V1.0/Channels/4/Media/Video/Streams/0/Snapshot",
    ]);
  });
});
