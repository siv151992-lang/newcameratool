import { z } from "zod";
import { pool, withTransaction, type Queryable } from "../db/pool.js";
import { validateNewPassword } from "../auth/sessions.js";
import { HttpError, notFound } from "../lib/errors.js";
import { hashPassword } from "../security/passwords.js";
import { type Actor, audit } from "./auditService.js";

/**
 * Organizations and their members. Each organization owns its cameras, alerts, notification
 * channels, settings and audit log; people reach them through a membership with a role
 * (admin = Org Admin, operator, viewer). Only the system administrator creates organizations.
 */

export const ROLES = ["admin", "operator", "viewer"] as const;
export type Role = (typeof ROLES)[number];

const nameSchema = z.string().trim().min(1, "Organization name is required").max(120);
export const createOrganizationSchema = z.object({ name: nameSchema }).strict();
export const updateOrganizationSchema = z.object({ name: nameSchema.optional(), isActive: z.boolean().optional() }).strict();

const isUuid = (v: string) => z.string().uuid().safeParse(v).success;

function translateDuplicateName(err: unknown): never {
  if ((err as { code?: string }).code === "23505") throw new HttpError(409, "CONFLICT", "An organization with this name already exists");
  throw err;
}

export async function listOrganizations() {
  const { rows } = await pool.query(
    `SELECT o.id, o.name, o.is_active AS "isActive", o.created_at AS "createdAt",
            (SELECT count(*)::int FROM organization_members m WHERE m.organization_id = o.id) AS "members",
            (SELECT count(*)::int FROM organization_members m WHERE m.organization_id = o.id AND m.role = 'admin') AS "admins",
            (SELECT count(*)::int FROM cameras c WHERE c.organization_id = o.id AND c.deleted_at IS NULL) AS "cameras"
     FROM organizations o ORDER BY o.is_active DESC, lower(o.name)`,
  );
  return rows;
}

async function getOrganization(id: string, db: Queryable = pool) {
  if (!isUuid(id)) throw notFound("Organization");
  const { rows } = await db.query("SELECT id, name, is_active FROM organizations WHERE id = $1", [id]);
  if (!rows[0]) throw notFound("Organization");
  return rows[0] as { id: string; name: string; is_active: boolean };
}

/** Creates an organization; its creator becomes its first Org Admin so they can invite people. */
export async function createOrganization(input: z.infer<typeof createOrganizationSchema>, actor: Actor, ip?: string | null, db?: Queryable) {
  const run = async (client: Queryable) => {
    const { rows } = await client
      .query<{ id: string }>("INSERT INTO organizations (name, created_by) VALUES ($1, $2) RETURNING id", [input.name, actor.id])
      .catch(translateDuplicateName);
    const id = rows[0]!.id;
    await client.query("INSERT INTO organization_members (organization_id, user_id, role) VALUES ($1, $2, 'admin')", [id, actor.id]);
    await audit({ actor, ip, action: "organization.created", entityType: "organization", entityId: id, details: { name: input.name }, organizationId: null }, client);
    return id;
  };
  return db ? run(db) : withTransaction(run);
}

export async function updateOrganization(id: string, patch: z.infer<typeof updateOrganizationSchema>, actor: Actor, ip?: string | null) {
  const org = await getOrganization(id);
  await pool
    .query("UPDATE organizations SET name = coalesce($2, name), is_active = coalesce($3, is_active), updated_at = now() WHERE id = $1", [
      id, patch.name ?? null, patch.isActive ?? null,
    ])
    .catch(translateDuplicateName);
  const action = patch.isActive === false ? "organization.deactivated" : patch.isActive === true && !org.is_active ? "organization.reactivated" : "organization.updated";
  await audit({ actor, ip, action, entityType: "organization", entityId: id, details: { from: org.name, ...patch }, organizationId: null });
}

// ------------------------------------------------------------------ members

export const updateMemberSchema = z
  .object({
    role: z.enum(ROLES).optional(),
    displayName: z.string().trim().max(120).nullable().optional(),
    isActive: z.boolean().optional(),
    password: z.string().max(200).optional(),
  })
  .strict();

export async function listMembers(orgId: string) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name AS "displayName", u.email, m.role, u.is_active AS "isActive",
            u.last_login_at AS "lastLoginAt", (u.locked_until > now()) AS "locked", m.joined_at AS "joinedAt",
            (SELECT count(*)::int FROM organization_members o WHERE o.user_id = u.id) > 1 AS "otherOrganizations"
     FROM organization_members m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1 ORDER BY lower(u.username)`,
    [orgId],
  );
  return rows;
}

async function getMembership(orgId: string, userId: string, db: Queryable = pool) {
  if (!isUuid(userId)) throw notFound("Member");
  const { rows } = await db.query(
    `SELECT m.role, u.username, (SELECT count(*)::int FROM organization_members o WHERE o.user_id = u.id) AS memberships
     FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = $1 AND m.user_id = $2`,
    [orgId, userId],
  );
  if (!rows[0]) throw notFound("Member");
  return rows[0] as { role: Role; username: string; memberships: number };
}

/** Every organization keeps at least one active Org Admin. */
async function assertAnotherAdmin(orgId: string, userId: string, db: Queryable) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM organization_members m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = $1 AND m.role = 'admin' AND u.is_active AND m.user_id <> $2`,
    [orgId, userId],
  );
  if (rows[0].n === 0) throw new HttpError(400, "LAST_ADMIN", "Every organization needs at least one active Org Admin. Make someone else an Org Admin first.");
}

/**
 * Changes a member's role, and for people who belong only to this organization their name, password
 * and whether the account is active. Accounts shared with other organizations are changed by the
 * system administrator.
 */
export async function updateMember(
  orgId: string, userId: string, patch: z.infer<typeof updateMemberSchema>, actor: Actor & { isSystemAdmin?: boolean }, ip?: string | null,
) {
  await withTransaction(async (db) => {
    const m = await getMembership(orgId, userId, db);
    const accountFields = patch.displayName !== undefined || patch.isActive !== undefined || patch.password !== undefined;
    if (accountFields && m.memberships > 1 && !actor.isSystemAdmin) {
      throw new HttpError(403, "SHARED_ACCOUNT", "This person also belongs to another organization. Only the system administrator can change their account.");
    }
    const losesAdmin = m.role === "admin" && ((patch.role && patch.role !== "admin") || patch.isActive === false);
    if (losesAdmin) {
      if (userId === actor.id) throw new HttpError(400, "SELF_LOCKOUT", "You cannot remove your own Org Admin access");
      await assertAnotherAdmin(orgId, userId, db);
    }
    if (patch.role) await db.query("UPDATE organization_members SET role = $3 WHERE organization_id = $1 AND user_id = $2", [orgId, userId, patch.role]);
    if (accountFields) {
      if (patch.password !== undefined) validateNewPassword(patch.password);
      await db.query(
        `UPDATE users SET display_name = CASE WHEN $2::boolean THEN $3 ELSE display_name END,
                is_active = coalesce($4, is_active),
                password_hash = coalesce($5, password_hash),
                failed_login_count = CASE WHEN $5 IS NULL THEN failed_login_count ELSE 0 END,
                locked_until = CASE WHEN $5 IS NULL THEN locked_until ELSE NULL END,
                updated_at = now()
         WHERE id = $1`,
        [userId, patch.displayName !== undefined, patch.displayName ?? null, patch.isActive ?? null, patch.password !== undefined ? await hashPassword(patch.password) : null],
      );
    }
    if (patch.isActive === false || patch.password !== undefined) await db.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    await audit(
      {
        actor, ip, action: "member.updated", entityType: "user", entityId: userId,
        details: { username: m.username, fields: Object.keys(patch).map((k) => (k === "password" ? "password (reset)" : k)), role: patch.role },
      },
      db,
    );
  });
}

/** Removes someone from the organization. Their account stays (they may belong to other organizations). */
export async function removeMember(orgId: string, userId: string, actor: Actor, ip?: string | null) {
  return withTransaction(async (db) => {
    const m = await getMembership(orgId, userId, db);
    if (m.role === "admin") {
      if (userId === actor.id) throw new HttpError(400, "SELF_LOCKOUT", "You cannot remove yourself as Org Admin");
      await assertAnotherAdmin(orgId, userId, db);
    }
    await db.query("DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2", [orgId, userId]);
    // An account in no other organization is deleted with its sessions; system administrators are kept.
    const { rowCount } = await db.query(
      `DELETE FROM users u WHERE u.id = $1 AND NOT u.is_system_admin
         AND NOT EXISTS (SELECT 1 FROM organization_members om WHERE om.user_id = u.id)`,
      [userId],
    );
    const accountDeleted = Boolean(rowCount);
    // Otherwise, sessions open in this organization lose access at once.
    if (!accountDeleted) await db.query("UPDATE sessions SET organization_id = NULL WHERE user_id = $1 AND organization_id = $2", [userId, orgId]);
    await audit({ actor, ip, action: accountDeleted ? "user.deleted" : "member.removed", entityType: "user", entityId: userId, details: { username: m.username, role: m.role } }, db);
    return { accountDeleted };
  });
}

/** Adds an existing account to an organization (bootstrap, CLI, accepted invitations). */
export async function addMember(orgId: string, userId: string, role: Role, invitedBy: string | null, db: Queryable = pool) {
  await db.query(
    `INSERT INTO organization_members (organization_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, user_id) DO NOTHING`,
    [orgId, userId, role, invitedBy],
  );
}
