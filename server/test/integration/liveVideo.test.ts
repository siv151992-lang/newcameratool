import { createHash } from "node:crypto";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { config } from "../../src/config.js";
import { pool } from "../../src/db/pool.js";
import { attachLiveVideo } from "../../src/services/liveVideoProxy.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

/** Stands in for go2rtc: records registered streams and answers the WebSocket with one text frame. */
const go2rtc = { streams: new Map<string, string>(), wsPaths: [] as string[] };
const fake = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  if (url.pathname === "/api/streams" && req.method === "PUT") {
    go2rtc.streams.set(url.searchParams.get("name")!, url.searchParams.get("src")!);
    return res.end();
  }
  if (url.pathname === "/api/streams") return res.end(JSON.stringify(Object.fromEntries(go2rtc.streams)));
  res.statusCode = 404;
  res.end();
});
fake.on("upgrade", (req, socket) => {
  go2rtc.wsPaths.push(req.url!);
  const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const text = Buffer.from(JSON.stringify({ type: "mse", value: 'video/mp4; codecs="avc1.640029"' }));
  socket.end(Buffer.concat([Buffer.from([0x81, text.length]), text]));
});

const app = createApp();
const server = http.createServer(app);
attachLiveVideo(server);
let port: number;

/** Opens the WebSocket by hand and returns everything the server sent back. */
function upgrade(path: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1", () => {
      const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      s.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    let data = "";
    s.on("data", (c) => (data += c.toString("latin1")));
    s.on("close", () => resolve(data));
    s.setTimeout(3000, () => s.destroy());
  });
}

async function sessionCookie(role: "admin" | "viewer") {
  const { username } = await createTestUser(role, `${role}-live`);
  const res = await request(app).post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  return { cookie: String(res.headers["set-cookie"]).split(";")[0]!, csrf: res.body.csrfToken as string };
}

beforeAll(async () => {
  await prepareDb();
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  (config as { LIVE_VIDEO_URL?: string }).LIVE_VIDEO_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  (config as { LIVE_VIDEO_URL?: string }).LIVE_VIDEO_URL = undefined;
  server.close();
  fake.close();
});
beforeEach(async () => {
  await resetData();
  go2rtc.streams.clear();
  go2rtc.wsPaths = [];
});

async function addCamera(admin: { cookie: string; csrf: string }) {
  const res = await request(app).post("/api/cameras").set("Cookie", admin.cookie).set("X-CSRF-Token", admin.csrf)
    .send({ name: "Lobby", host: "127.0.0.1", port: 80, protocol: "http", brand: "Hikvision", username: "admin", password: "Cam P@ss:1" }).expect(201);
  return res.body.id as string;
}

describe("live video", () => {
  it("relays the video WebSocket to go2rtc for a signed-in Org Admin, with the camera's RTSP stream", async () => {
    const admin = await sessionCookie("admin");
    const id = await addCamera(admin);
    expect((await request(app).get("/api/cameras/live-video").set("Cookie", admin.cookie).expect(200)).body).toEqual({ enabled: true });
    await request(app).post(`/api/cameras/${id}/live/prepare`).set("Cookie", admin.cookie).set("X-CSRF-Token", admin.csrf).expect(200);
    expect(go2rtc.streams.get(`camera_${id}`)).toBe("rtsp://admin:Cam%20P%40ss%3A1@127.0.0.1:554/Streaming/Channels/102");
    expect((await pool.query("SELECT details FROM audit_logs WHERE action = 'camera.live_view'")).rows).toEqual([{ details: { video: true } }]);

    const reply = await upgrade(`/api/cameras/${id}/live/ws`, { Cookie: admin.cookie, Origin: `http://127.0.0.1:${port}` });
    expect(reply).toMatch(/^HTTP\/1\.1 101 /);
    expect(reply).toContain('"type":"mse"');
    expect(go2rtc.wsPaths).toEqual([`/api/ws?src=camera_${id}`]);
  });

  it("refuses without a session, from another site, and for viewers", async () => {
    const admin = await sessionCookie("admin");
    const id = await addCamera(admin);
    const viewer = await sessionCookie("viewer");
    const origin = `http://127.0.0.1:${port}`;
    expect(await upgrade(`/api/cameras/${id}/live/ws`, { Origin: origin })).toMatch(/^HTTP\/1\.1 401 /);
    expect(await upgrade(`/api/cameras/${id}/live/ws`, { Cookie: admin.cookie, Origin: "https://evil.example" })).toMatch(/^HTTP\/1\.1 403 /);
    expect(await upgrade(`/api/cameras/${id}/live/ws`, { Cookie: viewer.cookie, Origin: origin })).toMatch(/^HTTP\/1\.1 403 /);
    expect(await upgrade(`/api/cameras/00000000-0000-0000-0000-000000000000/live/ws`, { Cookie: admin.cookie, Origin: origin })).toMatch(/^HTTP\/1\.1 502 /);
    expect(go2rtc.wsPaths).toEqual([]);
  });
});
