import { z } from "zod";
import { validateNewPassword } from "../auth/sessions.js";
import { config } from "../config.js";
import { pool, withTransaction, type Queryable } from "../db/pool.js";
import { HttpError } from "../lib/errors.js";
import { mailConfigured, publicLink, trySendMail } from "../notifications/mailer.js";
import { hashPassword } from "../security/passwords.js";
import { hashLinkToken, isLinkToken, newLinkToken } from "../security/tokens.js";
import { audit } from "./auditService.js";
import { acceptInvitation, invitationForSignup } from "./invitationService.js";
import { addMember } from "./organizationService.js";
import { createAccount, emailSchema, usernameSchema } from "./userService.js";

/**
 * Accounts people create themselves. An account belongs to no organization until its owner accepts
 * an invitation; a self-created one cannot sign in until its email address is confirmed. On a new
 * installation the first account becomes the system administrator, with the first organization.
 *
 * Answers never reveal whether another account uses an email address: "check your email" is the
 * reply either way, and the email itself says what happened.
 */

export const signupSchema = z
  .object({
    username: usernameSchema,
    displayName: z.string().trim().max(120).optional(),
    email: emailSchema,
    password: z.string().max(200),
    /** From an invitation link: the account is verified and joins that organization at once. */
    invitationToken: z.string().max(100).optional(),
  })
  .strict();

type TokenPurpose = "verify_email" | "reset_password";

async function hasUsers(db: Queryable = pool) {
  return (await db.query("SELECT 1 FROM users LIMIT 1")).rowCount! > 0;
}

/** What the sign-in page offers. */
export async function signInOptions() {
  const setup = !(await hasUsers());
  return {
    /** No account exists yet: the first one becomes the system administrator. */
    needsSetup: setup,
    signupEnabled: setup || (config.ALLOW_SIGNUP && mailConfigured()),
    passwordResetEnabled: mailConfigured(),
  };
}

async function issueToken(userId: string, email: string, purpose: TokenPurpose, db: Queryable = pool) {
  const { token, hash } = newLinkToken();
  // A new link replaces earlier unused ones for the same purpose.
  await db.query("UPDATE email_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL", [userId, purpose]);
  const minutes = purpose === "verify_email" ? config.EMAIL_VERIFICATION_EXPIRY_HOURS * 60 : config.PASSWORD_RESET_EXPIRY_MINUTES;
  await db.query(
    "INSERT INTO email_tokens (user_id, purpose, email, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))",
    [userId, purpose, email, hash, minutes],
  );
  return token;
}

async function sendVerification(userId: string, email: string) {
  const token = await issueToken(userId, email, "verify_email");
  await trySendMail({
    to: email,
    subject: "Confirm your email address for Zoho IBMS CCTV Monitoring",
    text: [
      "Confirm your email address to finish creating your account:",
      "",
      publicLink(`/verify-email?token=${token}`)!,
      "",
      `The link expires in ${config.EMAIL_VERIFICATION_EXPIRY_HOURS} hours. If you did not create an account, ignore this email.`,
    ].join("\n"),
  });
}

export type SignupResult =
  | { status: "signed_in"; userId: string; organizationId: string | null }
  | { status: "verification_sent" };

export async function signup(input: z.infer<typeof signupSchema>, ip?: string | null): Promise<SignupResult> {
  validateNewPassword(input.password);
  const account = { username: input.username, displayName: input.displayName, email: input.email, password: input.password };

  // A new installation: the first account sets it up.
  const first = await withTransaction(async (db) => {
    await db.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");
    if (await hasUsers(db)) return null;
    const id = await createAccount({ ...account, emailVerified: true, isSystemAdmin: true }, db);
    const org = (await db.query<{ id: string }>("INSERT INTO organizations (name, created_by) VALUES ($1, $2) RETURNING id", [config.DEFAULT_ORGANIZATION_NAME, id])).rows[0]!.id;
    await addMember(org, id, "admin", null, db);
    await audit({ actor: { id, username: input.username }, ip, action: "auth.signup", entityType: "user", entityId: id, details: { firstAccount: true }, organizationId: null }, db);
    return { id, org };
  });
  if (first) return { status: "signed_in", userId: first.id, organizationId: first.org };

  if (input.invitationToken) {
    // The invitation link proves the address, so the account is verified and joins at once.
    if (!isLinkToken(input.invitationToken)) throw new HttpError(404, "INVITATION_INVALID", "This invitation link is not valid.");
    await invitationForSignup(input.invitationToken, input.email);
    return withTransaction(async (db) => {
      const id = await createAccount({ ...account, emailVerified: true }, db).catch(existingEmail);
      await audit({ actor: { id, username: input.username }, ip, action: "auth.signup", entityType: "user", entityId: id, details: { invitation: true }, organizationId: null }, db);
      const joined = await acceptInvitation({ token: input.invitationToken! }, { id, username: input.username }, ip, db);
      return { status: "signed_in" as const, userId: id, organizationId: joined.organizationId };
    });
  }

  if (!config.ALLOW_SIGNUP) throw new HttpError(403, "SIGNUP_DISABLED", "Creating accounts is turned off. Ask an organization administrator for an invitation.");
  if (!mailConfigured()) throw new HttpError(503, "EMAIL_UNAVAILABLE", "Creating accounts needs email, which is not configured on this server. Ask an administrator for an invitation.");

  const existing = await pool.query<{ id: string; pending_verification: boolean }>(
    "SELECT id, pending_verification FROM users WHERE lower(email) = $1",
    [input.email],
  );
  if (existing.rows[0]) {
    // Someone already has (or is confirming) this address. Same answer as success; the email explains.
    const other = existing.rows[0];
    if (other.pending_verification) await sendVerification(other.id, input.email);
    else {
      await trySendMail({
        to: input.email,
        subject: "Someone tried to create an account with your email address",
        text: [
          "An account already exists for this email address, so no new account was created.",
          "",
          `Sign in: ${publicLink("/")}`,
          `Forgot your password? Reset it: ${publicLink("/forgot-password")}`,
          "",
          "If this was not you, you can ignore this email.",
        ].join("\n"),
      });
    }
    await audit({ actor: null, ip, action: "auth.signup_existing_email", entityType: "user", entityId: other.id, organizationId: null });
    return { status: "verification_sent" };
  }

  const id = await withTransaction(async (db) => {
    const id = await createAccount(account, db);
    await db.query("UPDATE users SET pending_verification = true WHERE id = $1", [id]);
    await audit({ actor: { id, username: input.username }, ip, action: "auth.signup", entityType: "user", entityId: id, organizationId: null }, db);
    return id;
  });
  await sendVerification(id, input.email);
  return { status: "verification_sent" };
}

/** An email-address conflict while creating an account from an invitation. */
function existingEmail(err: unknown): never {
  if (err instanceof HttpError && /email/.test(err.message)) {
    throw new HttpError(409, "ACCOUNT_EXISTS", "An account already uses this email address. Sign in with it to accept the invitation.");
  }
  throw err;
}

/** Uses a one-time email link. Returns the account it belongs to. */
async function consume(token: string, purpose: TokenPurpose, db: Queryable) {
  const invalid = new HttpError(400, "LINK_INVALID", purpose === "verify_email"
    ? "This confirmation link is not valid or has expired. Sign in to get a new one."
    : "This password reset link is not valid or has expired. Request a new one.");
  if (!isLinkToken(token)) throw invalid;
  const { rows } = await db.query<{ id: string; user_id: string; email: string; username: string }>(
    `UPDATE email_tokens t SET used_at = now() FROM users u
     WHERE t.token_hash = $1 AND t.purpose = $2 AND t.used_at IS NULL AND t.expires_at > now() AND u.id = t.user_id AND u.is_active
     RETURNING t.id, t.user_id, t.email, u.username`,
    [hashLinkToken(token), purpose],
  );
  if (!rows[0]) throw invalid;
  return rows[0];
}

/** Confirms an email address. The link signs the person in. */
export async function verifyEmail(token: string, ip?: string | null) {
  return withTransaction(async (db) => {
    const t = await consume(token, "verify_email", db);
    const updated = await db.query(
      "UPDATE users SET email_verified_at = now(), pending_verification = false WHERE id = $1 AND lower(email) = lower($2) RETURNING id",
      [t.user_id, t.email],
    );
    if (!updated.rowCount) throw new HttpError(400, "LINK_INVALID", "This link is for an address the account no longer uses.");
    await audit({ actor: { id: t.user_id, username: t.username }, ip, action: "auth.email_verified", entityType: "user", entityId: t.user_id, organizationId: null }, db);
    return t.user_id;
  });
}

/** Sends a new confirmation link if an unconfirmed account uses the address. Same answer either way. */
export async function resendVerification(email: string) {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE lower(email) = $1 AND pending_verification AND is_active", [email]);
  if (rows[0] && mailConfigured()) await sendVerification(rows[0].id, email);
}

/** Emails a password reset link if an active account uses the address. Same answer either way. */
export async function requestPasswordReset(email: string, ip?: string | null) {
  if (!mailConfigured()) throw new HttpError(503, "EMAIL_UNAVAILABLE", "Password reset needs email, which is not configured on this server. Ask an administrator.");
  const { rows } = await pool.query<{ id: string; username: string }>("SELECT id, username FROM users WHERE lower(email) = $1 AND is_active", [email]);
  if (!rows[0]) return;
  const token = await issueToken(rows[0].id, email, "reset_password");
  await trySendMail({
    to: email,
    subject: "Reset your Zoho IBMS CCTV Monitoring password",
    text: [
      `Someone asked to reset the password for ${rows[0].username}. To choose a new password, open:`,
      "",
      publicLink(`/reset-password?token=${token}`)!,
      "",
      `The link works once and expires in ${config.PASSWORD_RESET_EXPIRY_MINUTES} minutes. If you did not ask for this, ignore this email; your password stays the same.`,
    ].join("\n"),
  });
  await audit({ actor: null, ip, action: "auth.password_reset_requested", entityType: "user", entityId: rows[0].id, organizationId: null });
}

/** Sets a new password from a reset link; every session of the account is signed out. */
export async function resetPassword(token: string, password: string, ip?: string | null) {
  validateNewPassword(password);
  const hash = await hashPassword(password);
  await withTransaction(async (db) => {
    const t = await consume(token, "reset_password", db);
    // Receiving the link also confirms the address.
    await db.query(
      `UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL, updated_at = now(),
              email_verified_at = CASE WHEN lower(email) = lower($3) THEN coalesce(email_verified_at, now()) ELSE email_verified_at END,
              pending_verification = CASE WHEN lower(email) = lower($3) THEN false ELSE pending_verification END
       WHERE id = $1`,
      [t.user_id, hash, t.email],
    );
    await db.query("DELETE FROM sessions WHERE user_id = $1", [t.user_id]);
    await audit({ actor: { id: t.user_id, username: t.username }, ip, action: "auth.password_reset", entityType: "user", entityId: t.user_id, organizationId: null }, db);
  });
}
