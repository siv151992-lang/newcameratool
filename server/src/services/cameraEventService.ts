import { pool, withTransaction } from "../db/pool.js";
import type { CameraEvent, CameraEventKind } from "../integrations/events.js";
import { notFound } from "../lib/errors.js";
import { type AlertCondition, type AlertType, raiseForCriticalArea, type Severity } from "../monitoring/evaluate.js";
import type { Notifier } from "../notifications/notifier.js";
import type { NotificationEvent } from "../notifications/types.js";
import { applyConditions } from "./alertService.js";

/**
 * What the camera reports on its own (tampering, video loss, faults, failed logins), turned into
 * alerts and a history of events. The alert's context is the state: which channels have the problem
 * now, and until when each counts (an event that the camera repeats while it lasts, or a moment like
 * a failed login, ends by not coming again). So nothing is lost when the worker restarts.
 */

const ALERTS: Record<CameraEventKind, { type: AlertType; severity: Severity; title: string; momentary: boolean }> = {
  tamper: { type: "tamper", severity: "critical", title: "Camera tampered with", momentary: false },
  video_loss: { type: "video_loss", severity: "critical", title: "Video loss", momentary: false },
  device_fault: { type: "device_fault", severity: "warning", title: "Camera reported a fault", momentary: true },
  illegal_login: { type: "illegal_login", severity: "warning", title: "Failed logins on the camera", momentary: true },
};
export const EVENT_ALERT_TYPES: AlertType[] = Object.values(ALERTS).map((a) => a.type);

/** A fault or failed login: its alert resolves after this long without another. */
export const MOMENTARY_QUIET_MS = 3600_000;
/** A problem the camera ends with its own "inactive" (Dahua Stop): resolved after this long anyway, in case the end was missed. */
export const UNTIL_END_MAX_MS = 12 * 3600_000;
/** A repeated, unchanged event updates its alert at most this often. */
const WRITE_EVERY_MS = 30_000;
/** A repeated moment (failed logins) is kept in the history at most this often. */
const HISTORY_EVERY_MS = 60_000;

/** Channel ("0": the camera as a whole) → until when the problem counts (ISO time). */
type Channels = Record<string, string>;
interface EventContext { channels?: Channels; expiresAt?: string; eventType?: string; detail?: string; count?: number }

export class CameraEventHandler {
  /** camera:kind → the last write and whether an alert is open (known after the first look). */
  private readonly memo = new Map<string, { open: boolean; channels: string; wroteAt: number; historyAt: number; nvr: boolean }>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly notifier: Pick<Notifier, "dispatch">, private readonly now: () => number = Date.now) {}

  /** Handles one event from a camera's stream (one at a time per camera, in order). */
  handle(cameraId: string, e: CameraEvent): Promise<void> {
    const prev = this.queues.get(cameraId) ?? Promise.resolve();
    const next = prev.then(() => this.apply(cameraId, e)).catch(() => undefined);
    this.queues.set(cameraId, next);
    void next.finally(() => {
      if (this.queues.get(cameraId) === next) this.queues.delete(cameraId);
    });
    return next;
  }

  private async apply(cameraId: string, e: CameraEvent) {
    const key = `${cameraId}:${e.kind}`;
    const memo = this.memo.get(key);
    // A camera's own events are about the camera as a whole; an NVR's name the channel.
    const channel = memo && !memo.nvr ? "0" : String(e.channel ?? 0);
    const momentary = ALERTS[e.kind].momentary;
    // The end of a problem the camera does not have (Hikvision's heartbeat is "video loss: inactive").
    if (e.state === "inactive" && (momentary || memo?.open === false)) return;
    // The same problem again, written moments ago: nothing changes.
    if (e.state === "active" && memo?.open && memo.channels.split(",").includes(channel) && this.now() - memo.wroteAt < WRITE_EVERY_MS) {
      if (!momentary || this.now() - memo.historyAt < HISTORY_EVERY_MS) return;
    }
    await this.update(cameraId, e.kind, e);
  }

  /** Resolves the problems that ended by not being reported again (call every half minute or so). */
  async sweep(): Promise<number> {
    const { rows } = await pool.query<{ camera_id: string; type: AlertType }>(
      `SELECT camera_id, type FROM alerts WHERE type = ANY($1::text[]) AND status <> 'resolved'
         AND (context->>'expiresAt') IS NOT NULL AND (context->>'expiresAt')::timestamptz < $2`,
      [EVENT_ALERT_TYPES, new Date(this.now())],
    );
    for (const r of rows) {
      const kind = (Object.keys(ALERTS) as CameraEventKind[]).find((k) => ALERTS[k].type === r.type)!;
      await this.update(r.camera_id, kind);
    }
    return rows.length;
  }

  /** Applies an event (or, without one, just lets expired channels go) to the camera's alert of this kind. */
  private async update(cameraId: string, kind: CameraEventKind, e?: CameraEvent) {
    const spec = ALERTS[kind];
    const key = `${cameraId}:${kind}`;
    const now = this.now();
    const events = await withTransaction(async (db): Promise<NotificationEvent[]> => {
      const cam = (await db.query<{ id: string; name: string; host: string; priority: string; in_maintenance: boolean; device_type: string }>(
        `SELECT id, name, host, priority, device_type, (maintenance_until > now()) AS in_maintenance FROM cameras
         WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [cameraId],
      )).rows[0];
      if (!cam) return [];
      const open = (await db.query<{ context: EventContext }>(
        "SELECT context FROM alerts WHERE camera_id = $1 AND type = $2 AND status <> 'resolved'",
        [cameraId, spec.type],
      )).rows[0];
      const before: Channels = { ...(open?.context.channels ?? {}) };
      const channels: Channels = { ...before };
      const history: { state: "active" | "inactive"; channel: string; type: string; detail: string }[] = [];
      const memo = this.memo.get(key);

      if (e) {
        const ch = cam.device_type === "nvr" ? String(e.channel ?? 0) : "0";
        if (e.state === "active") {
          const lasts = spec.momentary ? MOMENTARY_QUIET_MS : e.repeatsWithinMs ?? UNTIL_END_MAX_MS;
          channels[ch] = new Date(now + Math.max(lasts, 0)).toISOString();
          const isNew = !before[ch] || Date.parse(before[ch]!) <= now;
          if (isNew || (spec.momentary && now - (memo?.historyAt ?? 0) >= HISTORY_EVERY_MS)) {
            history.push({ state: "active", channel: ch, type: e.type, detail: e.detail });
          }
        } else if (channels[ch]) {
          delete channels[ch];
          history.push({ state: "inactive", channel: ch, type: e.type, detail: `${e.detail}: ended` });
        }
      }
      // Problems no longer reported have ended.
      for (const [ch, until] of Object.entries(channels)) {
        if (Date.parse(until) <= now) {
          delete channels[ch];
          if (!spec.momentary) history.push({ state: "inactive", channel: ch, type: open?.context.eventType ?? kind, detail: "No longer reported by the camera: ended" });
        }
      }

      const names = await channelNames(db, cameraId, [...new Set([...Object.keys(channels), ...history.map((h) => h.channel)])]);
      for (const h of history) {
        await db.query(
          "INSERT INTO camera_events (camera_id, kind, event_type, state, channel, detail, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [cameraId, kind, h.type.slice(0, 60), h.state, h.channel === "0" ? null : Number(h.channel), h.detail.slice(0, 300), new Date(now)],
        );
      }
      if (e) await db.query("UPDATE camera_status SET events_last_at = $2 WHERE camera_id = $1", [cameraId, new Date(now)]);

      const list = Object.keys(channels).sort((a, b) => Number(a) - Number(b));
      this.memo.set(key, {
        open: list.length > 0 && (Boolean(open) || !cam.in_maintenance),
        channels: list.join(","),
        wroteAt: now,
        historyAt: history.some((h) => h.state === "active") ? now : memo?.historyAt ?? 0,
        nvr: cam.device_type === "nvr",
      });
      const target = { id: cam.id, name: cam.name, host: cam.host };
      if (!list.length) return open ? applyConditions(db, target, [], [spec.type]) : [];
      // Planned work: no new alerts (one already open is kept up to date).
      if (!open && cam.in_maintenance) return [];
      const where = list.filter((c) => c !== "0").map((c) => names.get(c) ? `channel ${c} (${names.get(c)})` : `channel ${c}`);
      const detail = e?.state === "active" ? e.detail : open?.context.detail ?? spec.title;
      const context: EventContext = {
        channels,
        expiresAt: list.map((c) => channels[c]!).sort().at(-1),
        eventType: e?.type ?? open?.context.eventType,
        detail,
        count: (open?.context.count ?? 0) + (e?.state === "active" ? 1 : 0),
      };
      let cond: AlertCondition = {
        type: spec.type,
        severity: spec.severity,
        title: spec.title,
        description: where.length ? `${detail} (on ${where.join(", ")})` : detail,
        context: context as Record<string, unknown>,
      };
      if (cam.priority === "critical") cond = raiseForCriticalArea(cond);
      return applyConditions(db, target, [cond], []);
    });
    if (events.length) this.notifier.dispatch(events).catch(() => undefined);
  }
}

async function channelNames(db: { query: typeof pool.query }, cameraId: string, channels: string[]): Promise<Map<string, string>> {
  const nums = channels.filter((c) => c !== "0").map(Number);
  if (!nums.length) return new Map();
  const { rows } = await db.query<{ channel: number; name: string | null }>(
    "SELECT channel, name FROM nvr_channels WHERE camera_id = $1 AND channel = ANY($2::int[])",
    [cameraId, nums],
  );
  return new Map(rows.filter((r) => r.name).map((r) => [String(r.channel), r.name!]));
}

/** The camera's latest events, newest first. */
export async function listCameraEvents(orgId: string, cameraId: string, limit = 50) {
  const cam = await pool.query("SELECT 1 FROM cameras WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL", [cameraId, orgId]);
  if (!cam.rowCount) throw notFound("Camera");
  const { rows } = await pool.query(
    `SELECT id::text, occurred_at AS "occurredAt", kind, event_type AS "eventType", state, channel, detail
     FROM camera_events WHERE camera_id = $1 ORDER BY occurred_at DESC, id DESC LIMIT $2`,
    [cameraId, Math.min(Math.max(limit, 1), 200)],
  );
  return rows;
}
