import { z } from "zod";
import { config } from "../config.js";
import { pool, withTransaction, type Queryable } from "../db/pool.js";
import { HttpError } from "../lib/errors.js";
import { hashPassword } from "../security/passwords.js";
import { validateNewPassword } from "../auth/sessions.js";
import { type Actor, audit } from "./auditService.js";
import { addMember, ROLES, type Role } from "./organizationService.js";

export const usernameSchema = z.string().trim().min(3).max(64).regex(/^[a-zA-Z0-9._-]+$/, "Letters, numbers, dot, dash and underscore only");
export const emailSchema = z.string().trim().toLowerCase().max(254).email("Enter a valid email address");

/** An account added by an Org Admin straight into their organization (replaced by invitations). */
export const createUserSchema = z
  .object({
    username: usernameSchema,
    displayName: z.string().trim().max(120).optional(),
    email: emailSchema.optional(),
    password: z.string().max(200),
    role: z.enum(ROLES),
  })
  .strict();

interface AccountInput {
  username: string;
  displayName?: string | null;
  email?: string | null;
  password?: string | null;
  emailVerified?: boolean;
  isSystemAdmin?: boolean;
}

/** Creates a sign-in account (no organization). */
export async function createAccount(input: AccountInput, db: Queryable = pool): Promise<string> {
  if (input.password != null) validateNewPassword(input.password);
  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (username, display_name, email, email_verified_at, password_hash, is_system_admin)
       VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN now() END, $5, $6) RETURNING id`,
      [
        input.username, input.displayName ?? null, input.email ?? null, input.emailVerified ?? false,
        input.password != null ? await hashPassword(input.password) : null, input.isSystemAdmin ?? false,
      ],
    );
    return rows[0]!.id;
  } catch (err) {
    if ((err as { code?: string; constraint?: string }).code === "23505") {
      const email = (err as { constraint?: string }).constraint === "users_email_unique";
      throw new HttpError(409, "CONFLICT", email ? "An account with this email already exists" : "That username is already taken");
    }
    throw err;
  }
}

/** Adds a new account with a password to `orgId` with `role`. */
export async function createUser(orgId: string, input: z.infer<typeof createUserSchema>, actor: Actor | null, ip?: string | null) {
  return withTransaction(async (db) => {
    const id = await createAccount({ username: input.username, displayName: input.displayName, email: input.email, password: input.password }, db);
    await addMember(orgId, id, input.role, actor?.id ?? null, db);
    await audit({ actor, ip, organizationId: orgId, action: "user.created", entityType: "user", entityId: id, details: { username: input.username, role: input.role } }, db);
    return id;
  });
}

/**
 * The first system administrator, with an organization to work in: used by BOOTSTRAP_ADMIN_* and
 * `npm run create-admin`. Joins the oldest active organization, or creates the default one.
 */
export async function createSystemAdmin(input: { username: string; password: string; email?: string | null }) {
  return withTransaction(async (db) => {
    const id = await createAccount({ ...input, isSystemAdmin: true, emailVerified: Boolean(input.email) }, db);
    let org = (await db.query<{ id: string }>("SELECT id FROM organizations WHERE is_active ORDER BY created_at LIMIT 1")).rows[0]?.id;
    if (!org) {
      org = (await db.query<{ id: string }>("INSERT INTO organizations (name, created_by) VALUES ($1, $2) RETURNING id", [config.DEFAULT_ORGANIZATION_NAME, id])).rows[0]!.id;
    }
    await addMember(org, id, "admin" satisfies Role, null, db);
    await audit({ actor: null, action: "user.created", entityType: "user", entityId: id, details: { username: input.username, systemAdmin: true }, organizationId: null }, db);
    return id;
  });
}
