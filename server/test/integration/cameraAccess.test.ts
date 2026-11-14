import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearInsightsCache, getFleetInsights } from "../../src/ai/insightsService.js";
import { runWithCameraScope } from "../../src/auth/cameraScope.js";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { createCamera } from "../../src/services/cameraService.js";
import { createTestOrg, createTestUser, PASSWORD, prepareDb, resetData, testOrgId } from "../helpers.js";

const app = createApp();

async function signIn(role: "admin" | "operator" | "viewer", username = `${role}-user`) {
  const user = await createTestUser(role, username);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  await agent.post("/api/auth/confirm-password").set("X-CSRF-Token", res.body.csrfToken).send({ password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken as string, id: user.id };
}

let hostN = 10;
async function camera(name: string, location: string | null, orgId = testOrgId) {
  const actor = await createTestUser("admin", `seed-${name.toLowerCase().replace(/\W/g, "")}-${hostN}`, orgId);
  const id = await createCamera(
    orgId,
    { name, host: `10.9.0.${hostN++}`, port: 80, protocol: "http", brand: "hikvision", model: null, location, username: "admin",
      password: "Secret-Cam-Pass-1", monitoringEnabled: true, warningThreshold: null, criticalThreshold: null, caCertificate: null },
    actor,
  );
  const alert = await pool.query<{ id: string }>(
    "INSERT INTO alerts (camera_id, type, severity, status, title, description) VALUES ($1, 'offline', 'critical', 'active', 'Camera offline', 'x') RETURNING id::text",
    [id],
  );
  return { id, alertId: alert.rows[0]!.id };
}

beforeAll(prepareDb);
beforeEach(async () => {
  await resetData();
  clearInsightsCache();
});

describe("camera access per user", () => {
  it("shows a limited member only their locations and cameras, everywhere", async () => {
    const gate = await camera("Gate", "Site A");
    const lobby = await camera("Lobby", "Site A");
    const store = await camera("Store", "Site B");
    const roof = await camera("Roof", null);
    const admin = await signIn("admin");
    const viewer = await signIn("viewer");
    const operator = await signIn("operator");

    // Admin gives the viewer Site A and the Roof camera, the operator Site A only.
    for (const [who, body] of [[viewer, { mode: "limited", locations: ["Site A"], cameraIds: [roof.id] }], [operator, { mode: "limited", locations: ["Site A"] }]] as const) {
      const r = await admin.agent.put(`/api/users/${who.id}/camera-access`).set("X-CSRF-Token", admin.csrf).send(body).expect(200);
      expect(r.body.mode).toBe("limited");
    }
    const list = (await admin.agent.get("/api/users").expect(200)).body as { username: string; cameraAccess: string; accessLocations: number; accessCameras: number }[];
    expect(list.find((u) => u.username === "viewer-user")).toMatchObject({ cameraAccess: "limited", accessLocations: 1, accessCameras: 1 });

    const v = viewer.agent;
    const names = async (agent = v) => ((await agent.get("/api/cameras?pageSize=100").expect(200)).body.items as { name: string }[]).map((c) => c.name).sort();
    expect(await names()).toEqual(["Gate", "Lobby", "Roof"]);
    expect(await names(admin.agent)).toEqual(["Gate", "Lobby", "Roof", "Store"]);
    expect((await v.get("/api/cameras/summary").expect(200)).body.totalCameras).toBe(3);
    expect((await v.get("/api/cameras/ids").expect(200)).body.total).toBe(3);
    expect((await v.get("/api/cameras/locations").expect(200)).body).toEqual(["Site A"]);

    // Another camera's page, history, events, alerts: not found.
    await v.get(`/api/cameras/${gate.id}`).expect(200);
    await v.get(`/api/cameras/${store.id}`).expect(404);
    await v.get(`/api/cameras/${store.id}/history`).expect(404);
    await v.get(`/api/cameras/${store.id}/events`).expect(404);
    await v.get(`/api/cameras/${store.id}/storage`).expect(404);
    const alertCams = ((await v.get("/api/alerts?pageSize=100").expect(200)).body.items as { cameraName: string }[]).map((a) => a.cameraName).sort();
    expect(alertCams).toEqual(["Gate", "Lobby", "Roof"]);
    await v.get(`/api/alerts/${store.alertId}`).expect(404);
    expect((await v.get("/api/cameras/summary").expect(200)).body.alerts.critical).toBe(3);

    // Reports and lists built from the cameras.
    const csv = (await v.get("/api/cameras/report?timeZone=UTC").expect(200)).text;
    expect(csv).toContain("Gate");
    expect(csv).not.toContain("Store");
    const uptime = (await v.get("/api/cameras/uptime?days=7").expect(200)).body.cameras as { name: string }[];
    expect(uptime.map((c) => c.name)).not.toContain("Store");
    const firmware = JSON.stringify((await v.get("/api/cameras/firmware/cameras?brand=hikvision").expect(200)).body);
    expect(firmware).not.toContain("Store");
    expect(firmware).toContain("Gate");

    // The operator can act only on Site A: checks, live view, alerts, maintenance.
    const op = operator.agent;
    await op.post(`/api/cameras/${roof.id}/check-storage`).set("X-CSRF-Token", operator.csrf).expect(404);
    await op.post(`/api/cameras/${store.id}/live/prepare`).set("X-CSRF-Token", operator.csrf).send({}).expect(404);
    await op.get(`/api/cameras/${store.id}/recordings?date=2026-11-01`).expect(404);
    await op.post(`/api/alerts/${store.alertId}/acknowledge`).set("X-CSRF-Token", operator.csrf).send({}).expect(404);
    const bulk = (await op.post("/api/alerts/bulk").set("X-CSRF-Token", operator.csrf).send({ action: "acknowledge", filter: { status: "open" } }).expect(200)).body;
    expect(bulk.done).toBe(2); // Gate and Lobby, not Store or Roof
    const statusOf = async (alertId: string) => (await pool.query("SELECT status FROM alerts WHERE id = $1", [alertId])).rows[0].status;
    expect(await statusOf(store.alertId)).toBe("active");
    expect(await statusOf(lobby.alertId)).toBe("acknowledged");
    await op.post("/api/cameras/bulk-maintenance").set("X-CSRF-Token", operator.csrf).send({ ids: [store.id, gate.id], minutes: 60 }).expect(200);
    const inMaintenance = (await pool.query("SELECT name FROM cameras WHERE maintenance_until > now() ORDER BY name")).rows.map((r) => r.name);
    expect(inMaintenance).toEqual(["Gate"]);

    // Back to all cameras.
    await admin.agent.put(`/api/users/${viewer.id}/camera-access`).set("X-CSRF-Token", admin.csrf).send({ mode: "all" }).expect(200);
    expect(await names()).toEqual(["Gate", "Lobby", "Roof", "Store"]);
  });

  it("never limits an Org Admin, and checks what is chosen", async () => {
    await camera("Gate", "Site A");
    await camera("Store", "Site B");
    const other = await camera("Elsewhere", "Site A", await createTestOrg("Other organization"));
    const admin = await signIn("admin");
    const second = await signIn("admin", "second-admin");
    const viewer = await signIn("viewer");
    const put = (id: string, body: object) => admin.agent.put(`/api/users/${id}/camera-access`).set("X-CSRF-Token", admin.csrf).send(body);

    await put(second.id, { mode: "limited", locations: ["Site A"] }).expect(200);
    expect(((await second.agent.get("/api/cameras").expect(200)).body.items as unknown[]).length).toBe(2);

    expect((await put(viewer.id, { mode: "limited" }).expect(400)).body.error.message).toMatch(/at least one location or camera/);
    expect((await put(viewer.id, { mode: "limited", locations: ["Nowhere"] }).expect(400)).body.error.message).toMatch(/No camera has the location "Nowhere"/);
    await put(viewer.id, { mode: "limited", cameraIds: [other.id] }).expect(400);
    // Only Org Admins manage it.
    await viewer.agent.put(`/api/users/${viewer.id}/camera-access`).set("X-CSRF-Token", viewer.csrf).send({ mode: "all" }).expect(403);
  });

  it("keeps a limited member's AI analysis to their cameras, apart from everyone else's", async () => {
    await camera("Gate", "Site A");
    await camera("Store", "Site B");
    const viewer = await signIn("viewer");
    const admin = await signIn("admin");
    await admin.agent.put(`/api/users/${viewer.id}/camera-access`).set("X-CSRF-Token", admin.csrf).send({ mode: "limited", locations: ["Site B"] }).expect(200);
    const all = await getFleetInsights(testOrgId);
    const limited = await runWithCameraScope({ userId: viewer.id, organizationId: testOrgId }, () => getFleetInsights(testOrgId));
    expect(all.cameras.map((c) => c.camera.name).sort()).toEqual(["Gate", "Store"]);
    expect(limited.cameras.map((c) => c.camera.name)).toEqual(["Store"]);
    expect((await getFleetInsights(testOrgId)).cameras).toHaveLength(2);
  });
});
