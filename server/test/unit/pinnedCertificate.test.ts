import { readFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CameraHttpClient } from "../../src/integrations/http/cameraHttpClient.js";
import type { CameraConfig } from "../../src/integrations/types.js";

const fixture = (f: string) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8");
const expired = { cert: fixture("camera-expired.pem"), key: fixture("camera-expired.key") };
const other = { cert: fixture("camera-self-signed.pem"), key: fixture("camera-self-signed.key") };

/** An HTTPS camera answering 200, counting the requests it received. */
function camera(tlsOptions: { cert: string; key: string }) {
  const seen: { authorization?: string }[] = [];
  const server = https.createServer(tlsOptions, (req, res) => {
    seen.push({ authorization: req.headers.authorization });
    res.end("ok");
  });
  return { server, seen, port: () => (server.address() as AddressInfo).port };
}

describe("a camera's own certificate, trusted for it", () => {
  const expiredCam = camera(expired);
  const otherCam = camera(other);
  const client = new CameraHttpClient({ resolve: async () => ({ address: "127.0.0.1", family: 4 }) } as never);
  const cfg = (port: number, caCertificate?: string): CameraConfig => ({ host: "10.251.130.50", port, protocol: "https", username: "admin", password: "pw", timeoutMs: 3000, caCertificate });
  beforeAll(async () => {
    await new Promise<void>((r) => expiredCam.server.listen(0, "127.0.0.1", r));
    await new Promise<void>((r) => otherCam.server.listen(0, "127.0.0.1", r));
  });
  afterAll(() => {
    expiredCam.server.close();
    otherCam.server.close();
  });

  it("is accepted although it has expired (CERT_HAS_EXPIRED)", async () => {
    const res = await client.request(cfg(expiredCam.port(), expired.cert), { path: "/x", auth: "none" });
    expect(res.status).toBe(200);
  });

  it("explains an expired certificate that is not trusted yet", async () => {
    await expect(client.request(cfg(expiredCam.port()), { path: "/x", auth: "none" })).rejects.toMatchObject({
      code: "TLS_ERROR",
      message: expect.stringMatching(/CERT_HAS_EXPIRED.*has expired.*Get the camera's certificate/),
    });
  });

  it("refuses any other certificate before sending the request or the login", async () => {
    await expect(client.request(cfg(otherCam.port(), expired.cert), { path: "/x", auth: { authorization: "Basic YWRtaW46cHc=" } })).rejects.toMatchObject({
      code: "TLS_ERROR",
      message: expect.stringContaining("different certificate from the one trusted"),
    });
    expect(otherCam.seen).toEqual([]);
  });
});
