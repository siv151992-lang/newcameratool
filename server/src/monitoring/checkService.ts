import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { pool, withTransaction } from "../db/pool.js";
import type { BrandRegistry } from "../integrations/registry.js";
import {
  AUTH_ERROR_CODES,
  CameraApiError,
  NETWORK_ERROR_CODES,
  type CameraBrandAdapter,
  type CameraConfig,
  type DeviceInfo,
  type NvrChannel,
  type RecordingReading,
  type StorageReading,
} from "../integrations/types.js";
import { reconcileRecording } from "../integrations/recording.js";
import { sleep } from "../lib/concurrency.js";
import { logger } from "../lib/logger.js";
import type { Notifier } from "../notifications/notifier.js";
import type { NotificationEvent } from "../notifications/types.js";
import { redactSecrets } from "../security/redact.js";
import { applyConditions, openAlertTypes } from "../services/alertService.js";
import { credentialsFor, getCameraConfig } from "../services/cameraService.js";
import { getMonitoringSettings, type MonitoringSettings } from "../services/settingsService.js";
import { type CheckResult, evaluateConditions, passwordAgeCondition, raiseForCriticalArea, storageHealth, thresholdsFor } from "./evaluate.js";
import { getCameraPasswordPolicy } from "../services/cameraPasswordPolicy.js";

export const INSTANCE_ID = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;

export interface CheckDeps {
  registry: BrandRegistry;
  notifier: Pick<Notifier, "dispatch">;
  /** Override for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface CheckOutcome {
  cameraId: string;
  status: "completed" | "busy" | "skipped";
  result?: CheckResult;
  attempts?: number;
  durationMs?: number;
}

/** Lease long enough for every retry to time out, plus margin. Expired leases are reclaimed after a crash. */
export function leaseSeconds(s: MonitoringSettings) {
  // Storage with retries (two requests each for Digest), then up to six requests for recording
  // status and device information.
  const worstCase = (s.maxRetries + 1) * s.requestTimeoutMs * 2 + s.retryBaseDelayMs * 2 ** (s.maxRetries + 1) + 6 * s.requestTimeoutMs;
  return Math.ceil(worstCase / 1000) + 30;
}

/** Atomically claims a camera so no two processes check it at the same time. */
export async function acquireLease(cameraId: string, settings: MonitoringSettings, owner = INSTANCE_ID): Promise<boolean> {
  const res = await pool.query(
    `UPDATE camera_status s SET check_lock_until = now() + make_interval(secs => $2), check_lock_owner = $3
     FROM cameras c
     WHERE s.camera_id = $1 AND c.id = s.camera_id AND c.deleted_at IS NULL
       AND (s.check_lock_until IS NULL OR s.check_lock_until < now())`,
    [cameraId, leaseSeconds(settings), owner],
  );
  return res.rowCount === 1;
}

async function releaseLease(cameraId: string, settings: MonitoringSettings) {
  await pool.query(
    `UPDATE camera_status SET check_lock_until = NULL, check_lock_owner = NULL,
            next_check_at = now() + make_interval(secs => $2)
     WHERE camera_id = $1`,
    [cameraId, settings.pollIntervalSeconds],
  );
}

/** Bounded retries with exponential backoff and jitter, only for transient errors. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries: number; baseDelayMs: number; sleep?: (ms: number) => Promise<void> },
): Promise<{ value: T; attempts: number }> {
  const wait = opts.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return { value: await fn(), attempts: attempt + 1 };
    } catch (err) {
      const retryable = err instanceof CameraApiError && err.transient && attempt < opts.maxRetries;
      if (!retryable) {
        (err as { attempts?: number }).attempts = attempt + 1;
        throw err;
      }
      const delay = opts.baseDelayMs * 2 ** attempt;
      await wait(delay + Math.floor(Math.random() * delay * 0.2));
    }
  }
}

function toFailure(err: unknown, secrets: (string | undefined)[]): CheckResult & { ok: false } {
  if (err instanceof CameraApiError) {
    return { ok: false, errorCode: err.code, errorMessage: redactSecrets(err.message, secrets) };
  }
  logger.error({ err: redactSecrets((err as Error)?.message ?? String(err), secrets) }, "Unexpected error during camera check");
  return { ok: false, errorCode: "API_ERROR", errorMessage: "Unexpected error while checking the camera" };
}

/**
 * Runs one storage check for a camera and records the outcome.
 * Safe to call from the API (manual "check now") and from the worker: a lease prevents overlap.
 */
export async function runCheck(
  cameraId: string,
  trigger: "scheduled" | "manual",
  deps: CheckDeps,
  opts: { leaseHeld?: boolean } = {},
): Promise<CheckOutcome> {
  // Server-wide values (timeouts, retries) size the lease; the camera's organization settings apply below.
  let settings = await getMonitoringSettings();
  if (!opts.leaseHeld && !(await acquireLease(cameraId, settings))) return { cameraId, status: "busy" };

  const started = Date.now();
  let attempts = 1;
  let result: CheckResult;
  let deviceInfo: DeviceInfo | undefined;
  let recording: RecordingReading | undefined;
  let channels: { list?: NvrChannel[]; error?: string } | undefined;
  let config: CameraConfig | undefined;
  let integrationVersion: string | undefined;
  try {
    const cam = await pool.query(
      "SELECT brand_key, monitoring_enabled, local_storage, deleted_at, organization_id, device_type FROM cameras WHERE id = $1",
      [cameraId],
    );
    const row = cam.rows[0];
    if (!row || row.deleted_at || (trigger === "scheduled" && !row.monitoring_enabled)) {
      return { cameraId, status: "skipped" };
    }
    settings = await getMonitoringSettings(row.organization_id);
    try {
      let adapter: CameraBrandAdapter;
      try {
        adapter = deps.registry.get(row.brand_key);
      } catch (err) {
        // The integration may have been enabled in another process since the last reload.
        if (!(err instanceof CameraApiError) || err.code !== "UNSUPPORTED_BRAND") throw err;
        await deps.registry.refresh();
        adapter = deps.registry.get(row.brand_key);
      }
      const meta = adapter.meta;
      integrationVersion = meta.configVersion ? `${meta.version ?? "1.0.0"} (config ${meta.configVersion})` : (meta.version ?? "1.0.0");
      config = await getCameraConfig(cameraId, settings.requestTimeoutMs);
      const cfg = config;
      // A recording server (Milestone) keeps its own storage: only its being reachable is checked.
      const local = row.local_storage !== false && !meta.recordsElsewhere;
      const { value, attempts: n } = await withRetry(() => (local ? adapter.getStorageStatus(cfg) : reachability(adapter, cfg)), {
        maxRetries: settings.maxRetries,
        baseDelayMs: settings.retryBaseDelayMs,
        sleep: deps.sleep,
      });
      attempts = n;
      result = { ok: true, reading: value };
      recording = local
        ? reconcileRecording(await readRecording(adapter, cfg), value)
        : { state: "unknown", channels: [], detail: meta.recordsElsewhere ? `Records on its own servers (${meta.displayName}); each camera's recording is shown on its channel` : "No local storage: this camera records elsewhere (e.g. an NVR)" };
      if (row.device_type === "nvr") channels = await readChannels(adapter, cfg);
      deviceInfo = await refreshDeviceInfo(cameraId, adapter, cfg, settings);
      if (local) await refreshRecordingRange(cameraId, adapter, cfg, trigger);
      await refreshClock(cameraId, adapter, cfg, trigger);
    } catch (err) {
      attempts = (err as { attempts?: number }).attempts ?? attempts;
      result = toFailure(err, [config?.password]);
    }

    const events = await persist(cameraId, trigger, result, attempts, Date.now() - started, deviceInfo, recording, settings, integrationVersion, channels);
    deps.notifier.dispatch(events).catch((err) => logger.error({ err: (err as Error).message }, "Notification dispatch failed"));
    return { cameraId, status: "completed", result, attempts, durationMs: Date.now() - started };
  } finally {
    await releaseLease(cameraId, settings).catch((err) => logger.error({ err: err.message, cameraId }, "Failed to release lease"));
  }
}

/**
 * For a camera without local storage the storage request only proves it is reachable: a reply that
 * says there is no storage (or no storage API) still counts as a successful check. Network and
 * authentication failures still fail, so offline detection and credential alerts work as usual.
 */
async function reachability(adapter: CameraBrandAdapter, cfg: CameraConfig): Promise<StorageReading> {
  try {
    await adapter.getStorageStatus(cfg);
  } catch (err) {
    if (!(err instanceof CameraApiError) || NETWORK_ERROR_CODES.has(err.code) || AUTH_ERROR_CODES.has(err.code)) throw err;
    if (["CREDENTIALS_UNAVAILABLE", "UNSUPPORTED_BRAND", "HOST_NOT_ALLOWED", "INVALID_HOST"].includes(err.code)) throw err;
  }
  return { devices: [] };
}

/**
 * An NVR's channels. Best effort like recording: one attempt, and a failure is kept as the reason
 * (no channel alerts are raised or resolved without a reading).
 */
async function readChannels(adapter: CameraBrandAdapter, cfg: CameraConfig): Promise<{ list?: NvrChannel[]; error?: string }> {
  if (!adapter.getChannels) return { error: "Channels are not available for this brand" };
  try {
    return { list: await adapter.getChannels(cfg) };
  } catch (err) {
    const msg = err instanceof CameraApiError ? redactSecrets(err.message, [cfg.password]) : "unexpected error";
    return { error: `Channels could not be read: ${msg}` };
  }
}

/**
 * Reads whether the camera is recording now. Best effort: one attempt, no retries, and a failure
 * only makes the state "unknown"; it never fails the storage check.
 */
export async function readRecording(adapter: CameraBrandAdapter, cfg: CameraConfig): Promise<RecordingReading> {
  if (!adapter.getRecordingStatus) {
    return { state: "unknown", channels: [], detail: "Recording status is not available for this brand" };
  }
  try {
    return await adapter.getRecordingStatus(cfg);
  } catch (err) {
    const msg = err instanceof CameraApiError ? redactSecrets(err.message, [cfg.password]) : "unexpected error";
    // A missing endpoint is how the model works, not a fault.
    if (err instanceof CameraApiError && err.code === "API_UNAVAILABLE") {
      return { state: "unknown", channels: [], detail: `This camera does not report recording status (${msg})` };
    }
    return { state: "unknown", channels: [], detail: `Recording status could not be read: ${msg}` };
  }
}

async function refreshDeviceInfo(
  cameraId: string,
  adapter: CameraBrandAdapter,
  cfg: CameraConfig,
  settings: MonitoringSettings,
): Promise<DeviceInfo | undefined> {
  const { rows } = await pool.query(
    "SELECT device_info_at FROM camera_status WHERE camera_id = $1",
    [cameraId],
  );
  const last = rows[0]?.device_info_at as Date | null;
  if (last && Date.now() - last.getTime() < settings.deviceInfoRefreshHours * 3600_000) return undefined;
  try {
    return await adapter.getDeviceInfo(cfg);
  } catch {
    return undefined; // optional; storage monitoring does not depend on it
  }
}

/** The camera's clock is read at most this often per camera (and on every manual check). */
const CLOCK_REFRESH_MS = 3600_000;

/**
 * Measures how far the camera's clock is from ours (seconds, camera minus server; the request's
 * own time is split evenly). Optional: brands without a clock leave it unknown, and a failure is
 * kept as the reason.
 */
async function refreshClock(cameraId: string, adapter: CameraBrandAdapter, cfg: CameraConfig, trigger: "scheduled" | "manual") {
  if (!adapter.getClock) return;
  const { rows } = await pool.query("SELECT clock_checked_at FROM camera_status WHERE camera_id = $1", [cameraId]);
  const last = rows[0]?.clock_checked_at as Date | null;
  if (trigger === "scheduled" && last && Date.now() - last.getTime() < CLOCK_REFRESH_MS) return;
  const sent = Date.now();
  try {
    const cameraUtc = await adapter.getClock(cfg);
    const offset = Math.round((cameraUtc - (sent + Date.now()) / 2) / 1000);
    await pool.query("UPDATE camera_status SET clock_offset_seconds = $2, clock_error = NULL, clock_checked_at = now() WHERE camera_id = $1", [cameraId, offset]);
  } catch (err) {
    await pool.query("UPDATE camera_status SET clock_offset_seconds = NULL, clock_error = $2, clock_checked_at = now() WHERE camera_id = $1", [cameraId, (err as Error).message.slice(0, 300)]);
  }
}

/** Days of recordings are read at most this often per camera (and on every manual check). */
const RECORDING_RANGE_REFRESH_MS = 6 * 3600_000;

/**
 * Updates how many days of recordings the camera holds. Optional, like device information: a
 * failure leaves the last value and is retried after an hour.
 */
async function refreshRecordingRange(cameraId: string, adapter: CameraBrandAdapter, cfg: CameraConfig, trigger: "scheduled" | "manual") {
  if (!adapter.getRecordingRange) {
    // Marks it as looked at, so the camera page says the brand does not report it.
    await pool.query("UPDATE camera_status SET recording_range_at = now() WHERE camera_id = $1 AND recording_range_at IS NULL", [cameraId]);
    return;
  }
  const { rows } = await pool.query("SELECT recording_range_at, recording_range_error FROM camera_status WHERE camera_id = $1", [cameraId]);
  const last = rows[0]?.recording_range_at as Date | null;
  const wait = rows[0]?.recording_range_error ? 3600_000 : RECORDING_RANGE_REFRESH_MS; // a failure is retried after an hour
  if (trigger === "scheduled" && last && Date.now() - last.getTime() < wait) return;
  try {
    const range = await adapter.getRecordingRange(cfg);
    await pool.query(
      `UPDATE camera_status SET recording_days = $2, recording_oldest = $3, recording_days_at_least = $4,
              recording_range_error = NULL, recording_range_at = now() WHERE camera_id = $1`,
      [cameraId, range?.days ?? null, range?.oldest ?? null, range?.atLeast ?? false],
    );
  } catch (err) {
    const msg = err instanceof CameraApiError ? redactSecrets(err.message, [cfg.password]) : "unexpected error";
    await pool.query("UPDATE camera_status SET recording_range_error = $2, recording_range_at = now() WHERE camera_id = $1", [cameraId, msg.slice(0, 500)]);
  }
}

async function persist(
  cameraId: string,
  trigger: "scheduled" | "manual",
  result: CheckResult,
  attempts: number,
  durationMs: number,
  deviceInfo: DeviceInfo | undefined,
  recording: RecordingReading | undefined,
  settings: MonitoringSettings,
  integrationVersion?: string,
  channels?: { list?: NvrChannel[]; error?: string },
): Promise<NotificationEvent[]> {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.host, c.created_at, c.warning_threshold, c.critical_threshold, c.local_storage,
              c.organization_id, c.brand_key, c.priority, cr.password_changed_at, (c.maintenance_until > now()) AS in_maintenance,
              s.connection_status, s.consecutive_failures, s.consecutive_auth_failures,
              s.storage_health, s.recording_state, s.last_history_at, s.last_success_at AS last_storage_success,
              s.recording_days, s.recording_days_at_least, s.recording_range_error, s.clock_offset_seconds
       FROM cameras c JOIN camera_status s ON s.camera_id = c.id
       LEFT JOIN camera_credentials cr ON cr.camera_id = c.id WHERE c.id = $1 FOR UPDATE OF s`,
      [cameraId],
    );
    const cam = rows[0];
    if (!cam) return [];
    const thresholds = thresholdsFor(settings, cam);
    const prevConnection = cam.connection_status as "online" | "offline" | "unknown";

    let connection = prevConnection;
    let failures = 0;
    let authFailures = 0;
    if (result.ok) {
      connection = "online";
    } else {
      failures = cam.consecutive_failures + 1;
      if (NETWORK_ERROR_CODES.has(result.errorCode)) {
        authFailures = cam.consecutive_auth_failures;
        // A single transient failure does not mark the camera offline.
        if (failures >= settings.offlineFailureThreshold) connection = "offline";
      } else if (result.errorCode === "CREDENTIALS_UNAVAILABLE" || result.errorCode === "UNSUPPORTED_BRAND" ||
                 result.errorCode === "HOST_NOT_ALLOWED" || result.errorCode === "INVALID_HOST") {
        // Local configuration problems say nothing about the device's reachability.
        authFailures = cam.consecutive_auth_failures;
      } else {
        // The device answered (auth or API error), so it is reachable.
        connection = "online";
        authFailures = AUTH_ERROR_CODES.has(result.errorCode) ? cam.consecutive_auth_failures + 1 : 0;
      }
    }

    const reading: StorageReading | undefined = result.ok ? result.reading : undefined;
    const localStorage = cam.local_storage !== false;
    // Without local storage there is no storage health to report.
    const health = reading ? (localStorage ? storageHealth(reading, thresholds) : "unknown") : undefined;
    const lastStorageSuccess: Date = cam.last_storage_success ?? cam.created_at;
    const minutesWithoutStorage = result.ok ? 0 : (Date.now() - new Date(lastStorageSuccess).getTime()) / 60000;

    // Every check updates camera_status; the history keeps failures, changes and manual checks,
    // and routine successful checks at most once per historyIntervalMinutes.
    const keepHistory =
      settings.historyIntervalMinutes === 0 || trigger !== "scheduled" || !result.ok || !cam.last_history_at ||
      Date.now() - new Date(cam.last_history_at).getTime() >= settings.historyIntervalMinutes * 60_000 - 5_000 ||
      prevConnection !== "online" || (health ?? null) !== cam.storage_health || (recording?.state ?? "unknown") !== cam.recording_state;
    if (keepHistory) await db.query(
      `INSERT INTO storage_checks (camera_id, trigger, outcome, duration_ms, attempts, storage_health,
                                   total_bytes, used_bytes, free_bytes, used_percentage, devices, error_message, recording_state, integration_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        cameraId, trigger, result.ok ? "success" : result.errorCode, durationMs, attempts, health ?? null,
        reading?.totalBytes ?? null, reading?.usedBytes ?? null, reading?.freeBytes ?? null, reading?.usedPercentage ?? null,
        reading ? JSON.stringify(reading.devices) : null, result.ok ? null : result.errorMessage, recording?.state ?? null,
        integrationVersion ?? null,
      ],
    );
    if (keepHistory) await db.query("UPDATE camera_status SET last_history_at = now() WHERE camera_id = $1", [cameraId]);
    if (result.ok) {
      await db.query(`UPDATE camera_brands SET last_success_at = now()
         WHERE key = (SELECT brand_key FROM cameras WHERE id = $1) AND (last_success_at IS NULL OR last_success_at < now() - interval '1 minute')`, [cameraId]);
    }

    if (result.ok) {
      await db.query(
        `UPDATE camera_status SET connection_status = 'online', storage_health = $2,
                last_error_code = NULL, last_error_message = NULL, last_attempt_at = now(), last_success_at = now(),
                consecutive_failures = 0, consecutive_auth_failures = 0,
                total_bytes = $3, used_bytes = $4, free_bytes = $5, used_percentage = $6,
                recording_state = $7, recording_detail = $8, recording_checked_at = now(), updated_at = now()
         WHERE camera_id = $1`,
        [
          cameraId, health, reading!.totalBytes ?? null, reading!.usedBytes ?? null, reading!.freeBytes ?? null,
          reading!.usedPercentage ?? null, recording?.state ?? "unknown", recording?.detail ?? null,
        ],
      );
      const ids = reading!.devices.map((d) => d.id);
      await db.query("DELETE FROM storage_devices WHERE camera_id = $1 AND NOT (vendor_id = ANY($2::text[]))", [cameraId, ids]);
      for (const d of reading!.devices) {
        await db.query(
          `INSERT INTO storage_devices (camera_id, vendor_id, name, type, health_status, raw_status, total_bytes, free_bytes,
                                        used_bytes, used_percentage, writable, property, format_type, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
           ON CONFLICT (camera_id, vendor_id) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type,
             health_status = EXCLUDED.health_status, raw_status = EXCLUDED.raw_status, total_bytes = EXCLUDED.total_bytes,
             free_bytes = EXCLUDED.free_bytes, used_bytes = EXCLUDED.used_bytes, used_percentage = EXCLUDED.used_percentage,
             writable = EXCLUDED.writable, property = EXCLUDED.property, format_type = EXCLUDED.format_type, updated_at = now()`,
          [
            cameraId, d.id, d.name ?? null, d.type ?? null, d.healthStatus, d.rawStatus ?? null, d.totalBytes ?? null,
            d.freeBytes ?? null, d.usedBytes ?? null, d.usedPercentage ?? null, d.writable ?? null, d.property ?? null, d.formatType ?? null,
          ],
        );
      }
    } else {
      // Keep the last known capacity figures (with their timestamp) but stop vouching for
      // storage health once the camera has failed repeatedly.
      const healthUnknown = failures >= settings.offlineFailureThreshold || connection === "offline";
      await db.query(
        `UPDATE camera_status SET connection_status = $2, last_error_code = $3, last_error_message = $4,
                last_attempt_at = now(), consecutive_failures = $5, consecutive_auth_failures = $6,
                storage_health = CASE WHEN $7 THEN 'unknown' ELSE storage_health END,
                recording_state = CASE WHEN $7 THEN 'unknown' ELSE recording_state END, updated_at = now()
         WHERE camera_id = $1`,
        [cameraId, connection, result.errorCode, result.errorMessage, failures, authFailures, healthUnknown],
      );
    }

    if (deviceInfo) {
      await db.query(
        `UPDATE camera_status SET device_model = coalesce($2, device_model), device_serial = coalesce($3, device_serial),
                firmware_version = coalesce($4, firmware_version), device_info_at = now()
         WHERE camera_id = $1`,
        [cameraId, deviceInfo.model ?? null, deviceInfo.serialNumber ?? null, deviceInfo.firmwareVersion ?? null],
      );
    }

    if (connection !== prevConnection) {
      await db.query(
        "INSERT INTO connection_events (camera_id, from_status, to_status, reason) VALUES ($1, $2, $3, $4)",
        [cameraId, prevConnection, connection, result.ok ? "Storage check succeeded" : result.errorMessage],
      );
    }

    const evaluation = evaluateConditions({
      result,
      connectionStatus: connection,
      consecutiveFailures: failures,
      consecutiveAuthFailures: authFailures,
      recording,
      minutesWithoutStorage,
      thresholds,
      settings,
      localStorage,
      channels: result.ok ? channels?.list : undefined,
      recordingDays: result.ok && cam.recording_days !== null && !cam.recording_range_error
        ? { days: Number(cam.recording_days), atLeast: Boolean(cam.recording_days_at_least) }
        : undefined,
      clockOffsetSeconds: result.ok && cam.clock_offset_seconds !== null ? Number(cam.clock_offset_seconds) : undefined,
      openTypes: await openAlertTypes(cameraId, db),
    });
    if (channels) {
      if (channels.list) {
        const list = channels.list;
        await db.query("DELETE FROM nvr_channels WHERE camera_id = $1 AND NOT (channel = ANY($2::int[]))", [cameraId, list.map((c) => c.channel)]);
        for (const c of list) {
          await db.query(
            `INSERT INTO nvr_channels (camera_id, channel, name, online, recording, updated_at) VALUES ($1,$2,$3,$4,$5, now())
             ON CONFLICT (camera_id, channel) DO UPDATE SET name = EXCLUDED.name, online = EXCLUDED.online, recording = EXCLUDED.recording, updated_at = now()`,
            [cameraId, c.channel, c.name?.slice(0, 120) ?? null, c.online ?? null, c.recording ?? null],
          );
        }
      }
      await db.query("UPDATE camera_status SET channels_error = $2, channels_at = now() WHERE camera_id = $1", [cameraId, channels.error?.slice(0, 500) ?? null]);
    }
    // The password's age is known whatever the check found: due a change, or not (resolved).
    const policy = await getCameraPasswordPolicy(cam.organization_id, db);
    const due = credentialsFor(cam.brand_key) === "user_password"
      ? passwordAgeCondition({ changedAt: cam.password_changed_at, maxAgeDays: policy.maxAgeDays, reminderDays: policy.reminderDays, alertsEnabled: policy.changeAlerts })
      : null;
    // Critical-area cameras: every problem is critical (the password reminder stays a reminder).
    const raised = cam.priority === "critical" ? evaluation.active.map(raiseForCriticalArea) : evaluation.active;
    const active = due ? [...raised, due] : raised;
    if (cam.in_maintenance) {
      // Planned work: alerts already open stay as they are (and resolve if the problem clears), no new
      // ones open, and nothing is sent.
      const open = await openAlertTypes(cameraId, db);
      await applyConditions(db, { id: cam.id, name: cam.name, host: cam.host }, active.filter((c) => open.has(c.type)), [...evaluation.evaluated, "password_change_due"]);
      return [];
    }
    return applyConditions(db, { id: cam.id, name: cam.name, host: cam.host }, active, [...evaluation.evaluated, "password_change_due"]);
  });
}
