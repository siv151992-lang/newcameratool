import { createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { hashPassword, PASSWORD_POLICY, verifyPassword } from "../security/passwords.js";
import { HttpError } from "../lib/errors.js";

export const SESSION_COOKIE = "cctv_session";
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

export interface AuthUser {
  id: string;
  username: string;
  displayName: string | null;
  email: string | null;
  /** Role in the current organization (admin = Org Admin, operator, viewer); null without one. */
  role: string | null;
  /** Permissions of that role, plus "system:manage" for the system administrator. */
  permissions: string[];
  isSystemAdmin: boolean;
  /** The organization this session works in; every organization-owned query is limited to it. */
  organizationId: string | null;
  organizationName: string | null;
}

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
  csrfToken: string;
}

/** Permission held by the system administrator: organizations, brand integrations, camera networks, worker capacity. */
export const SYSTEM_PERMISSION = "system:manage";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Used to keep login timing similar whether or not the username exists.
let dummyHash: Promise<string> | undefined;

export async function login(identifier: string, password: string, meta: { ip?: string; userAgent?: string }) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.password_hash, u.is_active, u.locked_until, u.pending_verification
     FROM users u WHERE lower(u.username) = lower($1) OR lower(u.email) = lower($1)
     ORDER BY (lower(u.username) = lower($1)) DESC LIMIT 1`,
    [identifier],
  );
  const user = rows[0];
  const invalid = new HttpError(401, "INVALID_CREDENTIALS", "Invalid username, email or password");
  if (!user || !user.password_hash) {
    dummyHash ??= hashPassword("timing-equaliser");
    await verifyPassword(password, await dummyHash);
    throw invalid;
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new HttpError(423, "ACCOUNT_LOCKED", "Too many failed attempts. Try again later.");
  }
  if (!(await verifyPassword(password, user.password_hash)) || !user.is_active) {
    await pool.query(
      `UPDATE users SET failed_login_count = failed_login_count + 1,
              locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
       WHERE id = $1`,
      [user.id, MAX_FAILED_LOGINS, LOCKOUT_MINUTES],
    );
    throw invalid;
  }
  await pool.query("UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1", [user.id]);
  // Only after the password matched, so this does not reveal which addresses have accounts.
  if (user.pending_verification) {
    throw new HttpError(403, "EMAIL_NOT_VERIFIED", "Confirm your email address first: open the link we emailed you, or ask for a new one.");
  }
  return startSession(user.id, meta);
}

/**
 * Opens a session for a verified user (password, invitation or Google/Zoho sign-in). It starts in
 * `organizationId` when given, otherwise in the organization the user last worked in, or their oldest
 * membership.
 */
export async function startSession(userId: string, meta: { ip?: string; userAgent?: string }, organizationId?: string) {
  const org = organizationId ?? (await defaultOrganization(userId));
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  await pool.query(
    `INSERT INTO sessions (id, user_id, csrf_token, expires_at, ip, user_agent, organization_id)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5, $6, $7)`,
    [hashToken(token), userId, csrfToken, config.SESSION_TTL_HOURS, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null, org],
  );
  await pool.query("UPDATE users SET last_login_at = now() WHERE id = $1", [userId]);
  const ctx = await getSession(token);
  return { token, csrfToken, user: ctx!.user };
}

async function defaultOrganization(userId: string): Promise<string | null> {
  const { rows } = await pool.query<{ organization_id: string }>(
    `SELECT m.organization_id FROM organization_members m JOIN organizations o ON o.id = m.organization_id AND o.is_active
     LEFT JOIN LATERAL (SELECT max(s.last_seen_at) AS seen FROM sessions s WHERE s.user_id = m.user_id AND s.organization_id = m.organization_id) last ON true
     WHERE m.user_id = $1 ORDER BY last.seen DESC NULLS LAST, m.joined_at LIMIT 1`,
    [userId],
  );
  return rows[0]?.organization_id ?? null;
}

/** Moves a session to another organization the user belongs to. */
export async function switchOrganization(sessionId: string, userId: string, organizationId: string) {
  const { rowCount } = await pool.query(
    `UPDATE sessions s SET organization_id = $3 WHERE s.id = $1 AND s.user_id = $2
       AND EXISTS (SELECT 1 FROM organization_members m JOIN organizations o ON o.id = m.organization_id AND o.is_active
                   WHERE m.user_id = $2 AND m.organization_id = $3)`,
    [sessionId, userId, organizationId],
  );
  if (!rowCount) throw new HttpError(404, "NOT_FOUND", "Organization not found");
}

/** The organizations a user belongs to, with their role in each. */
export async function listMemberships(userId: string) {
  const { rows } = await pool.query(
    `SELECT o.id, o.name, m.role FROM organization_members m JOIN organizations o ON o.id = m.organization_id AND o.is_active
     WHERE m.user_id = $1 ORDER BY lower(o.name)`,
    [userId],
  );
  return rows as { id: string; name: string; role: string }[];
}

export async function getSession(token: string): Promise<AuthContext | null> {
  const id = hashToken(token);
  // A removed membership or deactivated organization leaves the session without an organization.
  const { rows } = await pool.query(
    `SELECT s.id, s.csrf_token, s.last_seen_at, u.id AS user_id, u.username, u.display_name, u.email, u.is_system_admin,
            o.id AS organization_id, o.name AS organization_name, m.role, coalesce(r.permissions, '{}') AS permissions
     FROM sessions s JOIN users u ON u.id = s.user_id
     LEFT JOIN organization_members m ON m.user_id = u.id AND m.organization_id = s.organization_id
     LEFT JOIN organizations o ON o.id = m.organization_id AND o.is_active
     LEFT JOIN roles r ON r.name = m.role AND o.id IS NOT NULL
     WHERE s.id = $1 AND s.expires_at > now() AND u.is_active`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  if (Date.now() - new Date(r.last_seen_at).getTime() > 5 * 60_000) {
    await pool.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [id]);
  }
  const inOrg = r.organization_id !== null;
  return {
    sessionId: id,
    csrfToken: r.csrf_token,
    user: {
      id: r.user_id, username: r.username, displayName: r.display_name, email: r.email ?? null,
      role: inOrg ? r.role : null,
      permissions: [...(inOrg ? r.permissions : []), ...(r.is_system_admin ? [SYSTEM_PERMISSION] : [])],
      isSystemAdmin: r.is_system_admin,
      organizationId: inOrg ? r.organization_id : null,
      organizationName: inOrg ? r.organization_name : null,
    },
  };
}

export async function logout(sessionId: string) {
  await pool.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
}

export function validateNewPassword(password: string) {
  if (password.length < PASSWORD_POLICY.minLength) {
    throw new HttpError(400, "WEAK_PASSWORD", `Password must be at least ${PASSWORD_POLICY.minLength} characters`);
  }
}

export async function changeOwnPassword(userId: string, sessionId: string, current: string, next: string) {
  const { rows } = await pool.query("SELECT password_hash FROM users WHERE id = $1", [userId]);
  // Accounts created with Google or Zoho have no password yet: they may set one.
  if (rows[0]?.password_hash && !(await verifyPassword(current, rows[0].password_hash))) {
    throw new HttpError(400, "INVALID_CREDENTIALS", "Current password is incorrect");
  }
  validateNewPassword(next);
  await pool.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [userId, await hashPassword(next)]);
  // Sign out other sessions after a password change.
  await pool.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [userId, sessionId]);
}
