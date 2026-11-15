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
  it("shows everyone the Dashboard, Alerts and reports, and limits the camera pages, live view, recordings and actions", async () => {
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
    // Cameras list and camera pages: the chosen cameras only.
    expect(await names()).toEqual(["Gate", "Lobby", "Roof"]);
    expect(await names(admin.agent)).toEqual(["Gate", "Lobby", "Roof", "Store"]);
    expect((await v.get("/api/cameras/ids").expect(200)).body.total).toBe(3);
    expect((await v.get("/api/cameras/locations").expect(200)).body).toEqual(["Site A"]);
    await v.get(`/api/cameras/${gate.id}`).expect(200);
    await v.get(`/api/cameras/${store.id}`).expect(404);
    await v.get(`/api/cameras/${store.id}/history`).expect(404);
    await v.get(`/api/cameras/${store.id}/events`).expect(404);

    // Dashboard, Alerts and reports: every camera.
    expect((await v.get("/api/cameras/summary").expect(200)).body.totalCameras).toBe(4);
    expect((await v.get("/api/cameras/summary").expect(200)).body.alerts.critical).toBe(4);
    const alertCams = ((await v.get("/api/alerts?pageSize=100").expect(200)).body.items as { cameraName: string }[]).map((a) => a.cameraName).sort();
    expect(alertCams).toEqual(["Gate", "Lobby", "Roof", "Store"]);
    await v.get(`/api/alerts/${store.alertId}`).expect(200);
    expect((await v.get("/api/cameras/report?timeZone=UTC").expect(200)).text).toContain("Store");
    expect(((await v.get("/api/cameras/uptime?days=7").expect(200)).body.cameras as { name: string }[]).map((c) => c.name)).toContain("Store");
    expect(JSON.stringify((await v.get("/api/cameras/firmware/cameras?brand=hikvision").expect(200)).body)).toContain("Store");

    // The operator: live view, recordings and actions on Site A only; alerts as the role allows.
    const op = operator.agent;
    await op.post(`/api/cameras/${roof.id}/check-storage`).set("X-CSRF-Token", operator.csrf).expect(404);
    await op.post(`/api/cameras/${store.id}/live/prepare`).set("X-CSRF-Token", operator.csrf).send({}).expect(404);
    await op.get(`/api/cameras/${store.id}/recordings?date=2026-11-01`).expect(404);
    await op.get(`/api/cameras/${store.id}/snapshot`).expect(404);
    await op.post(`/api/alerts/${store.alertId}/acknowledge`).set("X-CSRF-Token", operator.csrf).send({}).expect(200);
    const statusOf = async (alertId: string) => (await pool.query("SELECT status FROM alerts WHERE id = $1", [alertId])).rows[0].status;
    expect(await statusOf(store.alertId)).toBe("acknowledged");
    const bulk = (await op.post("/api/alerts/bulk").set("X-CSRF-Token", operator.csrf).send({ action: "acknowledge", filter: { status: "active" } }).expect(200)).body;
    expect(bulk.done).toBe(3);
    expect(await statusOf(lobby.alertId)).toBe("acknowledged");
    await op.post("/api/cameras/bulk-maintenance").set("X-CSRF-Token", operator.csrf).send({ ids: [store.id, gate.id], minutes: 60 }).expect(200);
    const inMaintenance = (await pool.query("SELECT name FROM cameras WHERE maintenance_until > now() ORDER BY name")).rows.map((r) => r.name);
    expect(inMaintenance).toEqual(["Gate"]);

    // Back to all cameras.
    await admin.agent.put(`/api/users/${viewer.id}/camera-access`).set("X-CSRF-Token", admin.csrf).send({ mode: "all" }).expect(200);
    expect(await names()).toEqual(["Gate", "Lobby", "Roof", "Store"]);
  });

  it("turns live view, recordings and camera actions off per member, never beyond the role", async () => {
    const gate = await camera("Gate", "Site A");
    const admin = await signIn("admin");
    const operator = await signIn("operator");
    const viewer = await signIn("viewer");
    const perms = async (who: typeof operator) => ((await who.agent.get("/api/auth/me").expect(200)).body.user?.permissions ?? (await who.agent.get("/api/auth/me")).body.permissions) as string[];
    expect(await perms(operator)).toEqual(expect.arrayContaining(["cameras:live", "cameras:recordings", "cameras:check"]));
    expect(await perms(viewer)).not.toContain("cameras:recordings"); // a Viewer has no live view, so no recordings either

    const access = (await admin.agent.get(`/api/users/${viewer.id}/camera-access`).expect(200)).body;
    expect(access.available).toEqual({ live: false, recordings: false, actions: false });

    // Live view off, recordings on, actions off.
    await admin.agent.put(`/api/users/${operator.id}/camera-access`).set("X-CSRF-Token", admin.csrf)
      .send({ mode: "all", features: { live: false, recordings: true, actions: false } }).expect(200);
    expect(await perms(operator)).toEqual(expect.arrayContaining(["cameras:recordings", "cameras:read", "alerts:manage"]));
    expect(await perms(operator)).not.toContain("cameras:live");
    expect(await perms(operator)).not.toContain("cameras:check");
    const op = operator.agent;
    await op.post(`/api/cameras/${gate.id}/live/prepare`).set("X-CSRF-Token", operator.csrf).send({}).expect(403);
    await op.get(`/api/cameras/${gate.id}/snapshot`).expect(403);
    await op.post(`/api/cameras/${gate.id}/check-storage`).set("X-CSRF-Token", operator.csrf).expect(403);
    await op.post("/api/cameras/bulk-maintenance").set("X-CSRF-Token", operator.csrf).send({ ids: [gate.id], minutes: 60 }).expect(403);
    // Recordings stay allowed: the request gets past the permission (the camera itself is not reachable in tests).
    expect((await op.get(`/api/cameras/${gate.id}/recordings?date=2026-11-01`)).status).not.toBe(403);

    // Recordings off too.
    await admin.agent.put(`/api/users/${operator.id}/camera-access`).set("X-CSRF-Token", admin.csrf)
      .send({ mode: "all", features: { live: true, recordings: false, actions: true } }).expect(200);
    await op.get(`/api/cameras/${gate.id}/recordings?date=2026-11-01`).expect(403);
    expect(await perms(operator)).toEqual(expect.arrayContaining(["cameras:live", "cameras:check"]));
    const listed = (await admin.agent.get("/api/users").expect(200)).body.find((u: { username: string }) => u.username === "operator-user");
    expect(listed).toMatchObject({ canLive: true, canRecordings: false, canActions: true });
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

  it("keeps cached analyses of limited and unlimited requests apart (AI Mode itself shows every camera)", async () => {
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
