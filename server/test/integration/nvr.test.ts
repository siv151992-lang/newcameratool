import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { MockHikvisionCamera } from "../../src/testing/mockHikvision.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

const app = createApp();
const nvr = new MockHikvisionCamera("admin", "Nvr-Pass-123", [
  { id: 1, name: "hdd1", status: "ok", capacityMb: 3815447, freeMb: 512000, property: "RW", formatType: "EXT4" },
  { id: 2, name: "hdd2", status: "error", capacityMb: 3815447, freeMb: 0, property: "RW" },
]);
let port: number;

async function signIn() {
  const { username } = await createTestUser("admin");
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken as string };
}

beforeAll(async () => {
  await prepareDb();
  port = await nvr.start();
});
afterAll(() => nvr.stop());
beforeEach(async () => {
  await resetData();
  nvr.nvrChannels = [
    { name: "Gate", online: true, recording: true },
    { name: "Lobby", online: true, recording: false },
    { name: "Warehouse", online: false, recording: true },
  ];
});

describe("NVRs", () => {
  it("monitors an NVR's hard disks and channels, alerts on channel problems and counts them on the dashboard", async () => {
    const { agent, csrf } = await signIn();
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
      .send({ name: "NVR 1", host: "127.0.0.1", port, protocol: "http", brand: "Hikvision", username: "admin", password: "Nvr-Pass-123", deviceType: "nvr" })
      .expect(201)).body.id as string;
    await agent.post(`/api/cameras/${id}/check-storage`).set("X-CSRF-Token", csrf).expect(200);

    const detail = (await agent.get(`/api/cameras/${id}`).expect(200)).body;
    expect(detail.deviceType).toBe("nvr");
    expect(detail.devices).toHaveLength(2);
    expect(detail.channelList).toMatchObject([
      { channel: 1, name: "Gate", online: true, recording: "recording" },
      { channel: 2, name: "Lobby", online: true, recording: "idle" },
      { channel: 3, name: "Warehouse", online: false },
    ]);
    expect(detail.channels).toMatchObject({ total: 3, noVideo: 1, notRecording: 1, error: null });

    const alerts = (await agent.get("/api/alerts?status=open").expect(200)).body.items as { type: string; severity: string; description: string }[];
    const channel = alerts.find((a) => a.type === "nvr_channel")!;
    expect(channel.severity).toBe("critical");
    expect(channel.description).toBe("No video from channel 3 (Warehouse). Not recording: channel 2 (Lobby).");
    expect(alerts.some((a) => a.type === "disk_unhealthy")).toBe(true);

    const summary = (await agent.get("/api/cameras/summary").expect(200)).body;
    expect(summary.nvr).toEqual({ total: 1, offline: 0, disks: 2, diskError: 1, channels: 3, channelsNoVideo: 1, channelsNotRecording: 1 });
    // SD cards count cameras only.
    expect(summary.sdCard.total).toBe(0);
    expect((await agent.get("/api/cameras?type=nvr").expect(200)).body.total).toBe(1);
    expect((await agent.get("/api/cameras?type=camera").expect(200)).body.total).toBe(0);
    expect((await agent.get("/api/cameras?status=channelproblem").expect(200)).body.total).toBe(1);

    // Channels back to normal: the alert resolves; a removed channel is dropped.
    nvr.nvrChannels = [{ name: "Gate", online: true, recording: true }, { name: "Lobby", online: true, recording: true }];
    await agent.post(`/api/cameras/${id}/check-storage`).set("X-CSRF-Token", csrf).expect(200);
    expect((await agent.get(`/api/cameras/${id}`).expect(200)).body.channelList).toHaveLength(2);
    const open = (await agent.get("/api/alerts?status=open").expect(200)).body.items as { type: string }[];
    expect(open.some((a) => a.type === "nvr_channel")).toBe(false);
    expect((await pool.query("SELECT count(*)::int AS n FROM nvr_channels")).rows[0].n).toBe(2);
  });

  it("shows a channel's own picture, and logs which channel was watched", async () => {
    const { agent, csrf } = await signIn();
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
      .send({ name: "NVR 2", host: "127.0.0.1", port, protocol: "http", brand: "Hikvision", username: "admin", password: "Nvr-Pass-123", deviceType: "nvr" })
      .expect(201)).body.id as string;
    const before = nvr.requests.length;
    await agent.get(`/api/cameras/${id}/snapshot?start=1&channel=3`).buffer(true).expect(200);
    expect(nvr.requests.slice(before).map((r) => r.path)).toContain("/ISAPI/Streaming/channels/301/picture");
    const logged = (await pool.query("SELECT details FROM audit_logs WHERE action = 'camera.live_view' AND entity_id = $1", [id])).rows;
    expect(logged).toEqual([{ details: { channel: 3 } }]);
  });

  it("does not read channels for a camera", async () => {
    const { agent, csrf } = await signIn();
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
      .send({ name: "Cam", host: "127.0.0.1", port, protocol: "http", brand: "Hikvision", username: "admin", password: "Nvr-Pass-123" })
      .expect(201)).body.id as string;
    await agent.post(`/api/cameras/${id}/check-storage`).set("X-CSRF-Token", csrf).expect(200);
    const detail = (await agent.get(`/api/cameras/${id}`).expect(200)).body;
    expect(detail.deviceType).toBe("camera");
    expect(detail.channels).toBeNull();
    expect(detail.channelList).toEqual([]);
  });
});
