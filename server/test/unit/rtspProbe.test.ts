import net from "node:net";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeReason, probeRtsp } from "../../src/services/rtspProbe.js";
import { readRtsp } from "../../src/services/rtspReplayRelay.js";

/** A camera that serves only /MediaInput/h264/stream_1, behind digest login. */
function fakeCamera() {
  const md5 = (s: string) => createHash("md5").update(s).digest("hex");
  return net.createServer((socket) => {
    let buf: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = readRtsp(Buffer.concat([buf, chunk]), (m) => {
        const h = Object.fromEntries(m.headers.map(([k, v]) => [k.toLowerCase(), v]));
        const [method, uri] = m.first.split(" ");
        const send = (status: string, extra: string[] = []) => socket.write([`RTSP/1.0 ${status}`, `CSeq: ${h.cseq}`, ...extra, "", ""].join("\r\n"));
        const response = /response="([^"]+)"/.exec(h.authorization ?? "")?.[1];
        const digestUri = /uri="([^"]+)"/.exec(h.authorization ?? "")?.[1];
        if (response !== md5(`${md5("admin:cam:secret")}:n1:${md5(`${method}:${digestUri}`)}`)) {
          return send("401 Unauthorized", ['WWW-Authenticate: Digest realm="cam", nonce="n1"']);
        }
        if (!uri!.endsWith("/MediaInput/h264/stream_1")) return send("404 Not Found");
        send("200 OK", ["Content-Type: application/sdp", "Content-Length: 0"]);
      }, () => undefined);
    });
  });
}

describe("RTSP probe", () => {
  const server = fakeCamera();
  let port = 0;
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(() => {
    server.close();
  });
  const probe = (path: string, password = "secret") => probeRtsp({ host: "127.0.0.1", port, path, username: "admin", password });

  it("logs in and tells which stream addresses the camera serves", async () => {
    expect(await probe("/MediaInput/h264/stream_1")).toBe(200);
    expect(await probe("/MediaInput/h264/stream_2")).toBe(404);
    expect(await probe("/MediaInput/h264/stream_1", "wrong")).toBe(401);
    expect(await probeRtsp({ host: "127.0.0.1", port: 1, path: "/x", username: "a", password: "b" }, 1000)).toBe(0);
  });

  it("explains each answer", () => {
    expect(probeReason(401)).toMatch(/refused the login/);
    expect(probeReason(404)).toMatch(/no stream at this address/);
    expect(probeReason(0)).toMatch(/did not answer/);
  });
});
