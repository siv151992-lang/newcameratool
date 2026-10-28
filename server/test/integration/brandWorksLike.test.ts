import net from "node:net";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { registry } from "../../src/integrations/registry.js";
import { runCheck } from "../../src/monitoring/checkService.js";
import { MockHikvisionCamera } from "../../src/testing/mockHikvision.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

const app = createApp();
const cam = new MockHikvisionCamera("admin", "Cam-Pass-123");
let port: number;
const deps = { registry, notifier: { dispatch: async () => undefined }, sleep: async () => undefined };

async function signIn(role: "admin" | "viewer") {
  const { username } = await createTestUser(role, undefined, undefined, { systemAdmin: role === "admin" });
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken as string };
}

beforeAll(async () => {
  await prepareDb();
  port = await cam.start();
});
afterAll(() => cam.stop());
beforeEach(async () => {
  await resetData();
  await registry.refresh();
});

describe("adding a brand that works like a built-in adapter", () => {
  it("detects the adapter on one camera, saves the brand, and monitors its cameras with it", async () => {
    const { agent, csrf } = await signIn("admin");
    const body = { host: "127.0.0.1", port, protocol: "http", username: "admin", password: "Cam-Pass-123" };

    const found = (await agent.post("/api/integrations/detect").set("X-CSRF-Token", csrf).send(body).expect(200)).body;
    expect(found.reachable).toBe(true);
    expect(found.match).toMatchObject({ key: "hikvision", result: "works", storageDevices: 1 });
    expect(JSON.stringify(found)).not.toContain("Cam-Pass-123");

    // Wrong password: the camera speaks this API but refuses the login (the search stops there).
    const refused = (await agent.post("/api/integrations/detect").set("X-CSRF-Token", csrf).send({ ...body, password: "wrong" }).expect(200)).body;
    expect(refused.match).toMatchObject({ key: "hikvision", result: "login_refused" });

    // Nothing listening: stops at once, as not reachable.
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const deadPort = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const unreachable = (await agent.post("/api/integrations/detect").set("X-CSRF-Token", csrf).send({ ...body, port: deadPort }).expect(200)).body;
    expect(unreachable).toMatchObject({ reachable: false, match: null });
    expect(unreachable.attempts).toHaveLength(1);

    // Save it: enabled at once, listed for new cameras, no API to describe.
    const brand = (await agent.post("/api/integrations/works-like").set("X-CSRF-Token", csrf)
      .send({ displayName: "HiFocus", manufacturer: "HiFocus Ltd", basedOn: found.match.key }).expect(201)).body;
    expect(brand).toMatchObject({ displayName: "HiFocus", integrationType: "alias", status: "enabled", basedOn: { key: "hikvision", displayName: "Hikvision" } });
    expect(brand.capabilities).toContain("storage-status");
    const brands = (await agent.get("/api/brands").expect(200)).body as { key: string; displayName: string }[];
    expect(brands.some((b) => b.displayName === "HiFocus")).toBe(true);

    // A camera of the brand is checked with the Hikvision adapter.
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
      .send({ name: "Gate", host: "127.0.0.1", port, protocol: "http", brand: "HiFocus", username: "admin", password: "Cam-Pass-123" }).expect(201)).body.id as string;
    expect((await pool.query("SELECT brand_key FROM cameras WHERE id = $1", [id])).rows[0].brand_key).toBe(brand.key);
    await runCheck(id, "manual", deps);
    expect((await pool.query("SELECT connection_status, storage_health FROM camera_status WHERE camera_id = $1", [id])).rows[0]).toEqual({ connection_status: "online", storage_health: "healthy" });

    // Its own test uses the same adapter; it has no API configuration to edit.
    const test = (await agent.post(`/api/integrations/${brand.key}/test`).set("X-CSRF-Token", csrf).send({ target: { cameraId: id } }).expect(200)).body;
    expect(test.ok).toBe(true);
    await agent.patch(`/api/integrations/${brand.key}`).set("X-CSRF-Token", csrf).send({ config: { request: {} } }).expect(400);
    await agent.patch(`/api/integrations/${brand.key}`).set("X-CSRF-Token", csrf).send({ details: { description: "Rebadged Hikvision" } }).expect(200);

    // Same name twice, or an adapter that does not exist: refused.
    await agent.post("/api/integrations/works-like").set("X-CSRF-Token", csrf).send({ displayName: "hifocus", basedOn: "hikvision" }).expect(409);
    await agent.post("/api/integrations/works-like").set("X-CSRF-Token", csrf).send({ displayName: "Other", basedOn: "nope" }).expect(400);
  });

  it("is for system administrators only", async () => {
    const { agent, csrf } = await signIn("viewer");
    await agent.post("/api/integrations/detect").set("X-CSRF-Token", csrf).send({ host: "127.0.0.1", port }).expect(403);
    await agent.post("/api/integrations/works-like").set("X-CSRF-Token", csrf).send({ displayName: "X", basedOn: "hikvision" }).expect(403);
  });
});
