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
  type StorageReading,
} from "../integrations/types.js";
import { sleep } from "../lib/concurrency.js";
import { logger } from "../lib/logger.js";
import type { Notifier } from "../notifications/notifier.js";
import type { NotificationEvent } from "../notifications/types.js";
import { redactSecrets } from "../security/redact.js";
import { applyConditions, openAlertTypes } from "../services/alertService.js";
import { getCameraConfig } from "../services/cameraService.js";
import { getMonitoringSettings, type MonitoringSettings } from "../services/settingsService.js";
import { type CheckResult, evaluateConditions, storageHealth, thresholdsFor } from "./evaluate.js";

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
  const worstCase = (s.maxRetries + 1) * s.requestTimeoutMs * 2 + s.retryBaseDelayMs * 2 ** (s.maxRetries + 1);
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
  const settings = await getMonitoringSettings();
  if (!opts.leaseHeld && !(await acquireLease(cameraId, settings))) return { cameraId, status: "busy" };

  const started = Date.now();
  let attempts = 1;
  let result: CheckResult;
  let deviceInfo: DeviceInfo | undefined;
  let config: CameraConfig | undefined;
  try {
    const cam = await pool.query("SELECT brand_key, monitoring_enabled, deleted_at FROM cameras WHERE id = $1", [cameraId]);
    const row = cam.rows[0];
    if (!row || row.deleted_at || (trigger === "scheduled" && !row.monitoring_enabled)) {
      return { cameraId, status: "skipped" };
    }
    try {
      const adapter: CameraBrandAdapter = deps.registry.get(row.brand_key);
      config = await getCameraConfig(cameraId, settings.requestTimeoutMs);
      const cfg = config;
      const { value, attempts: n } = await withRetry(() => adapter.getStorageStatus(cfg), {
        maxRetries: settings.maxRetries,
        baseDelayMs: settings.retryBaseDelayMs,
        sleep: deps.sleep,
      });
      attempts = n;
      result = { ok: true, reading: value };
      deviceInfo = await refreshDeviceInfo(cameraId, adapter, cfg, settings);
    } catch (err) {
      attempts = (err as { attempts?: number }).attempts ?? attempts;
      result = toFailure(err, [config?.password]);
    }

    const events = await persist(cameraId, trigger, result, attempts, Date.now() - started, deviceInfo, settings);
    deps.notifier.dispatch(events).catch((err) => logger.error({ err: (err as Error).message }, "Notification dispatch failed"));
    return { cameraId, status: "completed", result, attempts, durationMs: Date.now() - started };
  } finally {
    await releaseLease(cameraId, settings).catch((err) => logger.error({ err: err.message, cameraId }, "Failed to release lease"));
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

async function persist(
  cameraId: string,
  trigger: "scheduled" | "manual",
  result: CheckResult,
  attempts: number,
  durationMs: number,
  deviceInfo: DeviceInfo | undefined,
  settings: MonitoringSettings,
): Promise<NotificationEvent[]> {
  return withTransaction(async (db) => {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.host, c.created_at, c.warning_threshold, c.critical_threshold,
              s.connection_status, s.consecutive_failures, s.consecutive_auth_failures,
              (SELECT max(checked_at) FROM storage_checks sc WHERE sc.camera_id = c.id AND sc.outcome = 'success') AS last_storage_success
       FROM cameras c JOIN camera_status s ON s.camera_id = c.id WHERE c.id = $1 FOR UPDATE OF s`,
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
    const health = reading ? storageHealth(reading, thresholds) : undefined;
    const lastStorageSuccess: Date = cam.last_storage_success ?? cam.created_at;
    const minutesWithoutStorage = result.ok ? 0 : (Date.now() - new Date(lastStorageSuccess).getTime()) / 60000;

    await db.query(
      `INSERT INTO storage_checks (camera_id, trigger, outcome, duration_ms, attempts, storage_health,
                                   total_bytes, used_bytes, free_bytes, used_percentage, devices, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        cameraId, trigger, result.ok ? "success" : result.errorCode, durationMs, attempts, health ?? null,
        reading?.totalBytes ?? null, reading?.usedBytes ?? null, reading?.freeBytes ?? null, reading?.usedPercentage ?? null,
        reading ? JSON.stringify(reading.devices) : null, result.ok ? null : result.errorMessage,
      ],
    );

    if (result.ok) {
      await db.query(
        `UPDATE camera_status SET connection_status = 'online', storage_health = $2,
                last_error_code = NULL, last_error_message = NULL, last_attempt_at = now(), last_success_at = now(),
                consecutive_failures = 0, consecutive_auth_failures = 0,
                total_bytes = $3, used_bytes = $4, free_bytes = $5, used_percentage = $6, updated_at = now()
         WHERE camera_id = $1`,
        [cameraId, health, reading!.totalBytes ?? null, reading!.usedBytes ?? null, reading!.freeBytes ?? null, reading!.usedPercentage ?? null],
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
                storage_health = CASE WHEN $7 THEN 'unknown' ELSE storage_health END, updated_at = now()
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
      minutesWithoutStorage,
      thresholds,
      settings,
      openTypes: await openAlertTypes(cameraId, db),
    });
    return applyConditions(db, { id: cam.id, name: cam.name, host: cam.host }, evaluation.active, evaluation.evaluated);
  });
}
