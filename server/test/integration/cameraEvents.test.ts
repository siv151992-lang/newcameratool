import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { registry } from "../../src/integrations/registry.js";
import { runCheck } from "../../src/monitoring/checkService.js";
import { EventStreams } from "../../src/monitoring/eventStreams.js";
import type { NotificationEvent } from "../../src/notifications/types.js";
import { CameraEventHandler } from "../../src/services/cameraEventService.js";
import { MockHikvisionCamera } from "../../src/testing/mockHikvision.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

const app = createApp();
const cam = new MockHikvisionCamera("admin", "Cam-Pass-123");
let port: number;
let sent: NotificationEvent[] = [];
const notifier = { dispatch: async (e: NotificationEvent[]) => void sent.push(...e) };
const deps = { registry, notifier, sleep: async () => undefined };
let streams: EventStreams | undefined;

async function signIn() {
  const { username } = await createTestUser("admin", undefined, undefined, { systemAdmin: true });
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken as string };
}
async function until<T>(f: () => Promise<T> | T, what: string, ms = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const alertsOf = async (id: string, type: string) =>
  (await pool.query("SELECT severity, status, title, description FROM alerts WHERE camera_id = $1 AND type = $2 ORDER BY id", [id, type])).rows;
const state = async (id: string) => (await pool.query("SELECT events_state, events_error FROM camera_status WHERE camera_id = $1", [id])).rows[0];

async function addCamera() {
  const { agent, csrf } = await signIn();
  const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
    .send({ name: "Gate", host: "127.0.0.1", port, protocol: "http", brand: "Hikvision", username: "admin", password: "Cam-Pass-123" }).expect(201)).body.id as string;
  await runCheck(id, "manual", deps); // online, login works
  return { id, agent, csrf };
}

beforeAll(async () => {
  await prepareDb();
  cam.recordingStatusApi = false;
  port = await cam.start();
});
afterAll(() => cam.stop());
beforeEach(async () => {
  await resetData();
  sent = [];
  cam.eventStreamApi = true;
  cam.heartbeatMs = 10_000;
});
afterEach(async () => {
  await streams?.stop();
  streams = undefined;
});

describe("camera events", () => {
  it("keeps the camera's event stream open and raises tampering at once, closing it when the camera says it ended", async () => {
    const { id, agent } = await addCamera();
    streams = new EventStreams(deps, { max: 10, refreshMs: 1e9, sweepMs: 1e9, retryMinMs: 100 });
    await streams.refresh();
    await until(async () => cam.openStreams === 1 && (await state(id))?.events_state === "connected", "the stream to open");

    cam.sendEvent("shelteralarm");
    const [tamper] = await until(async () => {
      const rows = await alertsOf(id, "tamper");
      return rows.length ? rows : null;
    }, "the tamper alert");
    expect(tamper).toMatchObject({ severity: "critical", status: "active", title: "Camera tampered with" });
    expect(tamper.description).toMatch(/covered/);
    expect(tamper.description).not.toMatch(/channel/); // a camera's own events: no channel
    expect(sent.some((e) => e.kind === "opened" && e.type === "tamper")).toBe(true);

    // Repeated while it lasts: still one alert.
    cam.sendEvent("shelteralarm");
    cam.sendEvent("shelteralarm", "inactive");
    await until(async () => (await alertsOf(id, "tamper"))[0]?.status === "resolved", "the alert to resolve");
    expect(await alertsOf(id, "tamper")).toHaveLength(1);

    // A failed login on the camera; the heartbeat ("video loss: inactive") raises nothing.
    cam.sendEvent("videoloss", "inactive");
    cam.sendEvent("illaccess");
    await until(async () => (await alertsOf(id, "illegal_login")).length, "the failed-login alert");
    expect(await alertsOf(id, "video_loss")).toHaveLength(0);

    const events = (await agent.get(`/api/cameras/${id}/events`).expect(200)).body;
    expect(events.map((e: { kind: string; state: string }) => `${e.kind}:${e.state}`)).toEqual(["illegal_login:active", "tamper:inactive", "tamper:active"]);
    const view = (await agent.get(`/api/cameras/${id}`).expect(200)).body;
    expect(view.status.events).toMatchObject({ state: "connected" });
    expect(view.cameraEvents).toBe(true);
  });

  it("reopens a stream the camera closed, says when a camera has none, and stops when turned off for the camera", async () => {
    const { id, agent, csrf } = await addCamera();
    streams = new EventStreams(deps, { max: 10, refreshMs: 1e9, sweepMs: 1e9, retryMinMs: 100 });
    await streams.refresh();
    await until(() => cam.openStreams === 1, "the stream to open");
    cam.closeStreams();
    await until(() => cam.openStreams === 1, "the stream to reopen");

    await agent.patch(`/api/cameras/${id}`).set("X-CSRF-Token", csrf).send({ cameraEvents: false }).expect(200);
    await streams.refresh();
    await until(() => cam.openStreams === 0, "the stream to close");
    expect((await state(id)).events_state).toBeNull();

    await agent.patch(`/api/cameras/${id}`).set("X-CSRF-Token", csrf).send({ cameraEvents: true }).expect(200);
    cam.eventStreamApi = false;
    await streams.refresh();
    const s = await until(async () => ((await state(id))?.events_state === "unsupported") && state(id), "unsupported");
    expect(s.events_error).toMatch(/no event stream/);
  });

  it("does not open streams for cameras whose login fails (cameras lock users out)", async () => {
    const { id } = await addCamera();
    await pool.query("UPDATE camera_status SET consecutive_auth_failures = 2 WHERE camera_id = $1", [id]);
    streams = new EventStreams(deps, { max: 10, refreshMs: 1e9, sweepMs: 1e9 });
    await streams.refresh();
    expect(streams.count).toBe(0);
  });

  it("ends a problem the camera stops repeating, and opens none during maintenance", async () => {
    const { id } = await addCamera();
    await pool.query("UPDATE cameras SET device_type = 'nvr' WHERE id = $1", [id]);
    let now = Date.now();
    const handler = new CameraEventHandler(notifier, () => now);
    await handler.handle(id, { kind: "video_loss", state: "active", type: "videoloss", detail: "Video loss: no video signal", channel: 2, repeatsWithinMs: 120_000 });
    expect(await alertsOf(id, "video_loss")).toMatchObject([{ status: "active", severity: "critical" }]);
    expect((await alertsOf(id, "video_loss"))[0].description).toMatch(/channel 2/);
    now += 60_000;
    expect(await handler.sweep()).toBe(0);
    now += 120_000;
    expect(await handler.sweep()).toBe(1);
    expect(await alertsOf(id, "video_loss")).toMatchObject([{ status: "resolved" }]);
    const history = (await pool.query("SELECT state, detail FROM camera_events WHERE camera_id = $1 ORDER BY id", [id])).rows;
    expect(history.map((h) => h.state)).toEqual(["active", "inactive"]);
    expect(history[1].detail).toMatch(/No longer reported/);

    await pool.query("UPDATE cameras SET maintenance_until = now() + interval '1 hour' WHERE id = $1", [id]);
    await handler.handle(id, { kind: "tamper", state: "active", type: "shelteralarm", detail: "covered" });
    expect(await alertsOf(id, "tamper")).toHaveLength(0);
  });
});
