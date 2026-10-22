import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { Notifier } from "../../src/notifications/notifier.js";
import type { NotificationChannel, NotificationDriver } from "../../src/notifications/types.js";
import { createCamera } from "../../src/services/cameraService.js";
import { getMonitoringSettings } from "../../src/services/settingsService.js";
import { createTestOrg, createTestUser, PASSWORD, prepareDb, resetData, testOrgId } from "../helpers.js";

const app = createApp();

async function signIn(username: string) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  const csrf = res.body.csrfToken as string;
  return {
    agent,
    csrf,
    get: (url: string) => agent.get(url),
    post: (url: string, body: object = {}) => agent.post(url).set("X-CSRF-Token", csrf).send(body),
    patch: (url: string, body: object) => agent.patch(url).set("X-CSRF-Token", csrf).send(body),
    del: (url: string) => agent.delete(url).set("X-CSRF-Token", csrf),
  };
}

const camera = (name: string, host: string) => ({
  name, host, port: 80, protocol: "http" as const, brand: "hikvision", model: null, location: "Site", username: "admin",
  password: "Secret-Cam-Pass-1", monitoringEnabled: true, warningThreshold: null, criticalThreshold: null, caCertificate: null,
});

let otherOrgId: string;
let cameraA: string;
let alertA: number;
let channelA: string;

beforeAll(prepareDb);
beforeEach(async () => {
  await resetData();
  otherOrgId = await createTestOrg("Other organization");
  const a = await createTestUser("admin", "alice");
  await createTestUser("admin", "bob", otherOrgId);
  cameraA = await createCamera(testOrgId, camera("Warehouse", "10.1.1.1"), { ...a, organizationId: testOrgId });
  alertA = (await pool.query(
    "INSERT INTO alerts (camera_id, type, severity, status, title, description) VALUES ($1, 'storage_usage', 'warning', 'active', 'Storage high', 'd') RETURNING id",
    [cameraA],
  )).rows[0].id;
  channelA = (await pool.query(
    `INSERT INTO notification_channels (type, name, config, organization_id) VALUES ('email', 'Alice team', '{"recipients":["a@example.com"]}', $1) RETURNING id`,
    [testOrgId],
  )).rows[0].id;
});

describe("data isolation between organizations", () => {
  it("never shows or changes another organization's cameras, alerts, channels or audit entries", async () => {
    const bob = await signIn("bob");
    expect((await bob.get("/api/cameras").expect(200)).body).toMatchObject({ items: [], total: 0 });
    expect((await bob.get("/api/cameras/summary").expect(200)).body).toMatchObject({ totalCameras: 0 });
    expect((await bob.get("/api/cameras/ids").expect(200)).body).toEqual({ ids: [], total: 0 });
    expect((await bob.get("/api/cameras/locations").expect(200)).body).toEqual([]);
    expect((await bob.get("/api/cameras/report").expect(200)).text).not.toContain("Warehouse");

    // Another organization's camera is "not found", whatever the operation.
    await bob.get(`/api/cameras/${cameraA}`).expect(404);
    await bob.get(`/api/cameras/${cameraA}/history`).expect(404);
    await bob.get(`/api/cameras/${cameraA}/storage`).expect(404);
    await bob.patch(`/api/cameras/${cameraA}`, { name: "Hacked" }).expect(404);
    await bob.post(`/api/cameras/${cameraA}/monitoring`, { enabled: false }).expect(404);
    await bob.post(`/api/cameras/${cameraA}/check-storage`).expect(404);
    await bob.post(`/api/cameras/${cameraA}/test-connection`).expect(404);
    await bob.del(`/api/cameras/${cameraA}`).expect(404);
    expect((await bob.post("/api/cameras/bulk-delete", { ids: [cameraA] }).expect(200)).body).toEqual({ removed: [], notFound: [cameraA] });
    expect((await bob.post("/api/cameras/bulk-local-storage", { ids: [cameraA], localStorage: false }).expect(200)).body).toEqual({ updated: 0 });

    expect((await bob.get("/api/alerts").expect(200)).body.total).toBe(0);
    await bob.get(`/api/alerts/${alertA}`).expect(404);
    await bob.post(`/api/alerts/${alertA}/acknowledge`).expect(404);
    await bob.post(`/api/alerts/${alertA}/resolve`).expect(404);

    expect((await bob.get("/api/settings/notifications").expect(200)).body).toEqual([]);
    await bob.patch(`/api/settings/notifications/${channelA}`, { name: "Mine" }).expect(404);
    await bob.post(`/api/settings/notifications/${channelA}/test`).expect(404);
    await bob.del(`/api/settings/notifications/${channelA}`).expect(404);

    await bob.get(`/api/ai/cameras/${cameraA}/forecast`).expect(404);
    expect((await bob.get("/api/ai/insights").expect(200)).body.summary.cameras).toBe(0);
    expect((await bob.get("/api/brands").expect(200)).body.find((b: { key: string }) => b.key === "hikvision").cameraCount).toBe(0);

    const audit = (await bob.get("/api/audit").expect(200)).body.items as { entity_id: string }[];
    expect(audit.some((e) => e.entity_id === cameraA)).toBe(false);
    expect((await bob.get("/api/audit/export").expect(200)).text).not.toContain("Warehouse");

    // Nothing changed for the owner.
    const alice = await signIn("alice");
    expect((await alice.get(`/api/cameras/${cameraA}`).expect(200)).body).toMatchObject({ name: "Warehouse", monitoringEnabled: true });
    expect((await alice.get(`/api/alerts/${alertA}`).expect(200)).body.status).toBe("active");
    expect((await alice.get("/api/settings/notifications").expect(200)).body).toHaveLength(1);
  });

  it("lets two organizations register the same camera address", async () => {
    const bob = await signIn("bob");
    const created = await bob.post("/api/cameras", { ...camera("Bob's warehouse", "10.1.1.1"), monitoringEnabled: false }).expect(201);
    expect(created.body.name).toBe("Bob's warehouse");
    await bob.post("/api/cameras", { ...camera("Again", "10.1.1.1"), monitoringEnabled: false }).expect(409);
  });

  it("keeps each organization's thresholds, alert switches and AI Mode separate", async () => {
    const bob = await signIn("bob");
    await bob.patch("/api/settings/monitoring", { warningThresholdPercent: 60, recordingAlertsEnabled: false }).expect(200);
    await bob.patch("/api/ai/settings", { enabled: false }).expect(200);
    expect(await getMonitoringSettings(testOrgId)).toMatchObject({ warningThresholdPercent: 80, recordingAlertsEnabled: true });
    expect(await getMonitoringSettings(otherOrgId)).toMatchObject({ warningThresholdPercent: 60, recordingAlertsEnabled: false });
    const alice = await signIn("alice");
    expect((await alice.get("/api/ai/status").expect(200)).body.enabled).toBe(true);
    expect((await bob.get("/api/ai/status").expect(200)).body.enabled).toBe(false);
  });

  it("only lets the system administrator change server-wide settings", async () => {
    const bob = await signIn("bob");
    const refused = await bob.patch("/api/settings/monitoring", { concurrency: 50 }).expect(403);
    expect(refused.body.error.message).toMatch(/system administrator.*concurrency/);
    await pool.query("UPDATE users SET is_system_admin = true WHERE username = 'bob'");
    await bob.patch("/api/settings/monitoring", { concurrency: 50 }).expect(200);
    // Server-wide: every organization gets it.
    expect((await getMonitoringSettings(testOrgId)).concurrency).toBe(50);
  });

  it("sends a camera's alerts only to its own organization's channels", async () => {
    await pool.query(
      `INSERT INTO notification_channels (type, name, config, organization_id) VALUES ('email', 'Bob team', '{"recipients":["b@example.com"]}', $1)`,
      [otherOrgId],
    );
    const sent: string[] = [];
    const driver: NotificationDriver = {
      type: "email",
      validateConfig: (c) => c as NotificationChannel["config"],
      send: async (channel) => void sent.push(channel.name),
    };
    await new Notifier([driver]).dispatch([
      { kind: "opened", alertId: alertA, type: "storage_usage", severity: "warning", title: "t", description: "d", cameraId: cameraA, cameraName: "Warehouse", cameraHost: "10.1.1.1" },
    ]);
    expect(sent).toEqual(["Alice team"]);
  });
});

describe("people in several organizations", () => {
  it("lists their organizations and switches between them", async () => {
    const carol = await createTestUser("viewer", "carol");
    await pool.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'operator')", [otherOrgId, carol.id]);
    const s = await signIn("carol");
    const me = (await s.get("/api/auth/me").expect(200)).body;
    expect(me.organizations.map((o: { name: string; role: string }) => [o.name, o.role])).toEqual([
      ["Other organization", "operator"],
      ["Test organization", "viewer"],
    ]);
    const first = me.user.organizationId as string;
    const second = first === testOrgId ? otherOrgId : testOrgId;

    await s.post("/api/auth/organization", { organizationId: second }).expect(204);
    const after = (await s.get("/api/auth/me").expect(200)).body.user;
    expect(after).toMatchObject({ organizationId: second, role: second === testOrgId ? "viewer" : "operator" });
    expect((await s.get("/api/cameras").expect(200)).body.total).toBe(second === testOrgId ? 1 : 0);
    // Permissions follow the role in the current organization.
    expect(after.permissions.includes("alerts:manage")).toBe(second === otherOrgId);

    // An organization they do not belong to (or does not exist) cannot be entered.
    const stranger = await createTestOrg("Stranger");
    await s.post("/api/auth/organization", { organizationId: stranger }).expect(404);
    await s.post("/api/auth/organization", { organizationId: "not-a-uuid" }).expect(400);
  });

  it("signs in with email address as well as username", async () => {
    await pool.query("UPDATE users SET email = 'alice@example.com' WHERE username = 'alice'");
    const res = await request(app).post("/api/auth/login").send({ username: "Alice@Example.com", password: PASSWORD }).expect(200);
    expect(res.body.user).toMatchObject({ username: "alice", email: "alice@example.com", organizationName: "Test organization" });
  });

  it("tells someone without an organization that they are not in one yet", async () => {
    const dave = await createTestUser("viewer", "dave");
    await pool.query("DELETE FROM organization_members WHERE user_id = $1", [dave.id]);
    const s = await signIn("dave");
    const me = (await s.get("/api/auth/me").expect(200)).body;
    expect(me).toMatchObject({ user: { organizationId: null, role: null, permissions: [] }, organizations: [] });
    await s.get("/api/cameras").expect(403);
  });
});

describe("members", () => {
  it("lets an Org Admin change roles and remove members, but never the last Org Admin", async () => {
    const op = await createTestUser("operator", "olga");
    const alice = await signIn("alice");
    const members = (await alice.get("/api/users").expect(200)).body as { username: string; role: string }[];
    expect(members.map((m) => [m.username, m.role])).toEqual([["alice", "admin"], ["olga", "operator"]]);
    // Members of the other organization are not listed or reachable.
    const bobId = (await pool.query("SELECT id FROM users WHERE username = 'bob'")).rows[0].id;
    await alice.patch(`/api/users/${bobId}`, { role: "viewer" }).expect(404);
    await alice.del(`/api/users/${bobId}`).expect(404);

    const aliceId = (await pool.query("SELECT id FROM users WHERE username = 'alice'")).rows[0].id;
    expect((await alice.patch(`/api/users/${aliceId}`, { role: "viewer" }).expect(400)).body.error.code).toBe("SELF_LOCKOUT");

    await alice.patch(`/api/users/${op.id}`, { role: "admin" }).expect(204);
    const olga = await signIn("olga");
    expect((await olga.get("/api/auth/me").expect(200)).body.user.role).toBe("admin");
    // With two Org Admins, one may be removed; the remaining one may not.
    await olga.del(`/api/users/${aliceId}`).expect(204);
    expect((await olga.del(`/api/users/${op.id}`).expect(400)).body.error.code).toBe("SELF_LOCKOUT");
    // Alice's open session loses access at once; her account remains.
    await alice.get("/api/cameras").expect(403);
    expect((await pool.query("SELECT 1 FROM users WHERE id = $1", [aliceId])).rowCount).toBe(1);

    const audit = (await pool.query("SELECT action, organization_id FROM audit_logs WHERE action LIKE 'member.%' ORDER BY id")).rows;
    expect(audit).toEqual([
      { action: "member.updated", organization_id: testOrgId },
      { action: "member.removed", organization_id: testOrgId },
    ]);
  });

  it("refuses to change an account shared with another organization, unless by the system administrator", async () => {
    const carol = await createTestUser("viewer", "carol");
    await pool.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'viewer')", [otherOrgId, carol.id]);
    const alice = await signIn("alice");
    expect((await alice.patch(`/api/users/${carol.id}`, { isActive: false }).expect(403)).body.error.code).toBe("SHARED_ACCOUNT");
    await alice.patch(`/api/users/${carol.id}`, { role: "operator" }).expect(204);
    await pool.query("UPDATE users SET is_system_admin = true WHERE username = 'alice'");
    await alice.patch(`/api/users/${carol.id}`, { displayName: "Carol" }).expect(204);
  });

  it("is not available to operators and viewers", async () => {
    await createTestUser("operator", "olga");
    const olga = await signIn("olga");
    await olga.get("/api/users").expect(403);
  });
});

describe("organizations", () => {
  it("are created and managed only by the system administrator", async () => {
    const alice = await signIn("alice");
    await alice.get("/api/organizations").expect(403);
    await alice.post("/api/organizations", { name: "Branch" }).expect(403);

    await pool.query("UPDATE users SET is_system_admin = true WHERE username = 'alice'");
    const created = await alice.post("/api/organizations", { name: "Branch office" }).expect(201);
    await alice.post("/api/organizations", { name: "branch OFFICE" }).expect(409);
    await alice.post("/api/organizations", { name: "  " }).expect(400);

    const list = (await alice.get("/api/organizations").expect(200)).body as { id: string; name: string; members: number; admins: number }[];
    expect(list.find((o) => o.id === created.body.id)).toMatchObject({ name: "Branch office", members: 1, admins: 1 });
    // The creator is its first Org Admin and can work in it.
    await alice.post("/api/auth/organization", { organizationId: created.body.id }).expect(204);
    expect((await alice.get("/api/auth/me").expect(200)).body.user).toMatchObject({ organizationName: "Branch office", role: "admin" });

    await alice.patch(`/api/organizations/${created.body.id}`, { name: "Head office" }).expect(204);
    const audit = (await pool.query("SELECT action, organization_id FROM audit_logs WHERE entity_type = 'organization' ORDER BY id")).rows;
    expect(audit.filter((a) => a.action.startsWith("organization."))).toEqual([
      { action: "organization.created", organization_id: null },
      { action: "organization.updated", organization_id: null },
    ]);
  });

  it("stops access and monitoring when an organization is deactivated", async () => {
    const bob = await signIn("bob");
    await bob.get("/api/cameras").expect(200);
    await pool.query("UPDATE users SET is_system_admin = true WHERE username = 'alice'");
    const alice = await signIn("alice");
    await alice.patch(`/api/organizations/${otherOrgId}`, { isActive: false }).expect(204);
    expect((await bob.get("/api/cameras").expect(403)).body.error.code).toBe("NO_ORGANIZATION");
    expect((await bob.get("/api/auth/me").expect(200)).body.organizations).toEqual([]);
  });
});
