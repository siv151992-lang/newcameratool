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
  role: string;
  permissions: string[];
}

export interface AuthContext {
  user: AuthUser;
  sessionId: string;
  csrfToken: string;
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// Used to keep login timing similar whether or not the username exists.
let dummyHash: Promise<string> | undefined;

export async function login(username: string, password: string, meta: { ip?: string; userAgent?: string }) {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.password_hash, u.role, u.is_active, u.locked_until, r.permissions
     FROM users u JOIN roles r ON r.name = u.role WHERE lower(u.username) = lower($1)`,
    [username],
  );
  const user = rows[0];
  const invalid = new HttpError(401, "INVALID_CREDENTIALS", "Invalid username or password");
  if (!user) {
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
  await pool.query("UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [user.id]);

  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  await pool.query(
    `INSERT INTO sessions (id, user_id, csrf_token, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5, $6)`,
    [hashToken(token), user.id, csrfToken, config.SESSION_TTL_HOURS, meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null],
  );
  const authUser: AuthUser = {
    id: user.id, username: user.username, displayName: user.display_name, role: user.role, permissions: user.permissions,
  };
  return { token, csrfToken, user: authUser };
}

export async function getSession(token: string): Promise<AuthContext | null> {
  const id = hashToken(token);
  const { rows } = await pool.query(
    `SELECT s.id, s.csrf_token, s.last_seen_at, u.id AS user_id, u.username, u.display_name, u.role, r.permissions
     FROM sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.name = u.role
     WHERE s.id = $1 AND s.expires_at > now() AND u.is_active`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  if (Date.now() - new Date(r.last_seen_at).getTime() > 5 * 60_000) {
    await pool.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [id]);
  }
  return {
    sessionId: id,
    csrfToken: r.csrf_token,
    user: { id: r.user_id, username: r.username, displayName: r.display_name, role: r.role, permissions: r.permissions },
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
  if (!rows[0] || !(await verifyPassword(current, rows[0].password_hash))) {
    throw new HttpError(400, "INVALID_CREDENTIALS", "Current password is incorrect");
  }
  validateNewPassword(next);
  await pool.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [userId, await hashPassword(next)]);
  // Sign out other sessions after a password change.
  await pool.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [userId, sessionId]);
}
