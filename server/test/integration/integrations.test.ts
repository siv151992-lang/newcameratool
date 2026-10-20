import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { registry } from "../../src/integrations/registry.js";
import { runCheck } from "../../src/monitoring/checkService.js";
import { Scheduler } from "../../src/monitoring/scheduler.js";
import { MockVendorCamera } from "../../src/testing/mockVendor.js";
import { createTestUser, PASSWORD, prepareDb, resetData } from "../helpers.js";

const app = createApp();
const vendor = new MockVendorCamera();
let port: number;
const deps = { registry, notifier: { dispatch: async () => undefined }, sleep: async () => undefined };

async function signIn(role: "admin" | "operator" | "viewer") {
  const { username } = await createTestUser(role);
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({ username, password: PASSWORD }).expect(200);
  return { agent, csrf: res.body.csrfToken as string };
}

const acmeConfig = (devicesPath = "storage.devices") => ({
  request: { method: "GET", path: "/api/v1/storage", query: [], headers: [{ name: "X-Requested-With", value: "cctv-monitor" }], timeoutMs: 5000 },
  auth: { type: "digest" },
  pagination: { type: "page", pageParam: "page", firstPage: 1, maxPages: 3 },
  response: {
    format: "json",
    devicesPath,
    fields: { id: "slot", name: "label", total: { path: "sizeMiB", unit: "MiB" }, free: { path: "freeMiB", unit: "MiB" }, health: "state", readWrite: "access" },
    healthValues: { healthy: ["normal"], degraded: ["formatting"], unhealthy: ["error", "broken"], absent: ["nocard"] },
    readWriteValues: { readWrite: ["RW"], readOnly: ["RO"] },
  },
  deviceInfo: { path: "/api/v1/system", query: [], format: "json", fields: { model: "system.model", serialNumber: "system.serial", firmwareVersion: "system.firmware" } },
});

const details = { displayName: "Acme Vision", manufacturer: "Acme Corp", description: "Acme JSON storage API", supportedModels: ["AV-200"], defaultHttpPort: 80, integrationVersion: "1.0" };
const target = () => ({ host: "127.0.0.1", port, protocol: "http", username: "admin", password: "Acme-Passw0rd!" });

beforeAll(async () => {
  await prepareDb();
  port = await vendor.start();
});
afterAll(() => vendor.stop());
beforeEach(async () => {
  await resetData();
  vendor.mode = "ok";
});

describe("configurable brand integrations", () => {
  it("goes from draft to tested to enabled, and monitors cameras through the common storage model", async () => {
    const { agent, csrf } = await signIn("admin");
    const post = (url: string, body: unknown = {}) => agent.post(url).set("X-CSRF-Token", csrf).send(body as object);

    const created = await post("/api/integrations", { details, config: acmeConfig() }).expect(201);
    expect(created.body).toMatchObject({ key: "acme-vision", status: "draft", integrationType: "configurable", latestVersion: 1, activeVersion: null, credentials: "user_password" });
    // Saving an unchanged configuration adds no version (stored jsonb reorders keys).
    const same = await agent.patch("/api/integrations/acme-vision").set("X-CSRF-Token", csrf).send({ details, config: acmeConfig() }).expect(200);
    expect(same.body.latestVersion).toBe(1);

    // Not usable until tested and enabled.
    expect((await agent.get("/api/brands").expect(200)).body.map((b: { key: string }) => b.key)).not.toContain("acme-vision");
    const early = await post("/api/cameras", { name: "Gate", host: "127.0.0.1", port, brand: "acme-vision", username: "admin", password: "x" }).expect(400);
    expect(early.body.error.message).toMatch(/not enabled yet \(draft\)/);
    expect((await post("/api/integrations/acme-vision/enable").expect(409)).body.error.code).toBe("NOT_TESTED");

    // Failure categories, with sanitised output.
    const badAuth = await post("/api/integrations/acme-vision/test", { target: { ...target(), password: "wrong-secret-1" } }).expect(200);
    expect(badAuth.body).toMatchObject({ ok: false, outcome: "AUTH_FAILURE" });
    expect(JSON.stringify(badAuth.body)).not.toContain("wrong-secret-1");
    const outside = await post("/api/integrations/acme-vision/test", { target: { ...target(), host: "8.8.8.8" } }).expect(200);
    expect(outside.body.outcome).toBe("DESTINATION_NOT_ALLOWED");
    const metadata = await post("/api/integrations/acme-vision/test", { target: { ...target(), host: "169.254.169.254" } }).expect(200);
    expect(metadata.body.outcome).toBe("DESTINATION_NOT_ALLOWED");
    vendor.mode = "garbage";
    expect((await post("/api/integrations/acme-vision/test", { target: target() })).body.outcome).toBe("INVALID_FORMAT");
    vendor.mode = "server-error";
    expect((await post("/api/integrations/acme-vision/test", { target: target() })).body.outcome).toBe("HTTP_FAILURE");
    vendor.mode = "ok";

    const ok = await post("/api/integrations/acme-vision/test", { target: target() }).expect(200);
    expect(ok.body).toMatchObject({ ok: true, outcome: "OK", version: 1, deviceInfo: { model: "SIMULATED-ACME", firmwareVersion: "2.4.1" } });
    expect(ok.body.storage).toMatchObject({ totalBytes: 122_070 * 1024 ** 2, freeBytes: 30_517 * 1024 ** 2 });
    expect(ok.body.mapping.devices[1].skipped).toMatch(/no disk/);
    expect(ok.body.sample).toContain('"apiToken": "[REDACTED]"');
    expect(JSON.stringify(ok.body)).not.toContain("Acme-Passw0rd!");
    expect(ok.body.steps.map((s: { status: string }) => s.status)).toEqual(["passed", "passed", "passed", "passed", "passed"]);

    const tested = await agent.get("/api/integrations/acme-vision").expect(200);
    expect(tested.body).toMatchObject({ status: "tested", lastTestOk: true, versions: [{ version: 1, testStatus: "passed" }] });

    const enabled = await post("/api/integrations/acme-vision/enable").expect(200);
    expect(enabled.body).toMatchObject({ status: "enabled", activeVersion: 1 });
    const brands = (await agent.get("/api/brands").expect(200)).body;
    expect(brands.find((b: { key: string }) => b.key === "acme-vision")).toMatchObject({ displayName: "Acme Vision", integrationType: "configurable", credentials: "user_password" });

    // A camera of the new brand is monitored like any other.
    const cam = await post("/api/cameras", { name: "Gate", host: "127.0.0.1", port, brand: "Acme Vision", username: "admin", password: "Acme-Passw0rd!" }).expect(201);
    expect(cam.body.brand).toBe("acme-vision");
    const outcome = await runCheck(cam.body.id, "manual", deps);
    expect(outcome).toMatchObject({ status: "completed", result: { ok: true } });
    const status = await agent.get(`/api/cameras/${cam.body.id}`).expect(200);
    expect(status.body.status).toMatchObject({ connection: "online", storageHealth: "healthy" });
    expect(status.body.status.usedPercentage).toBeCloseTo(75, 0);
    const check = await pool.query("SELECT integration_version, devices FROM storage_checks WHERE camera_id = $1", [cam.body.id]);
    expect(check.rows[0].integration_version).toBe("1.0 (config 1)");
    expect(vendor.requests.some((r) => r.path === "/api/v1/storage?page=1" && r.authorized)).toBe(true);

    // Editing creates a new draft version; the tested one keeps monitoring.
    const edited = await agent.patch("/api/integrations/acme-vision").set("X-CSRF-Token", csrf).send({ config: acmeConfig("storage.missing"), changeNote: "wrong path" }).expect(200);
    expect(edited.body).toMatchObject({ status: "enabled", activeVersion: 1, latestVersion: 2, latestVersionStatus: "untested" });
    const v2 = await post("/api/integrations/acme-vision/test", { target: { cameraId: cam.body.id } }).expect(200);
    expect(v2.body).toMatchObject({ ok: false, outcome: "NO_STORAGE_DATA", version: 2 });
    expect((await post("/api/integrations/acme-vision/enable", { versionId: edited.body.versions[0].id }).expect(409)).body.error.code).toBe("NOT_TESTED");
    expect((await runCheck(cam.body.id, "manual", deps)).result?.ok).toBe(true);

    // Disabling stops scheduled monitoring but keeps the camera and its history.
    const disabled = await post("/api/integrations/acme-vision/disable").expect(200);
    expect(disabled.body.impact).toEqual({ cameras: 1, monitored: 1 });
    await pool.query("UPDATE camera_status SET next_check_at = now() - interval '1 minute'");
    expect(await new Scheduler(deps, { owner: "t" }).tick()).toEqual([]);
    expect((await pool.query("SELECT count(*)::int AS n FROM storage_checks WHERE camera_id = $1", [cam.body.id])).rows[0].n).toBe(2);

    // Re-enabling uses the tested configuration that was in use, not the newer untested draft.
    const reenabled = await post("/api/integrations/acme-vision/enable").expect(200);
    expect(reenabled.body).toMatchObject({ status: "enabled", activeVersion: 1, latestVersion: 2 });

    // Deleting needs the cameras moved first.
    expect((await agent.delete("/api/integrations/acme-vision").set("X-CSRF-Token", csrf).expect(409)).body.error.code).toBe("IN_USE");
    expect((await post("/api/integrations/acme-vision/reassign", { toKey: "hikvision" }).expect(200)).body).toEqual({ moved: 1 });
    await agent.delete("/api/integrations/acme-vision").set("X-CSRF-Token", csrf).expect(204);
    expect((await agent.get("/api/integrations").expect(200)).body.map((b: { key: string }) => b.key)).not.toContain("acme-vision");

    const actions = (await pool.query("SELECT action FROM audit_logs WHERE entity_type = 'integration' ORDER BY created_at")).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["integration.created", "integration.tested", "integration.enabled", "integration.updated", "integration.disabled", "integration.cameras_reassigned", "integration.deleted"]));
    const auditText = JSON.stringify((await pool.query("SELECT details FROM audit_logs")).rows);
    expect(auditText).not.toContain("Acme-Passw0rd!");
  });

  it("validates configurations and previews XML and JSON mappings without contacting a camera", async () => {
    const { agent, csrf } = await signIn("admin");
    const post = (url: string, body: unknown) => agent.post(url).set("X-CSRF-Token", csrf).send(body as object);
    const invalid = await post("/api/integrations/validate", { config: { ...acmeConfig(), request: { method: "GET", path: "http://169.254.169.254/latest", query: [], headers: [], timeoutMs: 5000 } } }).expect(200);
    expect(invalid.body.valid).toBe(false);
    expect(invalid.body.issues[0]).toMatchObject({ field: "request.path" });
    await post("/api/integrations", { details, config: { ...acmeConfig(), auth: { type: "ntlm" } } }).expect(400);

    const xmlConfig = {
      ...acmeConfig(),
      response: {
        format: "xml",
        devicesPath: "Storage.Disks.Disk",
        fields: { id: "@slot", name: "Label", total: { path: "SizeMiB", unit: "MiB" }, free: { path: "FreeMiB", unit: "MiB" }, health: "State" },
        healthValues: { healthy: ["Normal"], degraded: [], unhealthy: [], absent: ["NoCard"] },
        readWriteValues: { readWrite: [], readOnly: [] },
      },
    };
    const sample = `<acme:Storage xmlns:acme="urn:acme"><Disks><Disk slot="sd0"><Label>microSD</Label><SizeMiB>1000</SizeMiB><FreeMiB>250</FreeMiB><State>Normal</State></Disk></Disks></acme:Storage>`;
    const preview = await post("/api/integrations/preview", { config: xmlConfig, sample }).expect(200);
    expect(preview.body).toMatchObject({ ok: true, mapping: { reading: { totalBytes: 1000 * 1024 ** 2, usedPercentage: 75 } } });
    const broken = await post("/api/integrations/preview", { config: xmlConfig, sample: "<a><b></a>" }).expect(200);
    expect(broken.body).toMatchObject({ ok: false, stage: "format" });
    const missing = await post("/api/integrations/preview", { config: xmlConfig, sample: sample.replace(/<SizeMiB>1000<\/SizeMiB>/, "") }).expect(200);
    expect(missing.body.mapping.missing).toEqual(["Total capacity"]);
  });

  it("prevents duplicates, protects built-in adapters and restricts management to administrators", async () => {
    const admin = await signIn("admin");
    const post = (url: string, body: unknown = {}) => admin.agent.post(url).set("X-CSRF-Token", admin.csrf).send(body as object);
    await post("/api/integrations", { details, config: acmeConfig() }).expect(201);
    expect((await post("/api/integrations", { details: { ...details, displayName: "acme  vision" }, config: acmeConfig() }).expect(409)).body.error.message).toMatch(/already registered/);
    expect((await post("/api/integrations", { details: { ...details, displayName: "Hikvision" }, config: acmeConfig() }).expect(409)).body.error.code).toBe("CONFLICT");

    const list = (await admin.agent.get("/api/integrations").expect(200)).body;
    expect(list.find((b: { key: string }) => b.key === "hikvision")).toMatchObject({ integrationType: "builtin", status: "enabled", integrationVersion: "1.0.0" });
    expect((await admin.agent.delete("/api/integrations/hikvision").set("X-CSRF-Token", admin.csrf).expect(400)).body.error.code).toBe("BUILTIN_INTEGRATION");
    await admin.agent.patch("/api/integrations/hikvision").set("X-CSRF-Token", admin.csrf).send({ config: acmeConfig() }).expect(400);

    // A disabled built-in integration cannot take new cameras until it is enabled again.
    await post("/api/integrations/hikvision/disable").expect(200);
    const refused = await post("/api/cameras", { name: "Lobby", host: "10.10.15.9", brand: "hikvision", username: "admin", password: "pw-123456" }).expect(400);
    expect(refused.body.error.message).toMatch(/disabled/);
    await post("/api/integrations/hikvision/enable").expect(200);
    await post("/api/cameras", { name: "Lobby", host: "10.10.15.9", brand: "hikvision", username: "admin", password: "pw-123456" }).expect(201);

    const operator = await signIn("operator");
    await operator.agent.get("/api/integrations").expect(200);
    await operator.agent.post("/api/integrations").set("X-CSRF-Token", operator.csrf).send({ details, config: acmeConfig() }).expect(403);
    await operator.agent.post("/api/integrations/acme-vision/test").set("X-CSRF-Token", operator.csrf).send({ target: target() }).expect(403);
    const viewer = await signIn("viewer");
    await viewer.agent.get("/api/integrations").expect(403);
  });
});

describe("integration safety checks", () => {
  /** Inserts an enabled configurable integration directly (as if it had passed a test). */
  async function enabledBrand(key: string, auth: object) {
    await pool.query(
      `INSERT INTO camera_brands (key, display_name, support_status, integration_type, status) VALUES ($1, $1, 'supported', 'configurable', 'enabled')`,
      [key],
    );
    const v = await pool.query(
      "INSERT INTO brand_integration_versions (brand_key, version, config, test_status) VALUES ($1, 1, $2, 'passed') RETURNING id",
      [key, JSON.stringify({ ...acmeConfig(), auth })],
    );
    await pool.query("UPDATE camera_brands SET active_version_id = $2 WHERE key = $1", [key, v.rows[0].id]);
    await registry.refresh();
  }

  it("redacts values mapped from sensitive fields wherever they appear in a test result", async () => {
    const { agent, csrf } = await signIn("admin");
    const post = (url: string, body: unknown = {}) => agent.post(url).set("X-CSRF-Token", csrf).send(body as object);
    const cfg = acmeConfig();
    const leaky = { ...cfg, pagination: { type: "none" }, response: { ...cfg.response, devicesPath: "", fields: { ...cfg.response.fields, id: undefined, name: "apiToken", total: { path: "storage.devices[0].sizeMiB", unit: "MiB" }, free: { path: "storage.devices[0].freeMiB", unit: "MiB" }, health: undefined, readWrite: undefined } } };
    await post("/api/integrations", { details, config: leaky }).expect(201);
    const r = await post("/api/integrations/acme-vision/test", { target: target() }).expect(200);
    expect(r.body.ok).toBe(true);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("do-not-show-this");
    expect(r.body.mapping.devices[0].fields.find((f: { field: string }) => f.field === "Device name").raw).toBe("[REDACTED]");
    const stored = await pool.query("SELECT message, steps, storage FROM brand_integration_tests");
    expect(JSON.stringify(stored.rows)).not.toContain("do-not-show-this");
  });

  it("asks for new credentials when a camera moves to a brand with a different login, and refuses such reassignments", async () => {
    const { agent, csrf } = await signIn("admin");
    await enabledBrand("open-cam", { type: "none" });
    await enabledBrand("token-cam", { type: "bearer" });
    expect((await agent.get("/api/brands").expect(200)).body.find((b: { key: string }) => b.key === "open-cam")).toMatchObject({ credentials: "none" });

    // No credentials needed for an unauthenticated integration.
    const open = await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send({ name: "Open", host: "10.10.15.20", brand: "open-cam" }).expect(201);
    const toHik = await agent.patch(`/api/cameras/${open.body.id}`).set("X-CSRF-Token", csrf).send({ brand: "hikvision" }).expect(400);
    expect(toHik.body.error.details.map((d: { field: string }) => d.field)).toEqual(["username", "password"]);
    await agent.patch(`/api/cameras/${open.body.id}`).set("X-CSRF-Token", csrf).send({ brand: "hikvision", username: "admin", password: "New-Pass-123" }).expect(200);
    const tokenless = await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send({ name: "Tok", host: "10.10.15.21", brand: "token-cam" }).expect(400);
    expect(tokenless.body.error.message).toMatch(/API key or token is required/);

    await agent.post("/api/cameras").set("X-CSRF-Token", csrf).send({ name: "Open 2", host: "10.10.15.22", brand: "open-cam" }).expect(201);
    expect((await agent.post("/api/integrations/open-cam/reassign").set("X-CSRF-Token", csrf).send({ toKey: "hikvision" }).expect(409)).body.error.code).toBe("CREDENTIALS_MISMATCH");
  });
});
