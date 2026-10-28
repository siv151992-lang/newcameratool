import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { hostGuard } from "../../src/security/hostGuardInstance.js";
import { MockHikvisionCamera } from "../../src/testing/mockHikvision.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

const app = createApp();
const cam = new MockHikvisionCamera("admin", "Cam-Pass-123");
let port: number;

async function signIn(role: "admin" | "operator" | "viewer", opts: { systemAdmin?: boolean } = {}) {
  const { username } = await createTestUser(role, undefined, undefined, opts);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  // Settings are locked until the password is entered again: open them, as a user would.
  await agent.post("/api/auth/confirm-password").set("X-CSRF-Token", res.body.csrfToken).send({ password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken as string, username };
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
    expect(checked.body.camera.status.recording).toMatchObject({ state: "recording", detail: expect.stringContaining("recording") });

    const list = await agent.get("/api/cameras?search=entr&sort=usage&order=desc").expect(200);
    expect(list.body.total).toBe(1);
    expect(JSON.stringify(list.body)).not.toContain("Cam-Pass-123");
    expect((await agent.get("/api/cameras?status=offline")).body.total).toBe(0);
    expect((await agent.get("/api/cameras?minUsage=60")).body.total).toBe(0);
    expect((await agent.get("/api/cameras?recording=recording&sort=recording&order=desc")).body.total).toBe(1);
    expect((await agent.get("/api/cameras?recording=idle")).body.total).toBe(0);
    await agent.get("/api/cameras?recording=maybe").expect(400);

    // Sorting: problems first when descending (a camera never checked is above one online).
    const other = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send({ ...cameraBody(), name: "Yard", host: "127.0.0.2" }).expect(201)).body.id;
    const names = async (q: string) => ((await agent.get(`/api/cameras?${q}`).expect(200)).body.items as { name: string }[]).map((c) => c.name);
    expect(await names("sort=connection&order=desc")).toEqual(["Yard", "Entrance"]);
    expect(await names("sort=connection&order=asc")).toEqual(["Entrance", "Yard"]);
    expect(await names("sort=name&order=desc")).toEqual(["Yard", "Entrance"]);
    expect(await names("sort=password&order=desc")).toHaveLength(2);
    await agent.delete(`/api/cameras/${other}`).set("X-CSRF-Token", csrf).expect(204);

    const summary = await agent.get("/api/cameras/summary").expect(200);
    expect(summary.body).toMatchObject({ totalCameras: 1, online: 1, offline: 0, storageWarning: 0, recording: 1, notRecording: 0 });

    const history = await agent.get(`/api/cameras/${id}/history`).expect(200);
    expect(history.body.checks).toHaveLength(1);
    expect(history.body.checks[0].recordingState).toBe("recording");

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
    // The audit log names the camera (its latest name), also after removal.
    const log = (await agent.get(`/api/audit?entityType=camera&entityId=${id}`).expect(200)).body.items;
    expect(log).toHaveLength(4);
    for (const e of log) expect(e).toMatchObject({ camera_name: "Main Entrance", camera_removed: true });
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

  it("lets administrators change the allowed camera networks, applied immediately", async () => {
    const operator = await signIn("operator");
    const initial = await operator.agent.get("/api/settings/networks").expect(200);
    expect(initial.body).toMatchObject({ isDefault: true, allowedNetworks: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"], camerasOutside: [] });
    await operator.agent.patch("/api/settings/networks").set("X-CSRF-Token", operator.csrf).send({ allowedNetworks: ["10.10.15.0/24"] }).expect(403);
    // Org Admins cannot either: camera networks protect the whole server.
    const orgAdmin = await signIn("admin");
    await orgAdmin.agent.patch("/api/settings/networks").set("X-CSRF-Token", orgAdmin.csrf).send({ allowedNetworks: ["10.10.15.0/24"] }).expect(403);

    await pool.query("UPDATE users SET is_system_admin = true WHERE username = 'admin-user'");
    const { agent, csrf } = orgAdmin;
    const office = await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send({ ...cameraBody(), name: "Office 57", host: "10.10.15.57" }).expect(201);
    const bad = await agent.patch("/api/settings/networks").set("X-CSRF-Token", csrf).send({ allowedNetworks: ["10.10.15.0/24", "0.0.0.0/0"] }).expect(400);
    expect(bad.body.error.details[0]).toMatchObject({ field: "allowedNetworks.1", message: expect.stringMatching(/too broad/) });
    await agent.patch("/api/settings/networks").set("X-CSRF-Token", csrf).send({ allowedNetworks: [] }).expect(400);

    try {
      const saved = await agent.patch("/api/settings/networks").set("X-CSRF-Token", csrf).send({ allowedNetworks: ["192.168.1.0/24"] }).expect(200);
      expect(saved.body).toMatchObject({ isDefault: false, allowedNetworks: ["192.168.1.0/24"] });
      expect(saved.body.camerasOutside).toEqual([{ id: office.body.id, name: "Office 57", host: "10.10.15.57" }]);
      const refused = await agent.post("/api/cameras/test-connection").set("X-CSRF-Token", csrf).send({ ...cameraBody(), host: "10.10.15.57" }).expect(200);
      expect(refused.body.error).toMatchObject({ code: "HOST_NOT_ALLOWED", message: expect.stringMatching(/Camera networks/) });

      const audit = await pool.query("SELECT details FROM audit_logs WHERE action = 'settings.networks_updated'");
      expect(audit.rows[0].details).toMatchObject({ to: ["192.168.1.0/24"] });
    } finally {
      await pool.query("DELETE FROM app_settings WHERE key = 'networks'");
      hostGuard.invalidate();
    }
  });

  it("downloads a camera status report with connection and SD card status, filtered and audited", async () => {
    const { agent, csrf } = await signIn("admin");
    const ok = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send({ ...cameraBody(), name: "Lobby" }).expect(201)).body.id;
    await agent.post(`/api/cameras/${ok}/check-storage`).set("X-CSRF-Token", csrf).expect(200);
    const nvr = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send({ ...cameraBody(), name: "Car park", host: "10.1.0.9", localStorage: false }).expect(201)).body.id;
    const down = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send({ ...cameraBody(), name: "Gate", host: "10.1.0.10" }).expect(201)).body.id;
    await pool.query("UPDATE camera_status SET connection_status = 'offline', last_success_at = now(), last_error_message = 'Camera did not respond' WHERE camera_id = $1", [down]);
    void nvr;

    const res = await agent.get("/api/cameras/report?timeZone=Asia/Calcutta&sort=name").expect(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toMatch(/attachment; filename="camera-status-report-\d{4}-\d{2}-\d{2}\.csv"/);
    const [header, ...rows] = res.text.replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(header).toContain("Camera,IP address,Port,Brand,Model,Location,Priority,Monitoring,Connection,SD card status");
    expect(header).toContain("Last successful check (Asia/Calcutta)");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/^Car park,10\.1\.0\.9,.*,On,Not checked yet,No local storage \(records elsewhere\),/);
    expect(rows[1]).toMatch(/^Gate,10\.1\.0\.10,.*,On,Offline,No SD card \(last known; camera offline\),.*Camera did not respond,Meets policy$/);
    expect(rows[2]).toMatch(/^Lobby,127\.0\.0\.1,.*,On,Online,Card OK,.*,Healthy,127\.9,/);
    expect(res.text).not.toContain("Cam-Pass-123");

    const offline = await agent.get("/api/cameras/report?status=offline").expect(200);
    expect(offline.text.trim().split("\r\n")).toHaveLength(2);
    const logged = (await pool.query("SELECT details FROM audit_logs WHERE action = 'camera.report_exported' ORDER BY id")).rows;
    expect(logged.map((r) => r.details)).toEqual([{ rows: 3 }, { rows: 1, status: "offline" }]);
    await agent.get("/api/cameras/report?timeZone=Mars/Olympus").expect(400);
  });

  it("lists the IDs of all cameras matching the filters, for Select all", async () => {
    const { agent, csrf } = await signIn("admin");
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      made.push((await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send({ ...cameraBody(), name: `Gate ${i}`, host: `10.1.0.${i + 1}`, location: i < 2 ? "Gate" : "Lobby" }).expect(201)).body.id);
    }
    expect((await agent.get("/api/cameras/ids?location=Gate&sort=name").expect(200)).body).toEqual({ ids: made.slice(0, 2), total: 2 });
    expect((await agent.get("/api/cameras/ids").expect(200)).body.total).toBe(3);
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

describe("camera priority", () => {
  it("lists critical-area cameras first, filters and counts them, and sets priority in bulk", async () => {
    const { agent, csrf } = await signIn("admin");
    const add = async (name: string, host: string, priority?: string) =>
      (await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send({ ...cameraBody(), name, host, ...(priority ? { priority } : {}) }).expect(201)).body.id as string;
    const a = await add("Alpha", "127.0.0.11");
    const z = await add("Zulu vault", "127.0.0.12", "critical");
    const b = await add("Bravo", "127.0.0.13");
    expect((await agent.get("/api/cameras").expect(200)).body.items.map((c: { name: string }) => c.name)).toEqual(["Zulu vault", "Alpha", "Bravo"]);
    expect((await agent.get("/api/cameras?priority=critical").expect(200)).body.items.map((c: { id: string }) => c.id)).toEqual([z]);
    await agent.post("/api/cameras/bulk-priority").set("X-CSRF-Token", csrf).send({ ids: [b], priority: "critical" }).expect(200);
    expect((await agent.get(`/api/cameras/${b}`).expect(200)).body.priority).toBe("critical");
    expect((await agent.get("/api/cameras/summary").expect(200)).body.criticalArea).toMatchObject({ total: 2 });
    await agent.patch(`/api/cameras/${z}`).set("X-CSRF-Token", csrf).send({ priority: "normal" }).expect(200);
    expect((await agent.get("/api/cameras?priority=critical").expect(200)).body.items.map((c: { id: string }) => c.id)).toEqual([b]);
    expect(a).toBeTruthy();
  });

  it("puts cameras in maintenance (Operators too, not Viewers) and shows it", async () => {
    const admin = await signIn("admin");
    const id = (await admin.agent.post("/api/cameras").set("X-CSRF-Token", admin.csrf).send(cameraBody()).expect(201)).body.id as string;
    const operator = await signIn("operator");
    await operator.agent.post("/api/cameras/bulk-maintenance").set("X-CSRF-Token", operator.csrf).send({ ids: [id], minutes: 120, note: "New switch" }).expect(200);
    const cam = (await admin.agent.get(`/api/cameras/${id}`).expect(200)).body;
    expect(cam.maintenance.note).toBe("New switch");
    expect(Date.parse(cam.maintenance.until) - Date.now()).toBeGreaterThan(115 * 60_000);
    const viewer = await signIn("viewer");
    await viewer.agent.post("/api/cameras/bulk-maintenance").set("X-CSRF-Token", viewer.csrf).send({ ids: [id], minutes: null }).expect(403);
    await admin.agent.post("/api/cameras/bulk-maintenance").set("X-CSRF-Token", admin.csrf).send({ ids: [id], minutes: 5 }).expect(400); // at least 15 minutes
    await operator.agent.post("/api/cameras/bulk-maintenance").set("X-CSRF-Token", operator.csrf).send({ ids: [id], minutes: null }).expect(200);
    expect((await admin.agent.get(`/api/cameras/${id}`).expect(200)).body.maintenance).toBeNull();
  });
});

describe("camera password policy", () => {
  it("flags weak and old camera passwords, filters them, and blocks them when the policy says so", async () => {
    const { agent, csrf, username } = await signIn("admin");
    const weak = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send({ ...cameraBody(), password: "lobbycam77" }).expect(201)).body.id;
    const strong = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send({ ...cameraBody(), name: "Gate", host: "127.0.0.2", password: "Gate#Cam2026x" }).expect(201)).body.id;
    expect((await agent.get(`/api/cameras/${weak}`).expect(200)).body.password).toMatchObject({ status: "weak", issues: ["few_char_types"] });
    expect((await agent.get(`/api/cameras/${strong}`).expect(200)).body.password.status).toBe("ok");
    expect((await agent.get("/api/cameras?password=weak").expect(200)).body.items.map((c: { id: string }) => c.id)).toEqual([weak]);
    await agent.delete("/api/auth/confirm-password").set("X-CSRF-Token", csrf).expect(204);
    expect((await agent.get("/api/auth/confirm-password").expect(200)).body.until).toBeNull();
    // Locked Settings: every change is refused, reading other settings still works.
    expect((await agent.patch("/api/settings/monitoring").set("X-CSRF-Token", csrf).send({ warningThreshold: 70 }).expect(403)).body.error.code).toBe("PASSWORD_CONFIRMATION_REQUIRED");
    await agent.post("/api/users").set("X-CSRF-Token", csrf).send({}).expect(403);
    await agent.patch("/api/ai/settings").set("X-CSRF-Token", csrf).send({ enabled: true }).expect(403);
    await agent.get("/api/settings/monitoring").expect(200);
    // The rules for typing a camera password stay readable; the page itself is locked until the
    // user enters their password again.
    expect((await agent.get("/api/settings/camera-password-rules").expect(200)).body.policy.minLength).toBe(8);
    expect((await agent.get("/api/settings/camera-password-policy").expect(403)).body.error.code).toBe("PASSWORD_CONFIRMATION_REQUIRED");
    await agent.patch("/api/settings/camera-password-policy").set("X-CSRF-Token", csrf).send({ minLength: 10 }).expect(403);
    await agent.post("/api/auth/confirm-password").set("X-CSRF-Token", csrf).send({ password: "wrong" }).expect(400);
    await agent.get("/api/settings/camera-password-policy").expect(403);
    const { until } = (await agent.post("/api/auth/confirm-password").set("X-CSRF-Token", csrf).send({ password: PASSWORD }).expect(200)).body;
    expect(Date.parse(until) - Date.now()).toBeGreaterThan(14 * 60_000);
    expect((await agent.get("/api/auth/confirm-password").expect(200)).body.until).toBe(until);
    expect((await agent.get("/api/settings/camera-password-policy").expect(200)).body.counts).toEqual({ ok: 1, weak: 1, expired: 0 });
    // Only for this session, and only for a while.
    const other = request.agent(app);
    await other.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
    await other.get("/api/settings/camera-password-policy").expect(403);
    await pool.query("UPDATE sessions SET password_confirmed_at = now() - interval '16 minutes' WHERE password_confirmed_at IS NOT NULL");
    await agent.get("/api/settings/camera-password-policy").expect(403);
    await agent.post("/api/auth/confirm-password").set("X-CSRF-Token", csrf).send({ password: PASSWORD }).expect(200);

    // Older than the maximum age: due a change.
    await pool.query("UPDATE camera_credentials SET password_changed_at = now() - interval '100 days' WHERE camera_id = $1", [strong]);
    expect((await agent.get(`/api/cameras/${strong}`).expect(200)).body.password.status).toBe("expired");

    // A policy change re-checks the stored passwords; "block" refuses weak new ones.
    await agent.patch("/api/settings/camera-password-policy").set("X-CSRF-Token", csrf).send({ minCharTypes: 2, enforcement: "block" }).expect(200);
    expect((await agent.get(`/api/cameras/${weak}`).expect(200)).body.password.status).toBe("ok");
    const refused = await agent.patch(`/api/cameras/${strong}`).set("X-CSRF-Token", csrf).send({ password: "12345" }).expect(400);
    expect(refused.body.error.details[0]).toMatchObject({ field: "password" });
    await agent.patch(`/api/cameras/${strong}`).set("X-CSRF-Token", csrf).send({ password: "New#Gate2026" }).expect(200);
    expect((await agent.get(`/api/cameras/${strong}`).expect(200)).body.password.status).toBe("ok");
  });
});

describe("live view", () => {
  it("returns the camera's current picture to Org Admins and Operators, and logs the viewing", async () => {
    const { agent, csrf } = await signIn("admin");
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send(cameraBody()).expect(201)).body.id;
    const res = await agent.get(`/api/cameras/${id}/snapshot?start=1`).buffer(true).expect(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect([res.body[0], res.body[1]]).toEqual([0xff, 0xd8]);
    await agent.get(`/api/cameras/${id}/snapshot`).expect(200);
    const logged = await pool.query("SELECT entity_id FROM audit_logs WHERE action = 'camera.live_view'");
    expect(logged.rows).toEqual([{ entity_id: id }]);

    const operator = await signIn("operator");
    await operator.agent.get(`/api/cameras/${id}/snapshot`).expect(200);
    const viewer = await signIn("viewer");
    await viewer.agent.get(`/api/cameras/${id}/snapshot`).expect(403);
  });

  it("explains when the camera cannot give a picture", async () => {
    const { agent, csrf } = await signIn("admin");
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send(cameraBody()).expect(201)).body.id;
    cam.mode = "auth-fail";
    expect((await agent.get(`/api/cameras/${id}/snapshot`).expect(422)).body.error.code).toBe("AUTH_FAILED");
    cam.mode = "not-found";
    expect((await agent.get(`/api/cameras/${id}/snapshot`).expect(422)).body.error.code).toBe("API_UNAVAILABLE");
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

  it("exports the audit log as CSV, in the viewer's time zone, and audits the export", async () => {
    const { agent, csrf } = await signIn("admin");
    const id = (await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send({ ...cameraBody(), name: "=Lobby, \"east\"" }).expect(201)).body.id;
    await pool.query("UPDATE audit_logs SET created_at = '2026-10-21T20:00:00Z' WHERE entity_id = $1", [id]);

    const res = await agent.get("/api/audit/export?timeZone=Asia/Kolkata&from=2026-10-22&to=2026-10-22").expect(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="audit-log-2026-10-22-to-2026-10-22.csv"');
    const lines = res.text.replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Time (Asia/Kolkata),User,Action,Camera,Camera IP,Entity type,Entity ID,Details,IP");
    // 20:00 UTC on the 21st is 01:30 on the 22nd in India; the formula-like name is neutralised and quoted.
    expect(lines.find((l) => l.includes("camera.created"))).toMatch(/^2026-10-22 01:30:00,admin-user,camera\.created,"'=Lobby, ""east""",127\.0\.0\.1,camera,/);
    expect(res.text).not.toContain("Cam-Pass-123");
    // Outside the range: not included.
    const before = await agent.get("/api/audit/export?timeZone=UTC&to=2026-10-20").expect(200);
    expect(before.text).not.toContain("camera.created");

    const exported = (await pool.query("SELECT details FROM audit_logs WHERE action = 'audit.exported' ORDER BY id")).rows;
    expect(exported[0].details).toMatchObject({ from: "2026-10-22", to: "2026-10-22" });
    // Browsers report India as the legacy Asia/Calcutta, which PostgreSQL does not know.
    expect((await agent.get("/api/audit/export?timeZone=Asia/Calcutta&from=2026-10-22&to=2026-10-22").expect(200)).text).toContain("2026-10-22 01:30:00,admin-user,camera.created");
    // The list on the page filters by the same days.
    const day = (await agent.get("/api/audit?timeZone=Asia/Kolkata&from=2026-10-22&to=2026-10-22").expect(200)).body;
    expect(day.items.map((a: { action: string }) => a.action)).toEqual(["camera.created"]);
    expect(day.total).toBe(1);
    expect((await agent.get("/api/audit?timeZone=UTC&from=2026-10-22&to=2026-10-22").expect(200)).body.total).toBe(0);
    await agent.get("/api/audit?from=2026-10-23&to=2026-10-22").expect(400);
    await agent.get("/api/audit/export?timeZone=Mars/Olympus").expect(400);
    await agent.get("/api/audit/export?from=2026-10-23&to=2026-10-22").expect(400);
    await (await signIn("viewer")).agent.get("/api/audit/export").expect(403);
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
