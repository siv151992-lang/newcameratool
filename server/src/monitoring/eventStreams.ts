import type pg from "pg";
import { pool } from "../db/pool.js";
import type { BrandRegistry } from "../integrations/registry.js";
import { CameraApiError } from "../integrations/types.js";
import { logger } from "../lib/logger.js";
import { redactSecrets } from "../security/redact.js";
import type { Notifier } from "../notifications/notifier.js";
import { CameraEventHandler } from "../services/cameraEventService.js";
import { getCameraConfig } from "../services/cameraService.js";

/** One worker keeps the event streams open (they are not split between workers): this lock decides which. */
const LOCK_KEY = 0x63637476; // "cctv"
const REFRESH_MS = 60_000;
const SWEEP_MS = 30_000;
/** Reconnecting after a dropped stream: from 10 seconds, doubling, up to 5 minutes. */
const RETRY_MIN_MS = 10_000;
const RETRY_MAX_MS = 5 * 60_000;
/** A camera without an event stream is asked again after this long (firmware may be updated). */
const UNSUPPORTED_RETRY_MS = 6 * 3600_000;
/** A refused login is not tried again for this long (cameras lock their users out after a few). */
const AUTH_RETRY_MS = 30 * 60_000;

interface Running { key: string; abort: AbortController; done: Promise<void> }

/**
 * Keeps each camera's event stream open (cameras whose brand has one, that are monitored, online and
 * whose login works), so tampering, video loss, faults and failed logins are known the moment the
 * camera reports them, not at the next check. Streams that drop are reopened with a growing delay.
 */
export class EventStreams {
  private readonly running = new Map<string, Running>();
  private readonly handler: CameraEventHandler;
  private lockClient?: pg.PoolClient;
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(
    private readonly deps: { registry: BrandRegistry; notifier: Pick<Notifier, "dispatch"> },
    private readonly opts: { max: number; refreshMs?: number; sweepMs?: number; retryMinMs?: number } = { max: 5000 },
  ) {
    this.handler = new CameraEventHandler(deps.notifier);
  }

  get count() {
    return this.running.size;
  }

  start() {
    if (this.opts.max <= 0) return;
    const refresh = () => void this.refresh().catch((err) => logger.warn({ err: (err as Error).message }, "Camera event streams: refresh failed"));
    refresh();
    this.timers.push(setInterval(refresh, this.opts.refreshMs ?? REFRESH_MS));
    this.timers.push(setInterval(() => void this.handler.sweep().catch(() => undefined), this.opts.sweepMs ?? SWEEP_MS));
  }

  /** Takes the streams on if no other worker has them, then opens and closes them to match the cameras. */
  async refresh() {
    if (this.stopped) return;
    if (!this.lockClient) {
      const client = await pool.connect();
      const { rows } = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY]);
      if (!rows[0]?.ok) {
        client.release();
        return;
      }
      client.on("error", () => this.lostLock());
      this.lockClient = client;
      logger.info({ max: this.opts.max }, "Camera event streams: this worker keeps them open");
    }
    await this.handler.sweep();
    const { rows } = await pool.query<{ id: string; brand_key: string; key: string }>(
      `SELECT c.id, c.brand_key, c.brand_key || ':' || c.host || ':' || c.port || ':' || c.protocol || ':' || COALESCE(cr.updated_at::text, '') AS key
       FROM cameras c JOIN camera_status s ON s.camera_id = c.id
       JOIN camera_brands b ON b.key = c.brand_key AND b.status = 'enabled' AND b.deleted_at IS NULL
       JOIN organizations o ON o.id = c.organization_id AND o.is_active
       LEFT JOIN camera_credentials cr ON cr.camera_id = c.id
       WHERE c.deleted_at IS NULL AND c.monitoring_enabled AND c.event_stream
         AND s.connection_status = 'online' AND s.consecutive_auth_failures = 0
       ORDER BY (c.priority = 'critical') DESC, c.created_at`,
    );
    await this.deps.registry.refreshIfStale().catch(() => undefined);
    const wanted = new Map<string, string>();
    for (const r of rows) {
      if (wanted.size >= this.opts.max) break;
      let has = false;
      try {
        has = typeof this.deps.registry.get(r.brand_key).openEventStream === "function";
      } catch {
        has = false;
      }
      if (has) wanted.set(r.id, r.key);
    }
    for (const [id, run] of this.running) {
      if (wanted.get(id) !== run.key) this.close(id);
    }
    for (const [id, key] of wanted) {
      if (!this.running.has(id)) this.open(id, key);
    }
    // Cameras no longer streamed: their state goes back to unknown.
    await pool.query(
      "UPDATE camera_status SET events_state = NULL, events_error = NULL, events_since = NULL WHERE events_state IS NOT NULL AND NOT (camera_id = ANY($1::uuid[]))",
      [[...wanted.keys()]],
    );
  }

  private lostLock() {
    logger.warn("Camera event streams: lost the database lock, closing them");
    this.lockClient = undefined;
    for (const id of [...this.running.keys()]) this.close(id);
  }

  private open(cameraId: string, key: string) {
    const abort = new AbortController();
    const done = this.keepOpen(cameraId, abort.signal).finally(() => {
      if (this.running.get(cameraId)?.abort === abort) this.running.delete(cameraId);
    });
    this.running.set(cameraId, { key, abort, done });
  }

  private close(cameraId: string) {
    this.running.get(cameraId)?.abort.abort();
    this.running.delete(cameraId);
  }

  private async keepOpen(cameraId: string, signal: AbortSignal) {
    let retry = this.opts.retryMinMs ?? RETRY_MIN_MS;
    while (!signal.aborted) {
      let wait = retry;
      let password: string | undefined;
      const opened = { at: 0 };
      try {
        const brand = (await pool.query<{ brand_key: string }>("SELECT brand_key FROM cameras WHERE id = $1", [cameraId])).rows[0]?.brand_key;
        if (!brand) return;
        const adapter = this.deps.registry.get(brand);
        const cfg = await getCameraConfig(cameraId, 10_000);
        password = cfg.password;
        await adapter.openEventStream!(cfg, (e) => void this.handler.handle(cameraId, e), signal, () => {
          opened.at = Date.now();
          void this.setState(cameraId, "connected", null);
        });
        if (signal.aborted) return;
        // Ended by the camera: reopen soon.
        await this.setState(cameraId, "failed", "The camera closed its event stream; reopening");
      } catch (err) {
        if (signal.aborted) return;
        const code = err instanceof CameraApiError ? err.code : undefined;
        const message = redactSecrets(err instanceof Error ? err.message : String(err), [password]).slice(0, 300);
        if (code === "API_UNAVAILABLE") {
          wait = UNSUPPORTED_RETRY_MS;
          await this.setState(cameraId, "unsupported", message);
        } else if (code === "AUTH_FAILED" || code === "PERMISSION_DENIED") {
          wait = AUTH_RETRY_MS;
          await this.setState(cameraId, "failed", `${message} (tried again in 30 minutes)`);
        } else {
          await this.setState(cameraId, "failed", message);
        }
      }
      // A stream that stayed open a while starts the delays over.
      if (opened.at && Date.now() - opened.at > 2 * 60_000) retry = this.opts.retryMinMs ?? RETRY_MIN_MS;
      else retry = Math.min(retry * 2, RETRY_MAX_MS);
      await sleep(wait, signal);
    }
  }

  private async setState(cameraId: string, state: "connected" | "unsupported" | "failed", error: string | null) {
    await pool.query(
      `UPDATE camera_status SET events_error = $3,
              events_since = CASE WHEN events_state IS DISTINCT FROM $2 THEN now() ELSE events_since END,
              events_state = $2
       WHERE camera_id = $1`,
      [cameraId, state, error],
    ).catch(() => undefined);
  }

  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    const all = [...this.running.values()];
    for (const id of [...this.running.keys()]) this.close(id);
    await Promise.allSettled(all.map((r) => r.done));
    if (this.lockClient) {
      await this.lockClient.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => undefined);
      this.lockClient.release();
      this.lockClient = undefined;
    }
  }
}

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
