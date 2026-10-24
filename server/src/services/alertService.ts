import { z } from "zod";
import { pool, withTransaction, type Queryable } from "../db/pool.js";
import { HttpError, notFound } from "../lib/errors.js";
import { type AlertCondition, type AlertType, SEVERITY_RANK, type Severity } from "../monitoring/evaluate.js";
import type { NotificationEvent } from "../notifications/types.js";
import { type Actor, audit } from "./auditService.js";

interface OpenAlert {
  id: number;
  type: AlertType;
  severity: Severity;
  status: "active" | "acknowledged";
}

export async function openAlertTypes(cameraId: string, db: Queryable = pool): Promise<Set<AlertType>> {
  const { rows } = await db.query<{ type: AlertType }>(
    "SELECT type FROM alerts WHERE camera_id = $1 AND status <> 'resolved'",
    [cameraId],
  );
  return new Set(rows.map((r) => r.type));
}

/**
 * Applies evaluated conditions to the alert table inside the caller's transaction.
 * - New condition       → open one alert (unique index guarantees one open alert per camera/type)
 * - Recurring condition → update last_seen/occurrence_count, record severity changes
 * - Cleared condition   → auto-resolve
 * Returns the events that should trigger notifications after the transaction commits.
 */
export async function applyConditions(
  db: Queryable,
  camera: { id: string; name: string; host: string },
  active: AlertCondition[],
  evaluated: AlertType[],
): Promise<NotificationEvent[]> {
  const { rows } = await db.query<OpenAlert>(
    "SELECT id, type, severity, status FROM alerts WHERE camera_id = $1 AND status <> 'resolved' FOR UPDATE",
    [camera.id],
  );
  const open = new Map(rows.map((r) => [r.type, r]));
  const events: NotificationEvent[] = [];
  const cam = { cameraId: camera.id, cameraName: camera.name, cameraHost: camera.host };

  for (const c of active) {
    const existing = open.get(c.type);
    if (!existing) {
      const ins = await db.query<{ id: number }>(
        `INSERT INTO alerts (camera_id, type, severity, status, title, description, context)
         VALUES ($1, $2, $3, 'active', $4, $5, $6)
         ON CONFLICT (camera_id, type) WHERE status <> 'resolved' DO NOTHING RETURNING id`,
        [camera.id, c.type, c.severity, c.title, c.description, JSON.stringify(c.context)],
      );
      if (!ins.rows[0]) continue; // opened concurrently by another process
      const id = ins.rows[0].id;
      await db.query(
        "INSERT INTO alert_events (alert_id, event_type, severity, message) VALUES ($1, 'opened', $2, $3)",
        [id, c.severity, c.description],
      );
      events.push({ kind: "opened", alertId: id, type: c.type, severity: c.severity, title: c.title, description: c.description, ...cam });
      continue;
    }
    const change = SEVERITY_RANK[c.severity] - SEVERITY_RANK[existing.severity];
    // An escalation re-activates an acknowledged alert so it is seen again.
    const status = change > 0 ? "active" : existing.status;
    await db.query(
      `UPDATE alerts SET severity = $2, status = $3, title = $4, description = $5, context = $6,
              last_seen_at = now(), occurrence_count = occurrence_count + 1
       WHERE id = $1`,
      [existing.id, c.severity, status, c.title, c.description, JSON.stringify(c.context)],
    );
    if (change !== 0) {
      const kind = change > 0 ? "escalated" : "deescalated";
      await db.query(
        "INSERT INTO alert_events (alert_id, event_type, severity, message) VALUES ($1, $2, $3, $4)",
        [existing.id, kind, c.severity, c.description],
      );
      if (change > 0) {
        events.push({ kind: "escalated", alertId: existing.id, type: c.type, severity: c.severity, title: c.title, description: c.description, ...cam });
      }
    }
  }

  const activeTypes = new Set(active.map((c) => c.type));
  for (const type of evaluated) {
    const existing = open.get(type);
    if (!existing || activeTypes.has(type)) continue;
    const upd = await db.query<{ title: string; severity: Severity }>(
      `UPDATE alerts SET status = 'resolved', resolved_at = now(), resolved_by = NULL, resolution_note = 'Condition cleared'
       WHERE id = $1 RETURNING title, severity`,
      [existing.id],
    );
    await db.query(
      "INSERT INTO alert_events (alert_id, event_type, message) VALUES ($1, 'auto_resolved', 'Condition cleared')",
      [existing.id],
    );
    const a = upd.rows[0]!;
    events.push({ kind: "resolved", alertId: existing.id, type, severity: a.severity, title: a.title, description: "Condition cleared", ...cam });
  }
  return events;
}

// ------------------------------------------------------------------ API operations

export const alertListQuery = z.object({
  status: z.enum(["open", "active", "acknowledged", "resolved", "all"]).default("open"),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  type: z.string().max(40).optional(),
  cameraId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

const SELECT_ALERT = `
  SELECT a.id, a.camera_id AS "cameraId", c.name AS "cameraName", c.host AS "cameraHost", c.priority AS "cameraPriority",
         (c.deleted_at IS NOT NULL) AS "cameraRemoved",
         a.type, a.severity, a.status, a.title, a.description, a.context,
         a.first_detected_at AS "firstDetectedAt", a.last_seen_at AS "lastSeenAt",
         a.occurrence_count AS "occurrenceCount",
         a.acknowledged_at AS "acknowledgedAt", ua.username AS "acknowledgedBy",
         a.resolved_at AS "resolvedAt", ur.username AS "resolvedBy", a.resolution_note AS "resolutionNote"
  FROM alerts a
  JOIN cameras c ON c.id = a.camera_id
  LEFT JOIN users ua ON ua.id = a.acknowledged_by
  LEFT JOIN users ur ON ur.id = a.resolved_by`;

export async function listAlerts(orgId: string, q: z.infer<typeof alertListQuery>) {
  const params: unknown[] = [orgId];
  const where: string[] = ["c.organization_id = $1"];
  const p = (v: unknown) => `$${params.push(v)}`;
  if (q.status === "open") where.push("a.status <> 'resolved'");
  else if (q.status !== "all") where.push(`a.status = ${p(q.status)}`);
  if (q.severity) where.push(`a.severity = ${p(q.severity)}`);
  if (q.type) where.push(`a.type = ${p(q.type)}`);
  if (q.cameraId) where.push(`a.camera_id = ${p(q.cameraId)}`);
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM alerts a JOIN cameras c ON c.id = a.camera_id ${clause}`, params)).rows[0]!.n;
  const { rows } = await pool.query(
    `${SELECT_ALERT} ${clause}
     ORDER BY (a.status = 'resolved'), (c.priority = 'critical') DESC,
              CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.last_seen_at DESC
     LIMIT ${p(q.pageSize)} OFFSET ${p((q.page - 1) * q.pageSize)}`,
    params,
  );
  return { items: rows, total, page: q.page, pageSize: q.pageSize };
}

export async function getAlert(orgId: string, id: string) {
  if (!/^\d{1,18}$/.test(id)) throw notFound("Alert");
  const { rows } = await pool.query(`${SELECT_ALERT} WHERE a.id = $1 AND c.organization_id = $2`, [id, orgId]);
  if (!rows[0]) throw notFound("Alert");
  const events = await pool.query(
    `SELECT e.event_type AS "eventType", e.severity, e.message, u.username AS actor, e.created_at AS "createdAt"
     FROM alert_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.alert_id = $1 ORDER BY e.created_at`,
    [id],
  );
  return { ...rows[0], events: events.rows };
}

export async function acknowledgeAlert(orgId: string, id: string, actor: Actor, note: string | undefined, ip?: string | null) {
  await getAlert(orgId, id);
  await withTransaction(async (db) => {
    const res = await db.query(
      `UPDATE alerts SET status = 'acknowledged', acknowledged_at = now(), acknowledged_by = $2
       WHERE id = $1 AND status = 'active' RETURNING id`,
      [id, actor.id],
    );
    if (!res.rowCount) throw new HttpError(409, "INVALID_STATE", "Only active alerts can be acknowledged");
    await db.query(
      "INSERT INTO alert_events (alert_id, event_type, message, actor_user_id) VALUES ($1, 'acknowledged', $2, $3)",
      [id, note ?? null, actor.id],
    );
    await audit({ actor, ip, action: "alert.acknowledged", entityType: "alert", entityId: id, details: note ? { note } : {} }, db);
  });
}

export async function resolveAlert(orgId: string, id: string, actor: Actor, note: string | undefined, ip?: string | null) {
  await getAlert(orgId, id);
  await withTransaction(async (db) => {
    const res = await db.query(
      `UPDATE alerts SET status = 'resolved', resolved_at = now(), resolved_by = $2, resolution_note = $3
       WHERE id = $1 AND status <> 'resolved' RETURNING id`,
      [id, actor.id, note ?? "Resolved manually"],
    );
    if (!res.rowCount) throw new HttpError(409, "INVALID_STATE", "Alert is already resolved");
    await db.query(
      "INSERT INTO alert_events (alert_id, event_type, message, actor_user_id) VALUES ($1, 'resolved', $2, $3)",
      [id, note ?? "Resolved manually", actor.id],
    );
    await audit({ actor, ip, action: "alert.resolved", entityType: "alert", entityId: id, details: note ? { note } : {} }, db);
  });
}
