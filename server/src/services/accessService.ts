import { z } from "zod";
import { pool } from "../db/pool.js";
import { notFound } from "../lib/errors.js";

/**
 * Access control systems (access controllers and terminals, BioStar 2 and Command Centre servers):
 * each one with its readers, doors and controllers as last read, and their access events. They are
 * devices of type "access", added, edited, checked and removed like cameras.
 */

const POINT_COUNTS = `
  SELECT count(*) FILTER (WHERE kind <> 'door')::int AS readers,
         count(*) FILTER (WHERE kind <> 'door' AND online = false)::int AS readers_offline,
         count(*) FILTER (WHERE kind = 'door')::int AS doors,
         count(*) FILTER (WHERE kind = 'door' AND door_state IN ('open', 'held_open', 'forced'))::int AS doors_open,
         count(*) FILTER (WHERE kind = 'door' AND door_state IN ('held_open', 'forced'))::int AS doors_alarm,
         count(*) FILTER (WHERE tamper)::int AS tamper
  FROM access_points p WHERE p.camera_id = c.id`;

export async function listAccessSystems(orgId: string) {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.host, c.port, c.protocol, c.brand_key AS brand, b.display_name AS "brandName", c.location,
            c.monitoring_enabled AS "monitoringEnabled", s.connection_status AS connection, s.last_success_at AS "lastSuccessAt",
            s.last_error_message AS "lastError", s.access_error AS "accessError", s.access_at AS "readAt",
            row_to_json(pc) AS points,
            (SELECT count(*)::int FROM alerts a WHERE a.camera_id = c.id AND a.status <> 'resolved') AS "openAlerts",
            (SELECT json_build_object('total', count(*), 'denied', count(*) FILTER (WHERE e.category = 'denied'))
             FROM access_events e WHERE e.camera_id = c.id AND e.occurred_at > now() - interval '24 hours') AS "lastDay"
     FROM cameras c JOIN camera_brands b ON b.key = c.brand_key LEFT JOIN camera_status s ON s.camera_id = c.id
     LEFT JOIN LATERAL (${POINT_COUNTS}) pc ON true
     WHERE c.organization_id = $1 AND c.deleted_at IS NULL AND c.device_type = 'access'
     ORDER BY c.name`,
    [orgId],
  );
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((n, r) => n + f(r), 0);
  return {
    summary: {
      systems: rows.length,
      systemsOffline: rows.filter((r) => r.monitoringEnabled && r.connection === "offline").length,
      readers: sum((r) => r.points.readers),
      readersOffline: sum((r) => r.points.readers_offline),
      doors: sum((r) => r.points.doors),
      doorsOpen: sum((r) => r.points.doors_open),
      doorAlarms: sum((r) => r.points.doors_alarm),
      tamper: sum((r) => r.points.tamper),
      deniedLastDay: sum((r) => r.lastDay.denied),
    },
    systems: rows.map((r) => ({
      ...r,
      points: { readers: r.points.readers, readersOffline: r.points.readers_offline, doors: r.points.doors, doorsOpen: r.points.doors_open, doorAlarms: r.points.doors_alarm, tamper: r.points.tamper },
    })),
  };
}

async function ownSystem(orgId: string, id: string) {
  if (!z.string().uuid().safeParse(id).success) throw notFound("Access system");
  const { rowCount } = await pool.query("SELECT 1 FROM cameras WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL AND device_type = 'access'", [id, orgId]);
  if (!rowCount) throw notFound("Access system");
}

/** A system's readers, doors and controllers: problems first, then by name. */
export async function listAccessPoints(orgId: string, id: string) {
  await ownSystem(orgId, id);
  const { rows } = await pool.query(
    `SELECT id::text, kind, external_id AS "externalId", name, model, online, door_state AS "doorState", lock_state AS "lockState",
            tamper, status_text AS "statusText", updated_at AS "updatedAt"
     FROM access_points WHERE camera_id = $1
     ORDER BY (tamper IS TRUE OR door_state IN ('forced', 'held_open') OR online = false) DESC,
              CASE kind WHEN 'controller' THEN 0 WHEN 'reader' THEN 1 ELSE 2 END, name`,
    [id],
  );
  return rows;
}

export const accessEventsQuery = z.object({
  systemId: z.string().uuid().optional(),
  category: z.enum(["granted", "denied", "door", "alarm", "tamper", "fault", "other"]).optional(),
  /** Problems only: denied, forced or held doors, alarms, tamper, faults. */
  problems: z.enum(["true", "false"]).optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

/** Access events, newest first, across the organization's systems or of one. */
export async function listAccessEvents(orgId: string, q: z.infer<typeof accessEventsQuery>) {
  if (q.systemId) await ownSystem(orgId, q.systemId);
  const params: unknown[] = [orgId];
  const p = (v: unknown) => `$${params.push(v)}`;
  const where = ["c.organization_id = $1", "c.deleted_at IS NULL"];
  if (q.systemId) where.push(`e.camera_id = ${p(q.systemId)}`);
  if (q.category) where.push(`e.category = ${p(q.category)}`);
  if (q.problems === "true") where.push("(e.category IN ('denied', 'alarm', 'tamper', 'fault') OR (e.category = 'door' AND e.description ~* 'forced|held|too long|abnormal'))");
  if (q.search) {
    const like = p(`%${q.search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    where.push(`(e.person ILIKE ${like} OR e.point ILIKE ${like} OR e.description ILIKE ${like})`);
  }
  const { rows } = await pool.query(
    `SELECT e.id::text, e.occurred_at AS "occurredAt", e.category, e.description, e.person, e.point,
            c.id AS "systemId", c.name AS "systemName"
     FROM access_events e JOIN cameras c ON c.id = e.camera_id
     WHERE ${where.join(" AND ")}
     ORDER BY e.occurred_at DESC, e.id DESC LIMIT ${p(q.limit)}`,
    params,
  );
  return rows;
}
