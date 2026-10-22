import { badRequest } from "../lib/errors.js";
import { pool, type Queryable } from "../db/pool.js";

export interface Actor {
  id: string;
  username: string;
}

export interface AuditEntry {
  actor: Actor | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
}

/** Records an audit event. Callers must never put passwords or other secrets in `details`. */
export async function audit(entry: AuditEntry, db: Queryable = pool) {
  await db.query(
    `INSERT INTO audit_logs (actor_user_id, actor_username, action, entity_type, entity_id, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.actor?.id ?? null,
      entry.actor?.username ?? "system",
      entry.action,
      entry.entityType,
      entry.entityId ?? null,
      JSON.stringify(entry.details ?? {}),
      entry.ip ?? null,
    ],
  );
}

export async function listAudit(opts: { page: number; pageSize: number; entityType?: string; entityId?: string }) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.entityType) where.push(`a.entity_type = $${params.push(opts.entityType)}`);
  if (opts.entityId) where.push(`a.entity_id = $${params.push(opts.entityId)}`);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs a ${clause}`, params)).rows[0]!.n;
  params.push(opts.pageSize, (opts.page - 1) * opts.pageSize);
  const { rows } = await pool.query(
    // Camera entries carry the camera's current name (removed cameras are soft-deleted, so still found).
    `SELECT a.id, a.actor_username, a.action, a.entity_type, a.entity_id, a.details, a.ip, a.created_at,
            COALESCE(c.name, a.details->>'name') AS camera_name, c.host AS camera_host,
            (c.id IS NULL OR c.deleted_at IS NOT NULL) AS camera_removed
     FROM audit_logs a
     LEFT JOIN cameras c ON a.entity_type = 'camera' AND c.id::text = a.entity_id
     ${clause} ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: rows, total };
}

/** Most rows one export returns; narrow the date range for more. */
export const AUDIT_EXPORT_MAX_ROWS = 100_000;

const CSV_COLUMNS = ["Time", "User", "Action", "Camera", "Camera IP", "Entity type", "Entity ID", "Details", "IP"];

/** A CSV cell, quoted when needed; a leading = + - @ is neutralised so spreadsheets do not run it as a formula. */
function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function describeDetails(details: Record<string, unknown>): string {
  return Object.entries(details ?? {})
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v !== null && typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join("; ");
}

/** Wall-clock parts of an instant in a time zone; throws a 400 for a zone the runtime does not know. */
function zonedParts(ms: number, timeZone: string) {
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    throw badRequest(`Unknown time zone "${timeZone}"`);
  }
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { text: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`, asUtcMs: Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) };
}

/** The instant a calendar day (YYYY-MM-DD) starts in a time zone, DST included. */
function startOfDay(day: string, timeZone: string): Date {
  const wall = Date.parse(`${day}T00:00:00Z`);
  let t = wall;
  for (let i = 0; i < 2; i++) t = wall - (zonedParts(t, timeZone).asUtcMs - t);
  return new Date(t);
}

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * The audit log as CSV (UTF-8 with BOM so Excel reads it), newest first. `from`/`to` are calendar
 * days (inclusive) and times are written in `timeZone`, the viewer's IANA time zone. Zones are
 * handled here rather than in PostgreSQL, which rejects some names browsers report (Asia/Calcutta).
 */
export async function exportAuditCsv(opts: { from?: string; to?: string; timeZone: string }) {
  zonedParts(Date.now(), opts.timeZone); // validates the zone
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.from) where.push(`a.created_at >= $${params.push(startOfDay(opts.from, opts.timeZone))}`);
  if (opts.to) where.push(`a.created_at < $${params.push(startOfDay(nextDay(opts.to), opts.timeZone))}`);
  params.push(AUDIT_EXPORT_MAX_ROWS);
  const { rows } = await pool.query(
    `SELECT a.created_at, a.actor_username, a.action,
            COALESCE(c.name, a.details->>'name') AS camera_name, c.host AS camera_host,
            a.entity_type, a.entity_id, a.details, a.ip
     FROM audit_logs a
     LEFT JOIN cameras c ON a.entity_type = 'camera' AND c.id::text = a.entity_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length}`,
    params,
  );
  const header = [`Time (${opts.timeZone})`, ...CSV_COLUMNS.slice(1)];
  const lines = [
    header,
    ...rows.map((r) => [
      zonedParts(new Date(r.created_at).getTime(), opts.timeZone).text,
      r.actor_username, r.action, r.camera_name, r.camera_host, r.entity_type, r.entity_id, describeDetails(r.details), r.ip,
    ]),
  ];
  return { csv: "\uFEFF" + lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n", rows: rows.length, truncated: rows.length === AUDIT_EXPORT_MAX_ROWS };
}
