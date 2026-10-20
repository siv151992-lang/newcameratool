import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { MockHikvisionCamera } from "../../src/testing/mockHikvision.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

const app = createApp();
const cam = new MockHikvisionCamera("admin", "Cam-Pass-123");
let port: number;

async function signIn(role: "admin" | "operator" | "viewer") {
  const { username } = await createTestUser(role);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken as string };
}

const cameraBody = () => ({
  name: "Entrance", host: "127.0.0.1", port, protocol: "http", brand: "Hikvision",
  username: "admin", password: "Cam-Pass-123", location: "Entrance",
});

beforeAll(async () => {
  await prepareDb();
  port = await cam.start();
});
afterAll(() => cam.stop());
beforeEach(async () => {
  await resetData();
  cam.mode = "ok";
});

describe("authentication", () => {
  it("rejects bad credentials and unauthenticated requests", async () => {
    await createTestUser("admin", "boss");
    await request(app).post("/api/auth/login").send({ username: "boss", password: "nope" }).expect(401);
    await request(app).get("/api/cameras").expect(401);
  });

  it("locks the account after repeated failures", async () => {
    await createTestUser("admin", "boss");
    for (let i = 0; i < 5; i++) await request(app).post("/api/auth/login").send({ username: "boss", password: "nope" });
    const res = await request(app).post("/api/auth/login").send({ username: "boss", password: PASSWORD });
    expect(res.status).toBe(423);
  });

  it("requires the CSRF token for state-changing requests", async () => {
    const { agent, csrf } = await signIn("admin");
    await agent.post("/api/cameras").send(cameraBody()).expect(403);
    await agent.post("/api/cameras").set("X-CSRF-Token", "wrong").send(cameraBody()).expect(403);
    await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send(cameraBody()).expect(201);
  });

  it("sets an httpOnly, SameSite=Strict session cookie and logs out", async () => {
    const { username } = await createTestUser("viewer");
    const res = await request(app).post("/api/auth/login").send({ username, password: PASSWORD });
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const agent = request.agent(app);
    const login = await agent.post("/api/auth/login").send({ username, password: PASSWORD });
    await agent.post("/api/auth/logout").set("X-CSRF-Token", login.body.csrfToken).expect(204);
    await agent.get("/api/auth/me").expect(401);
  });
});

describe("role-based access control", () => {
  it("viewers can read but not modify or trigger checks", async () => {
    const { agent, csrf } = await signIn("viewer");
    await agent.get("/api/cameras").expect(200);
    await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send(cameraBody()).expect(403);
    await agent.get("/api/settings/monitoring").expect(403);
    await agent.get("/api/users").expect(403);
  });

  it("operators can check storage and manage alerts but not edit cameras", async () => {
    const admin = await signIn("admin");
    const created = await admin.agent.post("/api/cameras").set("X-CSRF-Token", admin.csrf).send(cameraBody()).expect(201);
    const { agent, csrf } = await signIn("operator");
    await agent.post(`/api/cameras/${created.body.id}/check-storage`).set("X-CSRF-Token", csrf).expect(200);
    await agent.patch(`/api/cameras/${created.body.id}`).set("X-CSRF-Token", csrf).send({ name: "x" }).expect(403);
    await agent.delete(`/api/cameras/${created.body.id}`).set("X-CSRF-Token", csrf).expect(403);
    await agent.patch("/api/settings/monitoring").set("X-CSRF-Token", csrf).send({ concurrency: 5 }).expect(403);
  });
});

describe("cameras", () => {
  it("registers, lists, checks, edits and removes a camera without exposing the password", async () => {
    const { agent, csrf } = await signIn("admin");
    const created = await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send(cameraBody()).expect(201);
    expect(created.body).toMatchObject({ name: "Entrance", brand: "hikvision", username: "admin", status: { connection: "unknown", storageHealth: "unknown" } });
    expect(JSON.stringify(created.body)).not.toContain("Cam-Pass-123");
    const id = created.body.id;

    await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send(cameraBody()).expect(409);

    const checked = await agent.post(`/api/cameras/${id}/check-storage`).set("X-CSRF-Token", csrf).expect(200);
    expect(checked.body.camera.status).toMatchObject({ connection: "online", storageHealth: "healthy", usedPercentage: 53.78 });
    expect(checked.body.camera.devices).toHaveLength(1);

    const list = await agent.get("/api/cameras?search=entr&sort=usage&order=desc").expect(200);
    expect(list.body.total).toBe(1);
    expect(JSON.stringify(list.body)).not.toContain("Cam-Pass-123");
    expect((await agent.get("/api/cameras?status=offline")).body.total).toBe(0);
    expect((await agent.get("/api/cameras?minUsage=60")).body.total).toBe(0);

    const summary = await agent.get("/api/cameras/summary").expect(200);
    expect(summary.body).toMatchObject({ totalCameras: 1, online: 1, offline: 0, storageWarning: 0 });

    const history = await agent.get(`/api/cameras/${id}/history`).expect(200);
    expect(history.body.checks).toHaveLength(1);

    // Rotate credentials: blank password keeps the stored one; a new one replaces it.
    await agent.patch(`/api/cameras/${id}`).set("X-CSRF-Token", csrf).send({ name: "Main Entrance" }).expect(200);
    await agent.patch(`/api/cameras/${id}`).set("X-CSRF-Token", csrf).send({ password: "wrong" }).expect(200);
    const failed = await agent.post(`/api/cameras/${id}/check-storage`).set("X-CSRF-Token", csrf).expect(200);
    expect(failed.body.outcome.result).toMatchObject({ ok: false, errorCode: "AUTH_FAILED" });

    await agent.delete(`/api/cameras/${id}`).set("X-CSRF-Token", csrf).expect(204);
    await agent.get(`/api/cameras/${id}`).expect(404);
    expect((await agent.get("/api/cameras")).body.total).toBe(0);
    // History is preserved after removal; credentials are destroyed.
    expect((await pool.query("SELECT count(*)::int AS n FROM storage_checks WHERE camera_id = $1", [id])).rows[0].n).toBe(2);
    expect((await pool.query("SELECT count(*)::int AS n FROM camera_credentials WHERE camera_id = $1", [id])).rows[0].n).toBe(0);
    const actions = (await pool.query("SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY id", [id])).rows.map((r) => r.action);
    expect(actions).toEqual(["camera.created", "camera.updated", "camera.credentials_changed", "camera.removed"]);
  });

  it("validates input", async () => {
    const { agent, csrf } = await signIn("admin");
    const bad = await agent.post("/api/cameras").set("X-CSRF-Token", csrf)
      .send({ ...cameraBody(), host: "http://10.0.0.1/ISAPI", warningThreshold: 95, criticalThreshold: 90 }).expect(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
    const fields = bad.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toContain("host");
    const unknown = await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send({ ...cameraBody(), brand: "Acme" }).expect(400);
    expect(unknown.body.error.message).toMatch(/Unknown brand/);
  });

  it("tests connections with diagnostics, including SSRF refusal", async () => {
    const { agent, csrf } = await signIn("admin");
    const ok = await agent.post("/api/cameras/test-connection").set("X-CSRF-Token", csrf).send(cameraBody()).expect(200);
    expect(ok.body.ok).toBe(true);
    const wrong = await agent.post("/api/cameras/test-connection").set("X-CSRF-Token", csrf).send({ ...cameraBody(), password: "bad-pass" }).expect(200);
    expect(wrong.body).toMatchObject({ ok: false, reachable: true, error: { code: "AUTH_FAILED" } });
    expect(JSON.stringify(wrong.body)).not.toContain("bad-pass");
    const metadata = await agent.post("/api/cameras/test-connection").set("X-CSRF-Token", csrf).send({ ...cameraBody(), host: "169.254.169.254" }).expect(200);
    expect(metadata.body.error.code).toBe("HOST_NOT_ALLOWED");
  });

  it("enables/disables monitoring and bulk-removes cameras", async () => {
    const { agent, csrf } = await signIn("admin");
    const a = await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send(cameraBody()).expect(201);
    const b = await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send({ ...cameraBody(), name: "Second", host: "127.0.0.2" }).expect(201);
    const off = await agent.post(`/api/cameras/${a.body.id}/monitoring`).set("X-CSRF-Token", csrf).send({ enabled: false }).expect(200);
    expect(off.body.monitoringEnabled).toBe(false);
    expect((await agent.get("/api/cameras?status=disabled")).body.total).toBe(1);
    const res = await agent.post("/api/cameras/bulk-delete").set("X-CSRF-Token", csrf).send({ ids: [a.body.id, b.body.id] }).expect(200);
    expect(res.body.removed).toHaveLength(2);
  });
});

describe("CSV import", () => {
  const rows = () => [
    { row: 2, name: "Cam A", ip: "127.0.0.1", brand: "Hikvision", model: "DS-2CD", username: "admin", password: "Cam-Pass-123", location: "Reception", port: String(port), protocol: "http" },
    { row: 3, name: "", ip: "not a host!", brand: "Hikvision", username: "admin", password: "x", port: "99999", protocol: "ftp" },
    { row: 4, name: "Cam A again", ip: "127.0.0.1", brand: "hikvision", username: "admin", password: "Cam-Pass-123", port: String(port), protocol: "http" },
    { row: 5, name: "Cam C", ip: "127.0.0.3", brand: "Hikvision", username: "", password: "", port: String(port), protocol: "" },
    { row: 6, name: "Cam D", ip: "127.0.0.4", brand: "Acme", username: "root", password: "pw", port: "", protocol: "" },
  ];

  it("serves a template", async () => {
    const { agent } = await signIn("admin");
    const res = await agent.get("/api/cameras/import/template").expect(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text.split("\r\n")[0]).toBe("name,ip,brand,model,username,password,location,port,protocol");
  });

  it("validates rows with row numbers, duplicates and shared credentials, without echoing passwords", async () => {
    const { agent, csrf } = await signIn("admin");
    const res = await agent.post("/api/cameras/import/validate").set("X-CSRF-Token", csrf)
      .send({ rows: rows(), options: { sharedCredentials: { username: "shared", password: "Shared-Pass-1" } } }).expect(200);
    const byRow = Object.fromEntries(res.body.results.map((r: { row: number }) => [r.row, r]));
    expect(byRow[2].status).toBe("valid");
    expect(byRow[3].status).toBe("invalid");
    expect(byRow[3].errors.map((e: { field: string }) => e.field).sort()).toEqual(["ip", "name", "port", "protocol"]);
    expect(byRow[4]).toMatchObject({ status: "duplicate" });
    expect(byRow[5]).toMatchObject({ status: "valid", camera: { username: "shared", usesSharedCredentials: true, protocol: "http" } });
    expect(byRow[6].errors[0].message).toMatch(/Unknown brand/);
    expect(res.body.summary).toEqual({ total: 5, valid: 2, invalid: 2, duplicate: 1 });
    const dump = JSON.stringify(res.body);
    expect(dump).not.toContain("Cam-Pass-123");
    expect(dump).not.toContain("Shared-Pass-1");
  });

  it("imports valid rows, skips the rest and can test connectivity", async () => {
    const { agent, csrf } = await signIn("admin");
    const res = await agent.post("/api/cameras/import").set("X-CSRF-Token", csrf)
      .send({ rows: rows(), options: { sharedCredentials: { username: "admin", password: "Cam-Pass-123" }, testConnectivity: true } }).expect(200);
    expect(res.body.summary).toEqual({ total: 5, imported: 2, skipped: 3, failed: 0 });
    const imported = res.body.results.filter((r: { status: string }) => r.status === "imported");
    expect(imported[0].test.ok).toBe(true);
    expect((await agent.get("/api/cameras")).body.total).toBe(2);
    expect(JSON.stringify(res.body)).not.toContain("Cam-Pass-123");
  });
});

describe("alerts and settings", () => {
  it("lists, acknowledges and resolves alerts", async () => {
    const { agent, csrf } = await signIn("admin");
    cam.setDisks([{ id: 1, status: "error", capacityMb: 1000, freeMb: 100, property: "RW" }]);
    const created = await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send(cameraBody()).expect(201);
    await agent.post(`/api/cameras/${created.body.id}/check-storage`).set("X-CSRF-Token", csrf).expect(200);
    cam.setDisks([{ id: 1, name: "hdde", status: "ok", capacityMb: 121942, freeMb: 56362, property: "RW" }]);

    const list = await agent.get("/api/alerts").expect(200);
    expect(list.body.items.map((a: { type: string }) => a.type).sort()).toEqual(["disk_unhealthy", "storage_usage"]);
    const alertId = list.body.items[0].id;
    const ack = await agent.post(`/api/alerts/${alertId}/acknowledge`).set("X-CSRF-Token", csrf).send({ note: "Replacing card" }).expect(200);
    expect(ack.body).toMatchObject({ status: "acknowledged", acknowledgedBy: "admin-user" });
    await agent.post(`/api/alerts/${alertId}/acknowledge`).set("X-CSRF-Token", csrf).send({}).expect(409);
    const resolved = await agent.post(`/api/alerts/${alertId}/resolve`).set("X-CSRF-Token", csrf).send({}).expect(200);
    expect(resolved.body.status).toBe("resolved");
    expect(resolved.body.events.map((e: { eventType: string }) => e.eventType)).toEqual(["opened", "acknowledged", "resolved"]);
  });

  it("validates monitoring settings", async () => {
    const { agent, csrf } = await signIn("admin");
    await agent.patch("/api/settings/monitoring").set("X-CSRF-Token", csrf).send({ warningThresholdPercent: 95, criticalThresholdPercent: 90 }).expect(400);
    await agent.patch("/api/settings/monitoring").set("X-CSRF-Token", csrf).send({ pollIntervalSeconds: 10 }).expect(400);
    const ok = await agent.patch("/api/settings/monitoring").set("X-CSRF-Token", csrf).send({ pollIntervalSeconds: 600 }).expect(200);
    expect(ok.body.pollIntervalSeconds).toBe(600);
  });

  it("lists brand integrations with support status", async () => {
    const { agent } = await signIn("viewer");
    const res = await agent.get("/api/brands").expect(200);
    expect(res.body.find((b: { key: string }) => b.key === "hikvision").supportStatus).toBe("supported");
    expect(res.body.find((b: { key: string }) => b.key === "axis").supportStatus).toBe("unverified");
  });

  it("protects the last administrator", async () => {
    const { agent, csrf } = await signIn("admin");
    const users = await agent.get("/api/users").expect(200);
    await agent.patch(`/api/users/${users.body[0].id}`).set("X-CSRF-Token", csrf).send({ role: "viewer" }).expect(400);
  });
});
