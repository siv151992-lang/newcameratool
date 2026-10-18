import { z } from "zod";
import { pool } from "../db/pool.js";
import { HttpError, notFound } from "../lib/errors.js";
import { hashPassword } from "../security/passwords.js";
import { validateNewPassword } from "../auth/sessions.js";
import { type Actor, audit } from "./auditService.js";

export const createUserSchema = z
  .object({
    username: z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/, "Letters, numbers, dot, dash and underscore only"),
    displayName: z.string().trim().max(120).optional(),
    password: z.string().max(200),
    role: z.enum(["admin", "operator", "viewer"]),
  })
  .strict();

export const updateUserSchema = z
  .object({
    displayName: z.string().trim().max(120).nullable().optional(),
    role: z.enum(["admin", "operator", "viewer"]).optional(),
    isActive: z.boolean().optional(),
    password: z.string().max(200).optional(),
  })
  .strict();

export async function listUsers() {
  const { rows } = await pool.query(
    `SELECT id, username, display_name AS "displayName", role, is_active AS "isActive",
            last_login_at AS "lastLoginAt", (locked_until > now()) AS "locked", created_at AS "createdAt"
     FROM users ORDER BY lower(username)`,
  );
  return rows;
}

export async function createUser(input: z.infer<typeof createUserSchema>, actor: Actor | null, ip?: string | null) {
  validateNewPassword(input.password);
  try {
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO users (username, display_name, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id",
      [input.username, input.displayName ?? null, await hashPassword(input.password), input.role],
    );
    await audit({ actor, ip, action: "user.created", entityType: "user", entityId: rows[0]!.id, details: { username: input.username, role: input.role } });
    return rows[0]!.id;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") throw new HttpError(409, "CONFLICT", "That username is already taken");
    throw err;
  }
}

export async function updateUser(id: string, patch: z.infer<typeof updateUserSchema>, actor: Actor, ip?: string | null) {
  const { rows } = await pool.query("SELECT id, role, is_active FROM users WHERE id = $1", [id]).catch(() => ({ rows: [] }));
  const user = rows[0];
  if (!user) throw notFound("User");
  const losesAdmin = user.role === "admin" && ((patch.role && patch.role !== "admin") || patch.isActive === false);
  if (losesAdmin) {
    if (id === actor.id) throw new HttpError(400, "SELF_LOCKOUT", "You cannot remove your own administrator access");
    const admins = await pool.query("SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active");
    if (admins.rows[0].n <= 1) throw new HttpError(400, "LAST_ADMIN", "At least one active administrator is required");
  }
  if (patch.password !== undefined) validateNewPassword(patch.password);
  await pool.query(
    `UPDATE users SET display_name = CASE WHEN $2::boolean THEN $3 ELSE display_name END,
            role = coalesce($4, role), is_active = coalesce($5, is_active),
            password_hash = coalesce($6, password_hash),
            failed_login_count = CASE WHEN $6 IS NULL THEN failed_login_count ELSE 0 END,
            locked_until = CASE WHEN $6 IS NULL THEN locked_until ELSE NULL END,
            updated_at = now()
     WHERE id = $1`,
    [
      id, patch.displayName !== undefined, patch.displayName ?? null, patch.role ?? null, patch.isActive ?? null,
      patch.password !== undefined ? await hashPassword(patch.password) : null,
    ],
  );
  if (patch.isActive === false || patch.password !== undefined || patch.role) {
    await pool.query("DELETE FROM sessions WHERE user_id = $1", [id]);
  }
  await audit({
    actor, ip, action: "user.updated", entityType: "user", entityId: id,
    details: { fields: Object.keys(patch).map((k) => (k === "password" ? "password (reset)" : k)), role: patch.role },
  });
}
