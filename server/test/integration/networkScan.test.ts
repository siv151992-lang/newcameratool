import net from "node:net";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { scanPorts } from "../../src/services/networkScanService.js";
import { MockHikvisionCamera } from "../../src/testing/mockHikvision.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

const app = createApp();
const cam = new MockHikvisionCamera("admin", "Cam-Pass-123");
let port: number;

async function signIn(role: "admin" | "viewer" = "admin") {
  const { username } = await createTestUser(role);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken as string };
}

beforeAll(async () => {
  await prepareDb();
  port = await cam.start();
  // The camera's web port stands in for port 80 (tests cannot use it); a closed port completes the list.
  const closed = net.createServer();
  await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
  const dead = (closed.address() as net.AddressInfo).port;
  await new Promise<void>((r) => closed.close(() => r()));
  scanPorts.all = [port, dead];
  scanPorts.web = port;
});
afterAll(() => cam.stop());
beforeEach(() => resetData());

describe("network scan", () => {
  it("finds a camera, tells its brand without logging in, and marks the ones already added", async () => {
    const { agent, csrf } = await signIn();
    const r = (await agent.post("/api/cameras/scan").set("X-CSRF-Token", csrf).send({ range: "127.0.0.1" }).expect(200)).body;
    expect(r).toMatchObject({ scanned: 1, skipped: 0 });
    expect(r.devices).toEqual([expect.objectContaining({ ip: "127.0.0.1", openPorts: [port], brand: "hikvision", port, protocol: "http", alreadyAdded: false })]);
    expect(r.devices[0].evidence).toContain("Hikvision ISAPI login");
    // No login was tried: every request the camera got was without credentials.
    expect(cam.requests.length).toBeGreaterThan(0);
    expect(cam.requests.every((q) => !q.authorized)).toBe(true);

    await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
      .send({ name: "Gate", host: "127.0.0.1", port, protocol: "http", brand: "Hikvision", username: "admin", password: "Cam-Pass-123" }).expect(201);
    const again = (await agent.post("/api/cameras/scan").set("X-CSRF-Token", csrf).send({ range: "127.0.0.1" }).expect(200)).body;
    expect(again.devices[0].alreadyAdded).toBe(true);
    const audit = (await pool.query("SELECT details FROM audit_logs WHERE action = 'camera.network_scan' ORDER BY id DESC LIMIT 1")).rows[0];
    expect(audit.details).toMatchObject({ range: "127.0.0.1", scanned: 1, found: 1 });
  });

  it("touches only addresses inside the allowed camera networks, and only for those who may add cameras", async () => {
    const { agent, csrf } = await signIn();
    await agent.post("/api/cameras/scan").set("X-CSRF-Token", csrf).send({ range: "8.8.8.0/30" }).expect(400);
    await agent.post("/api/cameras/scan").set("X-CSRF-Token", csrf).send({ range: "10.0.0.0/16" }).expect(400);
    const viewer = await signIn("viewer");
    await viewer.agent.post("/api/cameras/scan").set("X-CSRF-Token", viewer.csrf).send({ range: "127.0.0.1" }).expect(403);
  });
});
