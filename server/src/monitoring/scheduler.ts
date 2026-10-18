import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { getMonitoringSettings } from "../services/settingsService.js";
import { type CheckDeps, INSTANCE_ID, leaseSeconds, runCheck } from "./checkService.js";

/**
 * Database-driven scheduler. Each tick claims due cameras with FOR UPDATE SKIP LOCKED and a
 * time-limited lease, so several workers can run safely, a camera is never checked twice at
 * once, and cameras claimed by a crashed worker are picked up again when the lease expires.
 * In-flight checks are capped by the configured concurrency; a slow or dead camera only
 * occupies one slot until its timeout.
 */
export class Scheduler {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastHousekeeping = 0;

  constructor(
    private readonly deps: CheckDeps,
    private readonly opts: { tickMs?: number; owner?: string } = {},
  ) {}

  get inflightCount() {
    return this.inflight.size;
  }

  /** Claims and starts due checks. Returns the camera ids started. */
  async tick(): Promise<string[]> {
    const settings = await getMonitoringSettings();
    const capacity = settings.concurrency - this.inflight.size;
    if (capacity <= 0) return [];
    const { rows } = await pool.query<{ camera_id: string }>(
      `WITH due AS (
         SELECT s.camera_id FROM camera_status s JOIN cameras c ON c.id = s.camera_id
         WHERE c.deleted_at IS NULL AND c.monitoring_enabled
           AND (s.next_check_at IS NULL OR s.next_check_at <= now())
           AND (s.check_lock_until IS NULL OR s.check_lock_until < now())
         ORDER BY s.next_check_at NULLS FIRST
         LIMIT $1
         FOR UPDATE OF s SKIP LOCKED)
       UPDATE camera_status s SET check_lock_until = now() + make_interval(secs => $2), check_lock_owner = $3
       FROM due WHERE s.camera_id = due.camera_id
       RETURNING s.camera_id`,
      [capacity, leaseSeconds(settings), this.opts.owner ?? INSTANCE_ID],
    );
    for (const { camera_id } of rows) {
      const p = runCheck(camera_id, "scheduled", this.deps, { leaseHeld: true })
        .catch((err) => logger.error({ cameraId: camera_id, err: (err as Error).message }, "Scheduled check failed"))
        .finally(() => this.inflight.delete(camera_id));
      this.inflight.set(camera_id, p);
    }
    return rows.map((r) => r.camera_id);
  }

  /** Waits for all in-flight checks (used by tests and graceful shutdown). */
  async drain() {
    await Promise.allSettled([...this.inflight.values()]);
  }

  async housekeeping() {
    const s = await getMonitoringSettings();
    const purge = async (sql: string, days: number) => (await pool.query(sql, [days])).rowCount ?? 0;
    const counts = {
      checks: await purge("DELETE FROM storage_checks WHERE checked_at < now() - make_interval(days => $1)", s.historyRetentionDays),
      connectionEvents: await purge("DELETE FROM connection_events WHERE occurred_at < now() - make_interval(days => $1)", s.historyRetentionDays),
      deliveries: await purge("DELETE FROM notification_deliveries WHERE created_at < now() - make_interval(days => $1)", s.historyRetentionDays),
      resolvedAlerts: await purge("DELETE FROM alerts WHERE status = 'resolved' AND resolved_at < now() - make_interval(days => $1)", s.auditRetentionDays),
      audit: await purge("DELETE FROM audit_logs WHERE created_at < now() - make_interval(days => $1)", s.auditRetentionDays),
    };
    await pool.query("DELETE FROM sessions WHERE expires_at < now()");
    logger.info(counts, "Retention housekeeping complete");
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
        if (Date.now() - this.lastHousekeeping > 3600_000) {
          this.lastHousekeeping = Date.now();
          await this.housekeeping();
        }
      } catch (err) {
        logger.error({ err: (err as Error).message }, "Scheduler tick failed");
      }
      if (this.running) this.timer = setTimeout(loop, this.opts.tickMs ?? 5000);
    };
    void loop();
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.drain();
  }
}
