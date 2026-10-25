import net from "node:net";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OnvifAdapter } from "../../src/integrations/onvif/adapter.js";
import { parseOnvifRecordingResults, parseOnvifSearchToken } from "../../src/integrations/onvif/parser.js";
import type { CameraHttpClient, CameraRequest } from "../../src/integrations/http/cameraHttpClient.js";
import type { CameraConfig } from "../../src/integrations/types.js";
import { clockTime, readRtsp, registerReplay, startReplayRelay, stopReplayRelay } from "../../src/services/rtspReplayRelay.js";

const envelope = (body: string) => `<?xml version="1.0"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Body>${body}</s:Body></s:Envelope>`;
const results = (state: string, ...recs: [string, string, string][]) =>
  envelope(`<tse:GetRecordingSearchResultsResponse xmlns:tse="a" xmlns:tt="b"><tse:ResultList><tt:SearchState>${state}</tt:SearchState>${recs
    .map(([t, f, u]) => `<tt:RecordingInformation><tt:RecordingToken>${t}</tt:RecordingToken><tt:EarliestRecording>${f}</tt:EarliestRecording><tt:LatestRecording>${u}</tt:LatestRecording></tt:RecordingInformation>`)
    .join("")}</tse:ResultList></tse:GetRecordingSearchResultsResponse>`);
const camera: CameraConfig = { host: "10.0.0.5", port: 80, protocol: "http", username: "admin", password: "secret", timeoutMs: 5000 };

describe("ONVIF recordings (Profile G)", () => {
  it("reads the search token and the recordings found", () => {
    expect(parseOnvifSearchToken(envelope(`<tse:FindRecordingsResponse xmlns:tse="a"><tse:SearchToken>S1</tse:SearchToken></tse:FindRecordingsResponse>`))).toBe("S1");
    const page = parseOnvifRecordingResults(results("Completed", ["Rec1", "2026-10-24T01:00:00Z", "2026-10-24T05:30:00Z"], ["Rec2", "2026-10-24T06:00:00", "2026-10-24T06:00:00"]));
    expect(page.done).toBe(true);
    expect(page.recordings).toEqual([{ token: "Rec1", from: Date.parse("2026-10-24T01:00:00Z"), until: Date.parse("2026-10-24T05:30:00Z") }]);
    expect(parseOnvifRecordingResults(results("Searching")).done).toBe(false);
  });

  it("lists recordings in the camera's local time and asks for the replay address", async () => {
    const bodies: string[] = [];
    const http = {
      request: async (_cfg: CameraConfig, req: CameraRequest) => {
        const b = req.body ?? "";
        bodies.push(b);
        const reply = (x: string) => ({ status: 200, headers: {}, body: envelope(x) });
        if (b.includes("GetServices")) return reply("<tds:GetServicesResponse xmlns:tds='x'/>");
        if (b.includes("FindRecordings")) return reply(`<tse:FindRecordingsResponse xmlns:tse="a"><tse:SearchToken>S1</tse:SearchToken></tse:FindRecordingsResponse>`);
        if (b.includes("GetRecordingSearchResults")) return { status: 200, headers: {}, body: results("Completed", ["Rec1", "2026-10-24T01:00:00Z", "2026-10-24T05:30:00Z"]) };
        if (b.includes("EndSearch")) return reply(`<tse:EndSearchResponse xmlns:tse="a"/>`);
        if (b.includes("GetSystemDateAndTime")) {
          return reply(`<tds:GetSystemDateAndTimeResponse xmlns:tds="x" xmlns:tt="y"><tds:SystemDateAndTime><tt:TimeZone><tt:TZ>IST-5:30</tt:TZ></tt:TimeZone>
            <tt:UTCDateTime><tt:Date><tt:Year>2026</tt:Year><tt:Month>10</tt:Month><tt:Day>24</tt:Day></tt:Date><tt:Time><tt:Hour>5</tt:Hour><tt:Minute>0</tt:Minute><tt:Second>0</tt:Second></tt:Time></tt:UTCDateTime>
            <tt:LocalDateTime><tt:Date><tt:Year>2026</tt:Year><tt:Month>10</tt:Month><tt:Day>24</tt:Day></tt:Date><tt:Time><tt:Hour>10</tt:Hour><tt:Minute>30</tt:Minute><tt:Second>0</tt:Second></tt:Time></tt:LocalDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`);
        }
        if (b.includes("GetReplayUri")) return reply(`<trp:GetReplayUriResponse xmlns:trp="r"><trp:Uri>rtsp://192.168.1.99/onvif-media/record/Rec1</trp:Uri></trp:GetReplayUriResponse>`);
        return { status: 500, headers: {}, body: "" };
      },
    } as unknown as CameraHttpClient;
    const adapter = new OnvifAdapter(http);
    const list = await adapter.listRecordings(camera);
    expect(list.shiftMs).toBe(330 * 60_000);
    // Up to the camera's clock (05:00 UTC), shown at local time.
    expect(list.segments).toEqual([{ start: Date.parse("2026-10-24T06:30:00Z"), end: Date.parse("2026-10-24T10:30:00Z"), ref: "Rec1" }]);
    expect(bodies.some((b) => b.includes("EndSearch"))).toBe(true);
    expect(await adapter.replayRtspUrl(camera, list.segments[0])).toBe("rtsp://192.168.1.99/onvif-media/record/Rec1");
    expect(bodies.at(-1)).toContain("<trp:RecordingToken>Rec1</trp:RecordingToken>");
  });
});

/** A replay server that insists on digest login, Require: onvif-replay and a clock Range. */
function fakeReplayCamera() {
  const options = { refuseScale: false };
  const requests: { first: string; headers: Record<string, string> }[] = [];
  const md5 = (s: string) => createHash("md5").update(s).digest("hex");
  const server = net.createServer((socket) => {
    let buf: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = readRtsp(Buffer.concat([buf, chunk]), (m) => {
        const headers = Object.fromEntries(m.headers.map(([k, v]) => [k.toLowerCase(), v]));
        requests.push({ first: m.first, headers });
        const [method, uri] = m.first.split(" ");
        const send = (status: string, extra: string[] = [], body = "") =>
          socket.write([`RTSP/1.0 ${status}`, `CSeq: ${headers.cseq}`, ...extra, ...(body ? [`Content-Length: ${Buffer.byteLength(body)}`] : []), "", body].join("\r\n"));
        const auth = /response="([^"]+)"/.exec(headers.authorization ?? "")?.[1];
        const digestUri = /uri="([^"]+)"/.exec(headers.authorization ?? "")?.[1];
        const expected = md5(`${md5("admin:cam:secret")}:n0nce:${md5(`${method}:${digestUri}`)}`);
        if (method !== "OPTIONS" && (auth !== expected || digestUri !== uri)) return send("401 Unauthorized", ['WWW-Authenticate: Digest realm="cam", nonce="n0nce"']);
        if (method === "OPTIONS") return send("200 OK", ["Public: DESCRIBE, SETUP, PLAY, TEARDOWN"]);
        const onvif = uri!.includes("/onvif-media");
        if (onvif && headers.require !== "onvif-replay") return send("551 Option not supported");
        if (method === "DESCRIBE") {
          const sdp = "v=0\r\ns=replay\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:rtsp://192.168.1.99/onvif-media/record/Rec1/track1\r\n";
          return send("200 OK", ["Content-Type: application/sdp", "Content-Base: rtsp://192.168.1.99/onvif-media/record/Rec1/"], sdp);
        }
        if (method === "SETUP") return send("200 OK", ["Session: 1234", "Transport: RTP/AVP/TCP;unicast;interleaved=0-1"]);
        if (method === "PLAY") {
          if (onvif && !/^clock=\d{8}T\d{6}Z-$/.test(headers.range ?? "")) return send("457 Invalid Range");
          if (headers.scale && options.refuseScale) return send("551 Option not supported");
          send("200 OK", ["Session: 1234", ...(headers.scale ? [`Scale: ${headers.scale}`] : [])]);
          socket.write(Buffer.from([0x24, 0, 0, 3, 1, 2, 3]));
          return;
        }
        send("200 OK");
      }, () => undefined);
    });
  });
  return { server, requests, options };
}

/** A minimal RTSP client, like go2rtc: sends requests one at a time and collects replies and data. */
function rtspClient(port: number) {
  const socket = net.connect(port, "127.0.0.1");
  let buf: Buffer = Buffer.alloc(0);
  const replies: { first: string; headers: Record<string, string> }[] = [];
  const frames: Buffer[] = [];
  let wake = () => {};
  socket.on("data", (c) => {
    buf = readRtsp(Buffer.concat([buf, c]), (m) => replies.push({ first: m.first, headers: Object.fromEntries(m.headers.map(([k, v]) => [k.toLowerCase(), v])) }), (f) => frames.push(Buffer.from(f)));
    wake();
  });
  const until = (ok: () => boolean) => new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), 3000);
    wake = () => void (ok() && (clearTimeout(t), resolve()));
    wake();
  });
  let cseq = 0;
  return {
    frames,
    until,
    close: () => socket.destroy(),
    request: async (method: string, uri: string, extra: string[] = []) => {
      const n = replies.length;
      socket.write([`${method} ${uri} RTSP/1.0`, `CSeq: ${++cseq}`, ...extra, "", ""].join("\r\n"));
      await until(() => replies.length > n);
      return replies.at(-1)!;
    },
  };
}

describe("Replay relay", () => {
  const cam = fakeReplayCamera();
  let relayPort = 0;
  let camPort = 0;
  beforeAll(async () => {
    const relay = await startReplayRelay(0, "127.0.0.1");
    relayPort = (relay.address() as net.AddressInfo).port;
    await new Promise<void>((r) => cam.server.listen(0, "127.0.0.1", r));
    camPort = (cam.server.address() as net.AddressInfo).port;
  });
  afterAll(async () => {
    await stopReplayRelay();
    cam.server.close();
  });

  it("formats the clock range", () => {
    expect(clockTime(Date.parse("2026-10-24T10:15:00.500Z"))).toBe("20261024T101500Z");
  });

  it("plays a recording from the chosen time, logging in and adding the replay headers", async () => {
    const start = Date.parse("2026-10-24T10:15:00Z");
    const url = registerReplay(`rtsp://127.0.0.1:${relayPort}`, "playback_x", { host: "127.0.0.1", port: camPort, path: "/onvif-media/record/Rec1", username: "admin", password: "secret", onvif: true, startUtcMs: start });
    expect(url).toMatch(new RegExp(`^rtsp://127.0.0.1:${relayPort}/r/[A-Za-z0-9_-]{24}/onvif-media/record/Rec1$`));
    const prefix = url.slice(0, url.indexOf("/onvif-media"));

    const socket = net.connect(relayPort, "127.0.0.1");
    let buf: Buffer = Buffer.alloc(0);
    const replies: { first: string; headers: Record<string, string>; body: string }[] = [];
    const frames: Buffer[] = [];
    let wake = () => {};
    socket.on("data", (c) => {
      buf = readRtsp(Buffer.concat([buf, c]), (m) => replies.push({ first: m.first, headers: Object.fromEntries(m.headers.map(([k, v]) => [k.toLowerCase(), v])), body: m.body.toString() }), (f) => frames.push(Buffer.from(f)));
      wake();
    });
    const until = (ok: () => boolean) => new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timed out")), 3000);
      wake = () => ok() && (clearTimeout(t), resolve());
      wake();
    });
    let cseq = 0;
    const request = async (method: string, uri: string, extra: string[] = []) => {
      const n = replies.length;
      socket.write([`${method} ${uri} RTSP/1.0`, `CSeq: ${++cseq}`, "User-Agent: go2rtc", ...extra, "", ""].join("\r\n"));
      await until(() => replies.length > n);
      return replies.at(-1)!;
    };

    expect((await request("OPTIONS", url)).first).toBe("RTSP/1.0 200 OK");
    const describe = await request("DESCRIBE", url, ["Accept: application/sdp"]);
    expect(describe.first).toBe("RTSP/1.0 200 OK");
    // The camera's addresses point back at the relay.
    expect(describe.headers["content-base"]).toBe(`${prefix}/onvif-media/record/Rec1/`);
    expect(describe.body).toContain(`a=control:${prefix}/onvif-media/record/Rec1/track1`);
    expect(Number(describe.headers["content-length"])).toBe(Buffer.byteLength(describe.body));
    expect((await request("SETUP", `${prefix}/onvif-media/record/Rec1/track1`, ["Transport: RTP/AVP/TCP;unicast;interleaved=0-1"])).first).toBe("RTSP/1.0 200 OK");
    expect((await request("PLAY", url, ["Session: 1234"])).first).toBe("RTSP/1.0 200 OK");
    await until(() => frames.length > 0);
    expect([...frames[0]!]).toEqual([0x24, 0, 0, 3, 1, 2, 3]);

    const play = cam.requests.filter((r) => r.first.startsWith("PLAY")).at(-1)!;
    expect(play.first).toBe(`PLAY rtsp://127.0.0.1:${camPort}/onvif-media/record/Rec1 RTSP/1.0`);
    expect(play.headers.range).toBe("clock=20261024T101500Z-");
    expect(play.headers.require).toBe("onvif-replay");
    expect(cam.requests.find((r) => r.first.startsWith("SETUP") && r.headers.authorization)!.first).toBe(`SETUP rtsp://127.0.0.1:${camPort}/onvif-media/record/Rec1/track1 RTSP/1.0`);
    socket.destroy();
  });

  it("plays faster for any brand by asking the camera (Scale), and at normal speed when it refuses", async () => {
    for (const refuse of [false, true]) {
      cam.options.refuseScale = refuse;
      cam.requests.length = 0;
      const url = registerReplay(`rtsp://127.0.0.1:${relayPort}`, `fast_${refuse}`, { host: "127.0.0.1", port: camPort, path: "/plain/track?start=1", username: "admin", password: "secret", onvif: false, scale: 4 });
      const c = rtspClient(relayPort);
      expect((await c.request("DESCRIBE", url)).first).toBe("RTSP/1.0 200 OK");
      expect((await c.request("SETUP", `${url}/track1`)).first).toBe("RTSP/1.0 200 OK");
      const play = await c.request("PLAY", url, ["Session: 1234"]);
      expect(play.first).toBe("RTSP/1.0 200 OK");
      expect(play.headers.scale).toBe(refuse ? undefined : "4.0");
      await c.until(() => c.frames.length > 0);
      const plays = cam.requests.filter((r) => r.first.startsWith("PLAY") && r.headers.authorization);
      expect(plays.map((r) => r.headers.scale)).toEqual(refuse ? ["4.0", undefined] : ["4.0"]);
      // Not ONVIF: no replay headers.
      expect(plays.every((r) => !r.headers.require && !r.headers.range)).toBe(true);
      c.close();
    }
  });

  it("refuses unknown playback addresses", async () => {
    const socket = net.connect(relayPort, "127.0.0.1");
    socket.write(`DESCRIBE rtsp://127.0.0.1:${relayPort}/r/${"A".repeat(24)}/x RTSP/1.0\r\nCSeq: 1\r\n\r\n`);
    const reply = await new Promise<string>((resolve) => socket.once("data", (d) => resolve(d.toString())));
    expect(reply).toMatch(/^RTSP\/1.0 404 Not Found\r\nCSeq: 1/);
    socket.destroy();
  });
});
