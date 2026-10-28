import { createHash } from "node:crypto";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { createApp } from "../../src/app.js";
import { config } from "../../src/config.js";
import { pool } from "../../src/db/pool.js";
import { attachLiveVideo } from "../../src/services/liveVideoProxy.js";
import { MockHikvisionCamera } from "../../src/testing/mockHikvision.js";
import { MockVendorCamera } from "../../src/testing/mockVendor.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

/** Stands in for go2rtc: records registered streams and answers the WebSocket with one text frame. */
const go2rtc = { streams: new Map<string, string>(), wsPaths: [] as string[], readOnlyConfig: false };
const fake = http.createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  if (url.pathname === "/api/streams" && req.method === "PUT") {
    go2rtc.streams.set(url.searchParams.get("name")!, url.searchParams.get("src")!);
    // Like go2rtc with a read-only config file: the stream is added, saving the config fails.
    if (go2rtc.readOnlyConfig) res.statusCode = 400;
    return res.end(go2rtc.readOnlyConfig ? "open /config/go2rtc.yaml: read-only file system" : "");
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

const cam = new MockHikvisionCamera("admin", "Cam P@ss:1");
const wisenet = new MockVendorCamera("admin", "Cam P@ss:1", "hanwha");
let camPort: number;
let wisenetPort: number;

beforeAll(async () => {
  await prepareDb();
  camPort = await cam.start();
  wisenetPort = await wisenet.start();
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  (config as { LIVE_VIDEO_URL?: string }).LIVE_VIDEO_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  (config as { LIVE_VIDEO_URL?: string }).LIVE_VIDEO_URL = undefined;
  server.close();
  fake.close();
  await cam.stop();
  await wisenet.stop();
});
beforeEach(async () => {
  await resetData();
  go2rtc.streams.clear();
  go2rtc.wsPaths = [];
  go2rtc.readOnlyConfig = false;
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

  it("works when go2rtc cannot save its config file (read-only mount)", async () => {
    const admin = await sessionCookie("admin");
    const id = await addCamera(admin);
    go2rtc.readOnlyConfig = true;
    await request(app).post(`/api/cameras/${id}/live/prepare`).set("Cookie", admin.cookie).set("X-CSRF-Token", admin.csrf).expect(200);
    expect(go2rtc.streams.has(`camera_${id}`)).toBe(true);
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

  it("lists a day's recordings and plays them from a chosen time through go2rtc", async () => {
    const admin = await sessionCookie("admin");
    const id = (await request(app).post("/api/cameras").set("Cookie", admin.cookie).set("X-CSRF-Token", admin.csrf)
      .send({ name: "Lobby", host: "127.0.0.1", port: camPort, protocol: "http", brand: "Hikvision", username: "admin", password: "Cam P@ss:1" }).expect(201)).body.id as string;
    const today = new Date().toISOString().slice(0, 10);
    // The camera's clock at 12:00 today, whatever time the test runs: its recordings (around midnight,
    // and the last hour) then always leave a gap at 00:45 (near midnight they would overlap).
    cam.clockSkewMs = Date.parse(`${today}T12:00:00Z`) - Date.now();
    onTestFinished(() => void (cam.clockSkewMs = 0));
    const day = (await request(app).get(`/api/cameras/${id}/recordings?date=${today}`).set("Cookie", admin.cookie).expect(200)).body;
    expect(day.date).toBe(today);
    expect(day.segments.length).toBeGreaterThan(0);
    expect(day.segments[0].start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    const { oldest } = (await request(app).get(`/api/cameras/${id}/recordings/oldest`).set("Cookie", admin.cookie).expect(200)).body;
    expect(oldest < `${today}T00:00:00`).toBe(true);
    // The calendar: days of the month with recordings.
    const { days } = (await request(app).get(`/api/cameras/${id}/recordings/days?month=${today.slice(0, 7)}`).set("Cookie", admin.cookie).expect(200)).body;
    expect(days).toContain(today);
    expect(days.every((d: string) => d.startsWith(today.slice(0, 7)))).toBe(true);
    await request(app).get(`/api/cameras/${id}/recordings/days?month=2026-13`).set("Cookie", admin.cookie).expect(400);

    // The player lists the day before too; playing today must not search the camera again.
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    await request(app).get(`/api/cameras/${id}/recordings?date=${yesterday}`).set("Cookie", admin.cookie).expect(200);
    cam.requests.length = 0;
    await request(app).post(`/api/cameras/${id}/playback/prepare`).set("Cookie", admin.cookie).set("X-CSRF-Token", admin.csrf)
      .send({ start: `${today}T00:15:00` }).expect(200);
    expect(cam.requests.filter((r) => r.path.includes("ContentMgmt/search"))).toEqual([]);
    const [name, src] = [...go2rtc.streams].find(([n]) => n.startsWith(`playback_${id}_`))!;
    // Hikvision: through the relay, which also gives the start time as a clock range (firmware that
    // ignores starttime plays from the first recording on the card); the start and end in the address.
    const d = today.replace(/-/g, "");
    expect(src).toMatch(new RegExp(`^rtsp://127\\.0\\.0\\.1:8554/r/[A-Za-z0-9_-]{24}/Streaming/tracks/101\\?starttime=${d}T001500Z&endtime=${d}T121500Z$`));
    expect(src).not.toContain("Cam");
    const reply = await upgrade(`/api/cameras/${id}/playback/ws`, { Cookie: admin.cookie, Origin: `http://127.0.0.1:${port}` });
    expect(reply).toMatch(/^HTTP\/1\.1 101 /);
    expect(go2rtc.wsPaths).toEqual([`/api/ws?src=${name}`]);
    expect((await pool.query("SELECT details FROM audit_logs WHERE action = 'camera.playback'")).rows).toEqual([{ details: { start: `${today}T00:15:00`, via: "/Streaming/tracks/101" } }]);

    // A time in a gap plays from the next recording (the simulated camera has none from 00:30 until the last hour).
    const gap = (await request(app).post(`/api/cameras/${id}/playback/prepare`).set("Cookie", admin.cookie).set("X-CSRF-Token", admin.csrf)
      .send({ start: `${today}T00:45:00` }).expect(200)).body;
    // The simulated camera's newest recording moves with the clock, so allow the second or two between listings.
    const next = day.segments[day.segments.length - 1].start as string;
    expect(Math.abs(Date.parse(`${gap.start}Z`) - Date.parse(`${next}Z`))).toBeLessThanOrEqual(5000);
    expect([...go2rtc.streams].find(([n]) => n === name)![1]).toContain(`starttime=${(gap.start as string).replace(/[-:]/g, "")}Z`);

    // Faster than normal goes through the relay, which asks the camera for it.
    await request(app).post(`/api/cameras/${id}/playback/prepare`).set("Cookie", admin.cookie).set("X-CSRF-Token", admin.csrf)
      .send({ start: `${today}T00:30:00`, speed: 4 }).expect(200);
    const fast = [...go2rtc.streams].find(([n]) => n === name)![1];
    expect(fast).toMatch(/^rtsp:\/\/127\.0\.0\.1:8554\/r\/[A-Za-z0-9_-]{24}\/Streaming\/tracks\/101\?starttime=/);
    expect(fast).not.toContain("Cam");
    await request(app).post(`/api/cameras/${id}/playback/prepare`).set("Cookie", admin.cookie).set("X-CSRF-Token", admin.csrf)
      .send({ start: `${today}T00:30:00`, speed: 3 }).expect(400);

    const viewer = await sessionCookie("viewer");
    await request(app).get(`/api/cameras/${id}/recordings?date=${today}`).set("Cookie", viewer.cookie).expect(403);
  });

  it("plays Hanwha recordings: the timeline in UTC shown in local time, playback in UTC", async () => {
    const admin = await sessionCookie("admin");
    const id = (await request(app).post("/api/cameras").set("Cookie", admin.cookie).set("X-CSRF-Token", admin.csrf)
      .send({ name: "Gate", host: "127.0.0.1", port: wisenetPort, protocol: "http", brand: "Hanwha", username: "admin", password: "Cam P@ss:1" }).expect(201)).body.id as string;
    const localToday = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const day = (await request(app).get(`/api/cameras/${id}/recordings?date=${localToday}`).set("Cookie", admin.cookie).expect(200)).body;
    expect(day.segments[0].start).toBe(`${localToday}T00:00:00`);
    // From start: the oldest recording, found by listing (Hanwha reports no recording range).
    const { oldest } = (await request(app).get(`/api/cameras/${id}/recordings/oldest`).set("Cookie", admin.cookie).expect(200)).body;
    expect(oldest).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(oldest.slice(0, 10) <= localToday).toBe(true);
    await request(app).post(`/api/cameras/${id}/playback/prepare`).set("Cookie", admin.cookie).set("X-CSRF-Token", admin.csrf)
      .send({ start: `${localToday}T05:30:00` }).expect(200);
    const src = [...go2rtc.streams].find(([n]) => n.startsWith(`playback_${id}_`))![1];
    // 05:30 in India is 00:00 UTC. Through the relay, which holds the login (go2rtc never gets it).
    expect(src).toMatch(new RegExp(`^rtsp://127\\.0\\.0\\.1:8554/r/[A-Za-z0-9_-]{24}/recording/${localToday.replace(/-/g, "")}000000-${localToday.replace(/-/g, "")}120000/play\\.smp$`));
    expect(src).not.toContain("Cam");
  });

  it("plays an NVR's channels: live and recordings of channel 3 through the NVR", async () => {
    const admin = await sessionCookie("admin");
    const id = (await request(app).post("/api/cameras").set("Cookie", admin.cookie).set("X-CSRF-Token", admin.csrf)
      .send({ name: "NVR", host: "127.0.0.1", port: camPort, protocol: "http", brand: "Hikvision", username: "admin", password: "Cam P@ss:1", deviceType: "nvr" }).expect(201)).body.id as string;
    await request(app).post(`/api/cameras/${id}/live/prepare?channel=3`).set("Cookie", admin.cookie).set("X-CSRF-Token", admin.csrf).expect(200);
    expect(go2rtc.streams.get(`camera_${id}_c3`)).toBe("rtsp://admin:Cam%20P%40ss%3A1@127.0.0.1:554/Streaming/Channels/302");
    const reply = await upgrade(`/api/cameras/${id}/live/ws?channel=3`, { Cookie: admin.cookie, Origin: `http://127.0.0.1:${port}` });
    expect(reply).toMatch(/^HTTP\/1\.1 101 /);
    expect(go2rtc.wsPaths.at(-1)).toBe(`/api/ws?src=camera_${id}_c3`);

    const today = new Date().toISOString().slice(0, 10);
    await request(app).get(`/api/cameras/${id}/recordings?date=${today}&channel=3`).set("Cookie", admin.cookie).expect(200);
    await request(app).post(`/api/cameras/${id}/playback/prepare`).set("Cookie", admin.cookie).set("X-CSRF-Token", admin.csrf)
      .send({ start: `${today}T00:30:00`, channel: 3 }).expect(200);
    const src = [...go2rtc.streams].find(([n]) => n.startsWith(`playback_${id}_`))![1];
    expect(src).toContain("/Streaming/tracks/301?starttime=");
    await request(app).get(`/api/cameras/${id}/recordings?date=${today}&channel=0`).set("Cookie", admin.cookie).expect(400);
  });
});
