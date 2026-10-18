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
  if (opts.entityType) where.push(`entity_type = $${params.push(opts.entityType)}`);
  if (opts.entityId) where.push(`entity_id = $${params.push(opts.entityId)}`);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = (await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_logs ${clause}`, params)).rows[0]!.n;
  params.push(opts.pageSize, (opts.page - 1) * opts.pageSize);
  const { rows } = await pool.query(
    `SELECT id, actor_username, action, entity_type, entity_id, details, ip, created_at
     FROM audit_logs ${clause} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { items: rows, total };
}
