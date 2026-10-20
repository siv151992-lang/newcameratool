import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool.js";
import { createRegistry } from "../../src/integrations/registry.js";
import { runCheck } from "../../src/monitoring/checkService.js";
import { Scheduler } from "../../src/monitoring/scheduler.js";
import type { NotificationEvent } from "../../src/notifications/types.js";
import { createCamera, removeCameras } from "../../src/services/cameraService.js";
import { updateMonitoringSettings } from "../../src/services/settingsService.js";
import { MockHikvisionCamera } from "../../src/testing/mockHikvision.js";
import { createTestUser, prepareDb, resetData } from "../helpers.js";

const registry = createRegistry();
const sent: NotificationEvent[] = [];
const deps = { registry, notifier: { dispatch: async (e: NotificationEvent[]) => void sent.push(...e) }, sleep: async () => undefined };

const cam = new MockHikvisionCamera("admin", "Cam-Pass-123");
let port: number;
let actor: { id: string; username: string };

async function addCamera(overrides: Record<string, unknown> = {}) {
  return createCamera(
    {
      name: "Reception", host: "127.0.0.1", port, protocol: "http", brand: "hikvision", model: null, location: "Lobby",
      username: "admin", password: "Cam-Pass-123", monitoringEnabled: true, warningThreshold: null, criticalThreshold: null,
      caCertificate: null, ...overrides,
    },
    actor,
  );
}
const status = async (id: string) => (await pool.query("SELECT * FROM camera_status WHERE camera_id = $1", [id])).rows[0];
const alerts = async (id: string) =>
  (await pool.query("SELECT type, severity, status, occurrence_count FROM alerts WHERE camera_id = $1 ORDER BY id", [id])).rows;

beforeAll(async () => {
  await prepareDb();
  port = await cam.start();
});
afterAll(async () => {
  await cam.stop();
});
beforeEach(async () => {
  await resetData();
  actor = await createTestUser("admin");
  cam.mode = "ok";
  cam.recording = "recording";
  cam.setDisks([{ id: 1, name: "hdde", status: "ok", capacityMb: 121942, freeMb: 56362, property: "RW", formatType: "EXT4" }]);
  sent.length = 0;
});

describe("storage checks", () => {
  it("retrieves storage, stores current status, devices and history", async () => {
    const id = await addCamera();
    const outcome = await runCheck(id, "manual", deps);
    expect(outcome.status).toBe("completed");
    expect(outcome.result?.ok).toBe(true);

    const s = await status(id);
    expect(s).toMatchObject({ connection_status: "online", storage_health: "healthy", used_percentage: 53.78, consecutive_failures: 0 });
    expect(s.total_bytes).toBe(121942 * 1024 * 1024);
    expect(s.device_model).toBe("SIMULATED-HIKVISION");
    const devices = (await pool.query("SELECT vendor_id, raw_status FROM storage_devices WHERE camera_id = $1", [id])).rows;
    expect(devices).toEqual([{ vendor_id: "hdd-1", raw_status: "ok" }]);
    const history = (await pool.query("SELECT outcome, trigger FROM storage_checks WHERE camera_id = $1", [id])).rows;
    expect(history).toEqual([{ outcome: "success", trigger: "manual" }]);
  });

  it("marks a camera offline only after the configured consecutive failures", async () => {
    const id = await addCamera();
    await runCheck(id, "manual", deps);
    await pool.query("UPDATE cameras SET port = 1 WHERE id = $1", [id]); // nothing listens there

    await runCheck(id, "manual", deps);
    expect((await status(id)).connection_status).toBe("online");
    expect(await alerts(id)).toEqual([]);
    await runCheck(id, "manual", deps);
    expect((await status(id)).connection_status).toBe("online");

    await runCheck(id, "manual", deps);
    const s = await status(id);
    expect(s).toMatchObject({ connection_status: "offline", storage_health: "unknown", last_error_code: "UNREACHABLE", consecutive_failures: 3 });
    expect(s.used_percentage).toBe(53.78); // last known figures retained
    expect(await alerts(id)).toEqual([{ type: "offline", severity: "critical", status: "active", occurrence_count: 1 }]);
    const events = (await pool.query("SELECT from_status, to_status FROM connection_events WHERE camera_id = $1", [id])).rows;
    expect(events).toEqual([{ from_status: "unknown", to_status: "online" }, { from_status: "online", to_status: "offline" }]);

    // Recovery auto-resolves the alert.
    await pool.query("UPDATE cameras SET port = $2 WHERE id = $1", [id, port]);
    await runCheck(id, "manual", deps);
    expect((await status(id)).connection_status).toBe("online");
    expect((await alerts(id))[0]).toMatchObject({ type: "offline", status: "resolved" });
    expect(sent.map((e) => `${e.type}:${e.kind}`)).toEqual(["offline:opened", "offline:resolved"]);
  });

  it("distinguishes authentication failures from offline", async () => {
    const id = await addCamera({ password: "wrong-password" });
    await runCheck(id, "manual", deps);
    let s = await status(id);
    expect(s).toMatchObject({ connection_status: "online", last_error_code: "AUTH_FAILED", consecutive_auth_failures: 1 });
    expect(await alerts(id)).toEqual([]);
    await runCheck(id, "manual", deps);
    s = await status(id);
    expect(s.consecutive_auth_failures).toBe(2);
    expect(await alerts(id)).toEqual([{ type: "auth_failure", severity: "critical", status: "active", occurrence_count: 1 }]);
  });

  it("raises disk failure alerts from the camera's reported status", async () => {
    cam.setDisks([{ id: 1, name: "hdde", status: "smartFailed", capacityMb: 1000, freeMb: 900, property: "RW" }]);
    const id = await addCamera();
    await runCheck(id, "manual", deps);
    expect((await status(id)).storage_health).toBe("critical");
    expect(await alerts(id)).toEqual([{ type: "disk_unhealthy", severity: "critical", status: "active", occurrence_count: 1 }]);
  });

  it("records whether the camera is recording, alerts when it stops, and resolves when it resumes", async () => {
    const id = await addCamera();
    await runCheck(id, "manual", deps);
    const s = await status(id);
    expect(s).toMatchObject({ recording_state: "recording", recording_detail: "status: recording; track-101: recording" });
    expect(s.recording_checked_at).not.toBeNull();
    expect(await alerts(id)).toEqual([]);

    cam.recording = "idle";
    await runCheck(id, "manual", deps);
    expect((await status(id)).recording_state).toBe("idle");
    expect(await alerts(id)).toEqual([{ type: "not_recording", severity: "warning", status: "active", occurrence_count: 1 }]);

    cam.recording = "error";
    await runCheck(id, "manual", deps);
    expect(await alerts(id)).toEqual([{ type: "not_recording", severity: "critical", status: "active", occurrence_count: 2 }]);

    cam.recording = "recording";
    await runCheck(id, "manual", deps);
    expect((await alerts(id))[0]).toMatchObject({ type: "not_recording", status: "resolved" });
    const history = (await pool.query("SELECT recording_state FROM storage_checks WHERE camera_id = $1 ORDER BY id", [id])).rows;
    expect(history.map((r) => r.recording_state)).toEqual(["recording", "idle", "error", "recording"]);
  });

  it("keeps the storage check working when recording status cannot be read, and honours the alert setting", async () => {
    const id = await addCamera();
    cam.recording = "<broken";
    const outcome = await runCheck(id, "manual", deps);
    expect(outcome.result?.ok).toBe(true);
    const s = await status(id);
    expect(s.recording_state).toBe("unknown");
    expect(s.recording_detail).toMatch(/could not be read/);

    await updateMonitoringSettings({ recordingAlertsEnabled: false }, null);
    cam.recording = "idle";
    await runCheck(id, "manual", deps);
    expect((await status(id)).recording_state).toBe("idle");
    expect(await alerts(id)).toEqual([]);
  });

  it("suppresses duplicate alerts, escalates, and resolves when usage drops", async () => {
    const id = await addCamera();
    cam.setDisks([{ id: 1, status: "ok", capacityMb: 1000, freeMb: 150, property: "RW" }]); // 85%
    await runCheck(id, "manual", deps);
    await runCheck(id, "manual", deps);
    expect(await alerts(id)).toEqual([{ type: "storage_usage", severity: "warning", status: "active", occurrence_count: 2 }]);

    await pool.query("UPDATE alerts SET status = 'acknowledged' WHERE camera_id = $1", [id]);
    cam.setDisks([{ id: 1, status: "ok", capacityMb: 1000, freeMb: 50, property: "RW" }]); // 95%
    await runCheck(id, "manual", deps);
    // Escalation re-activates an acknowledged alert.
    expect(await alerts(id)).toEqual([{ type: "storage_usage", severity: "critical", status: "active", occurrence_count: 3 }]);

    cam.setDisks([{ id: 1, status: "ok", capacityMb: 1000, freeMb: 500, property: "RW" }]); // 50%
    await runCheck(id, "manual", deps);
    expect((await alerts(id))[0]).toMatchObject({ status: "resolved" });
    const events = (await pool.query(
      "SELECT e.event_type FROM alert_events e JOIN alerts a ON a.id = e.alert_id WHERE a.camera_id = $1 ORDER BY e.id", [id],
    )).rows.map((r) => r.event_type);
    expect(events).toEqual(["opened", "escalated", "auto_resolved"]);
    expect(sent.map((e) => e.kind)).toEqual(["opened", "escalated", "resolved"]);
  });

  it("uses per-camera thresholds", async () => {
    cam.setDisks([{ id: 1, status: "ok", capacityMb: 1000, freeMb: 150, property: "RW" }]); // 85%
    const id = await addCamera({ warningThreshold: 90, criticalThreshold: 95 });
    await runCheck(id, "manual", deps);
    expect((await status(id)).storage_health).toBe("healthy");
  });

  it("never stores the camera password in history, errors or audit logs", async () => {
    const id = await addCamera({ password: "Very-Secret-777" });
    await runCheck(id, "manual", deps);
    for (const table of ["storage_checks", "audit_logs", "camera_status", "alerts", "connection_events"]) {
      const dump = JSON.stringify((await pool.query(`SELECT * FROM ${table}`)).rows);
      expect(dump, table).not.toContain("Very-Secret-777");
    }
    const cred = (await pool.query("SELECT password_encrypted FROM camera_credentials WHERE camera_id = $1", [id])).rows[0];
    expect(cred.password_encrypted).not.toContain("Very-Secret-777");
  });

  it("prevents overlapping checks of the same camera", async () => {
    const id = await addCamera();
    cam.mode = "hang"; // keep the first check in flight
    const first = runCheck(id, "manual", deps);
    await new Promise((r) => setTimeout(r, 200));
    expect((await runCheck(id, "manual", deps)).status).toBe("busy");
    expect((await first).status).toBe("completed");
    // Once the first check finishes the lease is released.
    cam.mode = "ok";
    expect((await runCheck(id, "manual", deps)).status).toBe("completed");
  });
});

describe("scheduler", () => {
  it("checks only due, enabled, non-removed cameras within the concurrency limit", async () => {
    await updateMonitoringSettings({ concurrency: 2 }, null);
    // A camera that never answers, listening on every loopback address, keeps checks in flight.
    const hanging = new MockHikvisionCamera();
    hanging.mode = "hang";
    const hangPort = await hanging.start(0, "0.0.0.0");
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await addCamera({ name: `Cam ${i}`, port: undefined, host: `127.0.0.${i + 1}` }));
    // Point every camera at the mock (distinct hosts satisfy the unique constraint).
    await pool.query("UPDATE cameras SET port = $1", [hangPort]);
    const disabled = await addCamera({ name: "Disabled", host: "127.0.0.50", monitoringEnabled: false });
    const removed = await addCamera({ name: "Removed", host: "127.0.0.51" });
    await removeCameras([removed], actor);

    const scheduler = new Scheduler(deps, { owner: "test-worker" });
    const first = await scheduler.tick();
    expect(first).toHaveLength(2);
    expect(scheduler.inflightCount).toBe(2);
    expect(await scheduler.tick()).toEqual([]); // at capacity
    await scheduler.drain();

    const second = await scheduler.tick();
    expect(second).toHaveLength(2);
    expect(new Set([...first, ...second])).toEqual(new Set(ids));
    await scheduler.drain();
    expect(await scheduler.tick()).toEqual([]); // nothing due until the next poll interval
    expect([...first, ...second]).not.toContain(disabled);

    await hanging.stop();
    const timeouts = (await pool.query("SELECT count(DISTINCT camera_id)::int AS n FROM storage_checks WHERE outcome = 'TIMEOUT'")).rows[0].n;
    expect(timeouts).toBe(4);
  });

  it("reclaims cameras whose lease expired (worker crash recovery)", async () => {
    const id = await addCamera();
    await pool.query("UPDATE camera_status SET check_lock_until = now() - interval '1 second', check_lock_owner = 'dead-worker' WHERE camera_id = $1", [id]);
    const scheduler = new Scheduler(deps, { owner: "new-worker" });
    expect(await scheduler.tick()).toEqual([id]);
    await scheduler.drain();
    expect((await status(id)).connection_status).toBe("online");
  });

  it("purges history older than the retention period", async () => {
    const id = await addCamera();
    await pool.query(
      "INSERT INTO storage_checks (camera_id, checked_at, trigger, outcome, duration_ms, attempts) VALUES ($1, now() - interval '200 days', 'scheduled', 'success', 1, 1), ($1, now(), 'scheduled', 'success', 1, 1)",
      [id],
    );
    await new Scheduler(deps).housekeeping();
    expect((await pool.query("SELECT count(*)::int AS n FROM storage_checks")).rows[0].n).toBe(1);
  });
});
