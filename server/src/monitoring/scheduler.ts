import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { getMonitoringSettings } from "../services/settingsService.js";
import { type CheckDeps, INSTANCE_ID, leaseSeconds, runCheck } from "./checkService.js";

/**
 * Database-driven scheduler. Each tick claims due cameras with FOR UPDATE SKIP LOCKED and a
 * time-limited lease, so several workers can run safely, a camera is never checked twice at
 * once, and cameras claimed by a crashed worker are picked up again when the lease expires.
 * In-flight checks are capped by the configured concurrency; a slow or dead camera only
 * occupies one slot until its timeout. A finished check frees its slot within REFILL_MS rather
 * than at the next regular tick, so throughput is concurrency ÷ check duration (with 20 000
 * cameras a 5-second tick alone capped it at concurrency ÷ 5 per second).
 */
const REFILL_MS = 250;
export class Scheduler {
  private readonly inflight = new Map<string, Promise<unknown>>();
  private timer?: NodeJS.Timeout;
  private running = false;
  private ticking = false;
  private nextTickAt = 0;
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
    // Picks up integrations enabled, disabled or changed in the dashboard (another process).
    await this.deps.registry.refreshIfStale().catch((err) => logger.warn({ err: (err as Error).message }, "Could not reload brand integrations"));
    const { rows } = await pool.query<{ camera_id: string }>(
      `WITH due AS (
         SELECT s.camera_id FROM camera_status s JOIN cameras c ON c.id = s.camera_id
         JOIN camera_brands b ON b.key = c.brand_key
         JOIN organizations o ON o.id = c.organization_id AND o.is_active
         WHERE c.deleted_at IS NULL AND c.monitoring_enabled AND b.status = 'enabled' AND b.deleted_at IS NULL
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
        .finally(() => {
          this.inflight.delete(camera_id);
          this.wake();
        });
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
    // Used or expired email links, and accounts never confirmed within a week (they could sign in to nothing).
    await pool.query("DELETE FROM email_tokens WHERE expires_at < now() - interval '1 day'");
    await pool.query(
      `DELETE FROM users u WHERE u.pending_verification AND u.created_at < now() - interval '7 days'
         AND NOT EXISTS (SELECT 1 FROM organization_members m WHERE m.user_id = u.id)`,
    );
    logger.info(counts, "Retention housekeeping complete");
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  private schedule(ms: number) {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.nextTickAt = Date.now() + ms;
    this.timer = setTimeout(() => void this.loop(), ms);
  }

  /** A slot was freed: tick soon instead of waiting for the regular tick. */
  private wake() {
    if (!this.running || this.ticking || this.nextTickAt - Date.now() <= REFILL_MS) return;
    this.schedule(REFILL_MS);
  }

  private async loop() {
    if (!this.running || this.ticking) return;
    this.ticking = true;
    let started = 0;
    try {
      started = (await this.tick()).length;
      if (Date.now() - this.lastHousekeeping > 3600_000) {
        this.lastHousekeeping = Date.now();
        await this.housekeeping();
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, "Scheduler tick failed");
    } finally {
      this.ticking = false;
    }
    // While cameras keep coming due, refill quickly; otherwise poll at the regular interval.
    this.schedule(started > 0 ? REFILL_MS : (this.opts.tickMs ?? 5000));
  }

  async stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.drain();
  }
}
