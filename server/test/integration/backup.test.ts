import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { pool } from "../../src/db/pool.js";
import { migrate } from "../../src/db/migrate.js";
import { inspectBackup, pruneBackups, restoreBackup, writeBackup } from "../../src/services/backupService.js";
import { createCamera } from "../../src/services/cameraService.js";
import { createTestUser, PASSWORD, prepareDb, resetData, testOrgId } from "../helpers.js";

const dir = mkdtempSync(join(tmpdir(), "cctv-backup-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeAll(prepareDb);
beforeEach(resetData);

const count = async (sql: string) => (await pool.query<{ n: number }>(sql)).rows[0]!.n;

async function seed() {
  const admin = await createTestUser("admin", "owner", undefined, { systemAdmin: true });
  const cam = await createCamera(
    testOrgId,
    { name: "Gate", host: "10.9.0.5", port: 80, protocol: "http", brand: "hikvision", model: null, location: "Site A", username: "admin",
      password: "Secret-Cam-Pass-1", monitoringEnabled: true, warningThreshold: null, criticalThreshold: null, caCertificate: null },
    admin,
  );
  await pool.query("INSERT INTO alerts (camera_id, type, severity, status, title, description) VALUES ($1, 'offline', 'critical', 'active', 'Camera offline', 'x')", [cam]);
  // A brand that refers to another brand (the one table that refers to itself).
  await pool.query(`INSERT INTO camera_brands (key, display_name, support_status, auth_methods, default_http_port, default_https_port, capabilities, notes, integration_type, based_on, status)
    VALUES ('acme', 'Acme', 'supported', '{digest}', 80, 443, '{}', 'x', 'alias', 'hikvision', 'enabled')`);
  return { admin, cam };
}

describe("backups", () => {
  it("backs up every table in one file and restores it exactly, all or nothing", async () => {
    const { cam } = await seed();
    const before = {
      cameras: await count("SELECT count(*)::int AS n FROM cameras"),
      users: await count("SELECT count(*)::int AS n FROM users"),
      alerts: await count("SELECT count(*)::int AS n FROM alerts"),
      audit: await count("SELECT count(*)::int AS n FROM audit_logs"),
      cred: (await pool.query("SELECT password_encrypted FROM camera_credentials WHERE camera_id = $1", [cam])).rows[0],
    };
    const r = await writeBackup(dir);
    expect(r.file).toMatch(/^cctv-backup-\d{8}-\d{6}\.json\.gz$/);
    const { header, counts } = await inspectBackup(join(dir, r.file));
    expect(header).toMatchObject({ format: "cctv-monitor-backup", version: 1 });
    expect(header.tables).not.toContain("sessions");
    expect(counts.cameras).toBe(1);

    // Things change after the backup...
    await pool.query("DELETE FROM alerts");
    await pool.query("UPDATE cameras SET name = 'Renamed'");
    await createTestUser("viewer", "later");

    await restoreBackup(join(dir, r.file), pool);
    await migrate(pool);
    expect(await count("SELECT count(*)::int AS n FROM cameras")).toBe(before.cameras);
    expect(await count("SELECT count(*)::int AS n FROM users")).toBe(before.users);
    expect(await count("SELECT count(*)::int AS n FROM alerts")).toBe(before.alerts);
    expect(await count("SELECT count(*)::int AS n FROM audit_logs")).toBe(before.audit);
    expect((await pool.query("SELECT name FROM cameras")).rows[0].name).toBe("Gate");
    expect((await pool.query("SELECT password_encrypted FROM camera_credentials WHERE camera_id = $1", [cam])).rows[0]).toEqual(before.cred);
    expect((await pool.query("SELECT based_on FROM camera_brands WHERE key = 'acme'")).rows[0].based_on).toBe("hikvision");
    // Counters continue after the restored rows; sessions are not restored.
    const maxId = (await pool.query("SELECT max(id) AS m FROM alerts")).rows[0].m;
    const next = await pool.query("INSERT INTO alerts (camera_id, type, severity, status, title, description) VALUES ($1, 'not_recording', 'warning', 'active', 't', 'd') RETURNING id", [cam]);
    expect(Number(next.rows[0].id)).toBeGreaterThan(Number(maxId));
    expect(await count("SELECT count(*)::int AS n FROM sessions")).toBe(0);
    // And people sign in as before.
    await request(createApp()).post("/api/auth/login").send({ username: "owner", password: PASSWORD }).expect(200);
  });

  it("refuses a cut-off file or one from a newer version, without touching the database", async () => {
    await seed();
    const r = await writeBackup(dir);
    const lines = gunzipSync(readFileSync(join(dir, r.file))).toString().trim().split("\n");
    const cut = join(dir, "cut.json.gz");
    writeFileSync(cut, gzipSync(lines.slice(0, -1).join("\n")));
    await expect(restoreBackup(cut, pool)).rejects.toThrow(/incomplete/);
    const newer = join(dir, "newer.json.gz");
    const head = JSON.parse(lines[0]!);
    writeFileSync(newer, gzipSync([JSON.stringify({ ...head, migrations: [...head.migrations, "999_future.sql"] }), ...lines.slice(1)].join("\n")));
    await expect(restoreBackup(newer, pool)).rejects.toThrow(/newer version/);
    expect(await count("SELECT count(*)::int AS n FROM cameras")).toBe(1);
  });

  it("keeps backups for the chosen days, always the newest, and only its own files", () => {
    const p = mkdtempSync(join(tmpdir(), "cctv-prune-"));
    const old = Date.now() / 1000 - 30 * 86400;
    for (const n of ["cctv-backup-20260101-020000.json.gz", "cctv-backup-20260102-020000.json.gz", "notes.txt"]) {
      writeFileSync(join(p, n), "x");
      utimesSync(join(p, n), old, old);
    }
    expect(pruneBackups(p, 14)).toEqual(["cctv-backup-20260101-020000.json.gz"]);
    expect(readdirSync(p).sort()).toEqual(["cctv-backup-20260102-020000.json.gz", "notes.txt"]);
    rmSync(p, { recursive: true, force: true });
  });

  it("is run and listed by the super admin from Settings, and the system health shows it", async () => {
    await createTestUser("admin", "owner", undefined, { systemAdmin: true });
    await createTestUser("admin", "org-admin");
    const agent = request.agent(createApp());
    const login = await agent.post("/api/auth/login").send({ username: "owner", password: PASSWORD }).expect(200);
    const csrf = login.body.csrfToken;
    await agent.post("/api/auth/confirm-password").set("X-CSRF-Token", csrf).send({ password: PASSWORD }).expect(200);
    await agent.patch("/api/settings/backup").set("X-CSRF-Token", csrf).send({ folder: dir, keepDays: 7 }).expect(200);
    await agent.patch("/api/settings/backup").set("X-CSRF-Token", csrf).send({ folder: "relative/path" }).expect(400);
    const made = (await agent.post("/api/settings/backup/run").set("X-CSRF-Token", csrf).expect(200)).body;
    const view = (await agent.get("/api/settings/backup").expect(200)).body;
    expect(view.files.map((f: { name: string }) => f.name)).toContain(made.file);
    expect(view.status.lastFile).toBe(made.file);
    const health = (await agent.get("/api/settings/health").expect(200)).body;
    expect(health.items.find((i: { key: string }) => i.key === "backup")).toMatchObject({ status: "ok" });
    expect(health.items.find((i: { key: string }) => i.key === "database")).toMatchObject({ status: "ok" });
    expect((await pool.query("SELECT action FROM audit_logs WHERE action LIKE 'settings.backup%' ORDER BY id")).rows.map((r) => r.action)).toEqual(["settings.backup_updated", "settings.backup_made"]);

    // An Org Admin who is not the super admin cannot.
    const other = request.agent(createApp());
    const l2 = await other.post("/api/auth/login").send({ username: "org-admin", password: PASSWORD }).expect(200);
    await other.post("/api/auth/confirm-password").set("X-CSRF-Token", l2.body.csrfToken).send({ password: PASSWORD }).expect(200);
    await other.get("/api/settings/backup").expect(403);
    await other.get("/api/settings/health").expect(403);
    await pool.query("DELETE FROM app_settings WHERE key IN ('backup', 'backup_status')");
  });
});
