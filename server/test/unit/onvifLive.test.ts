import { describe, expect, it } from "vitest";
import { OnvifAdapter } from "../../src/integrations/onvif/adapter.js";
import { parseOnvifMediaUri, parseOnvifProfileToken } from "../../src/integrations/onvif/parser.js";
import type { CameraHttpClient, CameraRequest } from "../../src/integrations/http/cameraHttpClient.js";
import type { CameraConfig } from "../../src/integrations/types.js";
import { MOCK_PICTURE } from "../../src/testing/mockPicture.js";
import { withCredentials } from "../../src/services/liveVideoService.js";

const envelope = (body: string) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>${body}</s:Body></s:Envelope>`;
const profiles = envelope(`<trt:GetProfilesResponse xmlns:trt="x" xmlns:tt="y">
  <trt:Profiles token="Profile_1"><tt:Name>main</tt:Name><tt:VideoEncoderConfiguration><tt:Encoding>H265</tt:Encoding></tt:VideoEncoderConfiguration></trt:Profiles>
  <trt:Profiles token="Profile_2"><tt:Name>sub</tt:Name><tt:VideoEncoderConfiguration><tt:Encoding>H264</tt:Encoding></tt:VideoEncoderConfiguration></trt:Profiles>
</trt:GetProfilesResponse>`);
const camera: CameraConfig = { host: "10.0.0.5", port: 80, protocol: "http", username: "admin", password: "p@ss word", timeoutMs: 5000 };

describe("ONVIF live view", () => {
  it("picks the H.264 profile and reads media addresses", () => {
    expect(parseOnvifProfileToken(profiles)).toBe("Profile_2");
    expect(parseOnvifMediaUri(envelope(`<trt:GetStreamUriResponse xmlns:trt="x"><trt:MediaUri><tt:Uri xmlns:tt="y">rtsp://10.0.0.5:554/stream2</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>`), "GetStreamUriResponse"))
      .toBe("rtsp://10.0.0.5:554/stream2");
  });

  it("adds the stored credentials and keeps the stream on the camera's own address", () => {
    expect(withCredentials("rtsp://192.168.99.9:8554/Streaming/Channels/102?transportmode=unicast", camera))
      .toBe("rtsp://admin:p%40ss%20word@10.0.0.5:8554/Streaming/Channels/102?transportmode=unicast");
    expect(() => withCredentials("http://10.0.0.5/stream", camera)).toThrow(/not an RTSP address/);
  });

  it("fetches the snapshot from the camera's own host, on the port the camera names", async () => {
    const calls: { cfg: CameraConfig; req: CameraRequest }[] = [];
    const http = {
      request: async (cfg: CameraConfig, req: CameraRequest) => {
        calls.push({ cfg, req });
        if (req.body?.includes("GetServices")) return { status: 200, headers: {}, body: envelope("<tds:GetServicesResponse xmlns:tds='x'/>") };
        if (req.body?.includes("GetProfiles")) return { status: 200, headers: {}, body: profiles };
        if (req.body?.includes("GetSnapshotUri")) {
          return { status: 200, headers: {}, body: envelope(`<trt:GetSnapshotUriResponse xmlns:trt="x"><trt:MediaUri><tt:Uri xmlns:tt="y">http://evil.example:8080/snap.jpg?ch=2</tt:Uri></trt:MediaUri></trt:GetSnapshotUriResponse>`) };
        }
        return { status: 200, headers: { "content-type": "image/jpeg" }, body: "", raw: MOCK_PICTURE };
      },
    } as unknown as CameraHttpClient;
    const shot = await new OnvifAdapter(http).getSnapshot(camera);
    expect(shot.contentType).toBe("image/jpeg");
    const last = calls.at(-1)!;
    expect([last.cfg.host, last.cfg.port, last.req.path]).toEqual(["10.0.0.5", 8080, "/snap.jpg?ch=2"]);
    expect(calls.find((c) => c.req.body?.includes("GetSnapshotUri"))!.req.body).toContain("<trt:ProfileToken>Profile_2</trt:ProfileToken>");
  });
});
