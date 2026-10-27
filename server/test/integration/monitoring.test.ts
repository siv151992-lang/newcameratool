import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool.js";
import { createRegistry } from "../../src/integrations/registry.js";
import { runCheck } from "../../src/monitoring/checkService.js";
import { Scheduler } from "../../src/monitoring/scheduler.js";
import type { NotificationEvent } from "../../src/notifications/types.js";
import { createCamera, getSummary, listCameras, listQuerySchema, removeCameras, updateCamera } from "../../src/services/cameraService.js";
import { updateMonitoringSettings } from "../../src/services/settingsService.js";
import { MockHikvisionCamera } from "../../src/testing/mockHikvision.js";
import { createTestUser, prepareDb, resetData, testOrgId } from "../helpers.js";

const registry = createRegistry();
const sent: NotificationEvent[] = [];
const deps = { registry, notifier: { dispatch: async (e: NotificationEvent[]) => void sent.push(...e) }, sleep: async () => undefined };

const cam = new MockHikvisionCamera("admin", "Cam-Pass-123");
let port: number;
let actor: { id: string; username: string };

async function addCamera(overrides: Record<string, unknown> = {}) {
  return createCamera(
    testOrgId,
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
    const { getSummary } = await import("../../src/services/cameraService.js");
    // …but left out of the dashboard's capacity totals while the camera is offline.
    expect(await getSummary(testOrgId)).toMatchObject({ offline: 1, totalBytes: 0, camerasWithStorageData: 0, offlineWithStorageData: 1 });
    expect(await alerts(id)).toEqual([{ type: "offline", severity: "critical", status: "active", occurrence_count: 1 }]);
    const events = (await pool.query("SELECT from_status, to_status FROM connection_events WHERE camera_id = $1", [id])).rows;
    expect(events).toEqual([{ from_status: "unknown", to_status: "online" }, { from_status: "online", to_status: "offline" }]);

    // Recovery auto-resolves the alert.
    await pool.query("UPDATE cameras SET port = $2 WHERE id = $1", [id, port]);
    await runCheck(id, "manual", deps);
    expect((await status(id)).connection_status).toBe("online");
    expect(await getSummary(testOrgId)).toMatchObject({ camerasWithStorageData: 1, offlineWithStorageData: 0 });
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
    // The camera says it records, but its only card failed: a recording error, explained by the one disk alert.
    expect((await status(id)).recording_state).toBe("error");
    expect((await status(id)).recording_detail).toMatch(/^recording is on, but its storage reports an error/);
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
    expect(s.recording_detail).toMatch(/could not be read|does not report recording status/);

    await updateMonitoringSettings(testOrgId, { recordingAlertsEnabled: false }, null);
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

  it("reminds before a camera password change is due, warns when it is due, and resolves when it is changed", async () => {
    const id = await addCamera();
    const age = (days: number) => pool.query(`UPDATE camera_credentials SET password_changed_at = now() - make_interval(days => $2) WHERE camera_id = $1`, [id, days]);
    const due = async () => (await alerts(id)).filter((a) => a.type === "password_change_due");

    await age(10);
    await runCheck(id, "manual", deps);
    expect(await due()).toEqual([]);

    await age(85); // 5 days left: within the 7-day reminder
    await runCheck(id, "manual", deps);
    expect(await due()).toMatchObject([{ severity: "info", status: "active" }]);

    await age(91);
    await runCheck(id, "manual", deps);
    expect(await due()).toMatchObject([{ severity: "warning", status: "active" }]);
    expect(sent.filter((e) => e.type === "password_change_due").map((e) => [e.kind, e.severity])).toEqual([["opened", "info"], ["escalated", "warning"]]);

    await updateCamera(testOrgId, id, { password: "Cam-Pass-123" }, actor); // the same password again: still due
    await runCheck(id, "manual", deps);
    expect(await due()).toMatchObject([{ status: "active" }]);
    await pool.query("UPDATE camera_credentials SET password_changed_at = now() WHERE camera_id = $1", [id]); // changed
    await runCheck(id, "manual", deps);
    expect(await due()).toMatchObject([{ status: "resolved" }]);
  });

  it("raises every problem of a critical-area camera as critical", async () => {
    const id = await addCamera();
    cam.recording = "idle";
    await runCheck(id, "manual", deps);
    expect((await alerts(id)).filter((a) => a.type === "not_recording")).toMatchObject([{ severity: "warning" }]);
    await pool.query("UPDATE cameras SET priority = 'critical' WHERE id = $1", [id]);
    await runCheck(id, "manual", deps);
    expect((await alerts(id)).filter((a) => a.type === "not_recording")).toMatchObject([{ severity: "critical", status: "active" }]);
  });

  it("counts SD cards that are OK, missing or reporting an error, and filters the cameras with a problem", async () => {
    const id = await addCamera();
    cam.setDisks([
      { id: 1, name: "hdde", status: "ok", capacityMb: 121942, freeMb: 56362, property: "RW", formatType: "EXT4" },
      { id: 2, name: "hddf", status: "ok", capacityMb: 60906, freeMb: 50000, property: "RW", formatType: "EXT4" },
    ]);
    await runCheck(id, "manual", deps);
    expect((await getSummary(testOrgId)).sdCard).toEqual({ total: 2, ok: 2, error: 0, camerasWithout: 0 });
    cam.setDisks([{ id: 1, name: "hdde", status: "ok", capacityMb: 121942, freeMb: 56362, property: "RW", formatType: "EXT4" }]);
    await runCheck(id, "manual", deps);
    expect((await getSummary(testOrgId)).sdCard).toEqual({ total: 1, ok: 1, error: 0, camerasWithout: 0 });
    const list = async (status: "sdproblem" | "sdok") => (await listCameras(testOrgId, listQuerySchema.parse({ status }))).items.map((c) => c.id);
    expect(await list("sdok")).toEqual([id]);

    cam.setDisks([{ id: 1, name: "hdde", status: "error", capacityMb: 121942, freeMb: 0, property: "RW" }]);
    await runCheck(id, "manual", deps);
    expect((await getSummary(testOrgId)).sdCard).toEqual({ total: 1, ok: 0, error: 1, camerasWithout: 0 });
    expect(await list("sdproblem")).toEqual([id]);

    cam.setDisks([]);
    await runCheck(id, "manual", deps);
    expect((await getSummary(testOrgId)).sdCard).toEqual({ total: 0, ok: 0, error: 0, camerasWithout: 1 });
    expect(await list("sdproblem")).toEqual([id]);
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
    await updateMonitoringSettings(testOrgId, { concurrency: 2 }, null);
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
    await removeCameras(testOrgId, [removed], actor);

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

  it("refills a freed slot without waiting for the regular tick", async () => {
    await updateMonitoringSettings(testOrgId, { concurrency: 1 }, null);
    const ids = [await addCamera(), await addCamera({ name: "Second", host: "127.0.0.2" }), await addCamera({ name: "Third", host: "127.0.0.3" })];
    const scheduler = new Scheduler(deps, { owner: "refill-worker", tickMs: 60_000 });
    scheduler.start();
    try {
      // One at a time, yet all three are checked within a few seconds although the tick is a minute.
      const deadline = Date.now() + 5000;
      let checked = 0;
      while (Date.now() < deadline && checked < 3) {
        await new Promise((r) => setTimeout(r, 100));
        checked = (await pool.query("SELECT count(*)::int AS n FROM camera_status WHERE last_attempt_at IS NOT NULL AND camera_id = ANY($1)", [ids])).rows[0].n;
      }
      expect(checked).toBe(3);
    } finally {
      await scheduler.stop();
    }
  });

  it("keeps routine checks in history once per interval, and failures and changes always", async () => {
    const id = await addCamera();
    const rows = async () => (await pool.query("SELECT outcome FROM storage_checks WHERE camera_id = $1 ORDER BY checked_at", [id])).rows.map((r) => r.outcome);
    await runCheck(id, "scheduled", deps); // first check: kept
    await runCheck(id, "scheduled", deps); // same state within 15 minutes: not kept
    await runCheck(id, "manual", deps); // manual: kept
    expect(await rows()).toEqual(["success", "success"]);
    expect((await status(id)).last_success_at).not.toBeNull();

    cam.setDisks([{ id: 1, status: "ok", capacityMb: 1000, freeMb: 50, property: "RW" }]); // 95%: health changes
    await runCheck(id, "scheduled", deps);
    expect(await rows()).toHaveLength(3);
    await pool.query("UPDATE camera_status SET last_history_at = now() - interval '16 minutes' WHERE camera_id = $1", [id]);
    await runCheck(id, "scheduled", deps); // interval elapsed: kept
    expect(await rows()).toHaveLength(4);

    await updateMonitoringSettings(testOrgId, { historyIntervalMinutes: 0 }, null);
    await runCheck(id, "scheduled", deps); // 0 keeps every check
    expect(await rows()).toHaveLength(5);
  });

  it("reads how many days of recordings the camera holds, at most every 6 hours unless checked manually", async () => {
    cam.recordingStatusApi = false;
    cam.recordedDays = 12.5;
    try {
      const id = await addCamera();
      await runCheck(id, "scheduled", deps);
      const first = await status(id);
      expect(Number(first.recording_days)).toBeCloseTo(12.5, 1);
      expect(first.recording_oldest).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      cam.recordedDays = 20;
      await runCheck(id, "scheduled", deps); // within 6 hours: not read again
      expect(Number((await status(id)).recording_days)).toBeCloseTo(12.5, 1);
      await runCheck(id, "manual", deps); // Refresh now: read again
      expect(Number((await status(id)).recording_days)).toBeCloseTo(20, 1);
    } finally {
      cam.recordingStatusApi = true;
      cam.recordedDays = 30;
    }
  });

  it("raises a retention alert when a camera holds fewer days of recordings than required", async () => {
    cam.recordingStatusApi = false;
    cam.recordedDays = 12.5;
    try {
      const id = await addCamera();
      await runCheck(id, "manual", deps);
      // Off by default (0 days required).
      expect((await alerts(id)).some((a) => a.type === "recording_retention")).toBe(false);

      await updateMonitoringSettings(testOrgId, { minRecordingDays: 30 }, null);
      await runCheck(id, "manual", deps);
      const raised = (await pool.query("SELECT severity, description FROM alerts WHERE camera_id = $1 AND type = 'recording_retention' AND status <> 'resolved'", [id])).rows;
      expect(raised).toEqual([{ severity: "warning", description: expect.stringMatching(/^The camera holds 12\.5 days of recordings; 30 are required\./) }]);

      cam.recordedDays = 31; // enough again: resolved
      await runCheck(id, "manual", deps);
      expect((await alerts(id)).filter((a) => a.type === "recording_retention").map((a) => a.status)).toEqual(["resolved"]);
    } finally {
      await updateMonitoringSettings(testOrgId, { minRecordingDays: 0 }, null);
      cam.recordingStatusApi = true;
      cam.recordedDays = 30;
    }
  });

  it("measures the camera's clock and alerts when it is wrong", async () => {
    try {
      const id = await addCamera();
      await runCheck(id, "manual", deps);
      let s = await status(id);
      expect(Math.abs(Number(s.clock_offset_seconds))).toBeLessThanOrEqual(2);
      expect(s.clock_error).toBeNull();
      expect((await alerts(id)).some((a) => a.type === "clock_wrong")).toBe(false);

      cam.clockSkewMs = -20 * 60_000; // 20 minutes behind
      await runCheck(id, "scheduled", deps);
      expect(Math.abs(Number((await status(id)).clock_offset_seconds))).toBeLessThanOrEqual(2); // read at most hourly
      await runCheck(id, "manual", deps);
      s = await status(id);
      expect(Number(s.clock_offset_seconds)).toBeGreaterThanOrEqual(-1202);
      expect(Number(s.clock_offset_seconds)).toBeLessThanOrEqual(-1198);
      const raised = (await pool.query("SELECT severity, description FROM alerts WHERE camera_id = $1 AND type = 'clock_wrong' AND status <> 'resolved'", [id])).rows;
      expect(raised).toEqual([{ severity: "warning", description: expect.stringMatching(/^The camera's clock is (19|20) min( \d+ s)? behind/) }]);

      cam.clockSkewMs = 0;
      await runCheck(id, "manual", deps);
      expect((await alerts(id)).filter((a) => a.type === "clock_wrong").map((a) => a.status)).toEqual(["resolved"]);
    } finally {
      cam.clockSkewMs = 0;
    }
  });

  it("falls back to shorter searches, and shows why when none is answered", async () => {
    cam.recordingStatusApi = false;
    cam.recordedDays = 45;
    cam.searchMaxDays = 31; // refuses the 400- and 90-day searches
    try {
      const id = await addCamera();
      await runCheck(id, "manual", deps);
      let s = await status(id);
      expect(Number(s.recording_days)).toBeCloseTo(30, 0); // the 30-day search starts in recordings…
      expect(s.recording_days_at_least).toBe(true); // …so it is at least 30 days
      expect(s.recording_range_error).toBeNull();

      cam.searchMaxDays = 5; // refuses every search
      await runCheck(id, "manual", deps);
      s = await status(id);
      expect(s.recording_range_error).toMatch(/Invalid Content \(badParameters\) \(while searching its recordings\)/);
      expect(Number(s.recording_days)).toBeCloseTo(30, 0); // last value kept
    } finally {
      cam.recordingStatusApi = true;
      cam.recordedDays = 30;
      cam.searchMaxDays = Infinity;
    }
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

describe("cameras without local storage", () => {
  it("stop storage and recording alerts but stay monitored for reachability", async () => {
    cam.setDisks([]);
    const id = await addCamera();
    await runCheck(id, "manual", deps);
    expect((await alerts(id)).map((a) => [a.type, a.status])).toContainEqual(["no_storage_device", "active"]);

    const { setLocalStorage, getSummary, listCameras, listQuerySchema } = await import("../../src/services/cameraService.js");
    const ids = async (status: string) => (await listCameras(testOrgId, listQuerySchema.parse({ status }))).items.map((c) => c.id);
    expect(await ids("nostoragedevice")).toEqual([id]);
    expect(await setLocalStorage(testOrgId, [id], false, actor)).toEqual({ updated: 1 });
    await runCheck(id, "manual", deps);
    expect((await alerts(id)).find((a) => a.type === "no_storage_device")!.status).toBe("resolved");
    expect(await status(id)).toMatchObject({ connection_status: "online", storage_health: "unknown", recording_state: "unknown", total_bytes: null });
    expect(await getSummary(testOrgId)).toMatchObject({ online: 1, storageCritical: 0, notRecording: 0, withoutLocalStorage: 1 });
    expect(await ids("nolocalstorage")).toEqual([id]);
    expect(await ids("nostoragedevice")).toEqual([]);

    // A missing storage API still counts as reachable…
    cam.mode = "not-found";
    expect((await runCheck(id, "manual", deps)).result).toMatchObject({ ok: true });
    // …but no answer at all still makes it offline.
    cam.mode = "hang";
    await updateMonitoringSettings(testOrgId, { offlineFailureThreshold: 1, maxRetries: 0, requestTimeoutMs: 1000 }, null);
    await runCheck(id, "manual", deps);
    expect((await status(id)).connection_status).toBe("offline");
    expect((await alerts(id)).find((a) => a.type === "offline")!.status).toBe("active");
    cam.mode = "ok";
  });
});
