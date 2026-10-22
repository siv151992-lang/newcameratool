import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { requireAuth, requireCsrf } from "../auth/middleware.js";
import type { Request, Response } from "express";
import { changeOwnPassword, listMemberships, login, logout, SESSION_COOKIE, startSession, switchOrganization } from "../auth/sessions.js";
import { emailSchema } from "../services/userService.js";
import {
  requestPasswordReset,
  resendVerification,
  resetPassword,
  signInOptions,
  signup,
  signupSchema,
  verifyEmail,
} from "../services/accountService.js";
import { acceptInvitation, pendingInvitationsFor, previewInvitation } from "../services/invitationService.js";
import { parse } from "../lib/validate.js";
import { pool } from "../db/pool.js";
import { audit } from "../services/auditService.js";
import { accountLimiter, loginLimiter } from "./limits.js";

export const authRouter = Router();

const cookieOptions = () => ({
  httpOnly: true,
  secure: config.COOKIE_SECURE,
  sameSite: "strict" as const,
  path: "/",
  maxAge: config.SESSION_TTL_HOURS * 3600_000,
});

/** Starts a session for `userId` and sets the cookie (after sign-up, an email link or an invitation). */
async function signInAs(req: Request, res: Response, userId: string, organizationId?: string | null) {
  const result = await startSession(userId, { ip: req.ip, userAgent: req.get("user-agent") }, organizationId ?? undefined);
  res.cookie(SESSION_COOKIE, result.token, cookieOptions());
  return result;
}

const token = z.string().min(1).max(100);

/** What the sign-in page offers (creating accounts, password reset, first-time setup). */
authRouter.get("/options", async (_req, res) => {
  res.json(await signInOptions());
});

authRouter.post("/signup", accountLimiter, async (req, res) => {
  const result = await signup(parse(signupSchema, req.body), req.ip);
  if (result.status === "verification_sent") {
    res.status(202).json({ status: "verification_sent" });
    return;
  }
  const session = await signInAs(req, res, result.userId, result.organizationId);
  res.status(201).json({ status: "signed_in", user: session.user, csrfToken: session.csrfToken });
});

authRouter.post("/verify-email", accountLimiter, async (req, res) => {
  const userId = await verifyEmail(parse(z.object({ token }).strict(), req.body).token, req.ip);
  const session = await signInAs(req, res, userId);
  res.json({ user: session.user, csrfToken: session.csrfToken });
});

authRouter.post("/resend-verification", accountLimiter, async (req, res) => {
  await resendVerification(parse(z.object({ email: emailSchema }).strict(), req.body).email);
  res.status(202).json({ status: "sent_if_needed" });
});

authRouter.post("/forgot-password", accountLimiter, async (req, res) => {
  await requestPasswordReset(parse(z.object({ email: emailSchema }).strict(), req.body).email, req.ip);
  res.status(202).json({ status: "sent_if_account" });
});

authRouter.post("/reset-password", accountLimiter, async (req, res) => {
  const body = parse(z.object({ token, password: z.string().max(200) }).strict(), req.body);
  await resetPassword(body.token, body.password, req.ip);
  res.status(204).end();
});

/** The invitation page, before signing in. */
authRouter.get("/invitations/:token", accountLimiter, async (req, res) => {
  res.json(await previewInvitation(String(req.params.token)));
});

/** Accepts an invitation (by its link token, or by id from the signed-in user's own list) and opens that organization. */
authRouter.post("/invitations/accept", requireAuth, requireCsrf, accountLimiter, async (req, res) => {
  const body = parse(z.union([z.object({ token }).strict(), z.object({ id: z.string().uuid() }).strict()]), req.body);
  const joined = await acceptInvitation(body, { id: req.auth!.user.id, username: req.auth!.user.username }, req.ip);
  await switchOrganization(req.auth!.sessionId, req.auth!.user.id, joined.organizationId);
  res.json(joined);
});

authRouter.post("/login", loginLimiter, async (req, res) => {
  // "username" also accepts the account's email address.
  const body = parse(z.object({ username: z.string().trim().min(1).max(254), password: z.string().min(1).max(200) }), req.body);
  try {
    const result = await login(body.username, body.password, { ip: req.ip, userAgent: req.get("user-agent") });
    res.cookie(SESSION_COOKIE, result.token, cookieOptions());
    await audit({ actor: { id: result.user.id, username: result.user.username }, ip: req.ip, action: "auth.login", entityType: "user", entityId: result.user.id, organizationId: null });
    res.json({ user: result.user, csrfToken: result.csrfToken });
  } catch (err) {
    await audit({ actor: null, ip: req.ip, action: "auth.login_failed", entityType: "user", details: { username: body.username } });
    throw err;
  }
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const { rows } = await pool.query<{ verified: boolean }>("SELECT email_verified_at IS NOT NULL AS verified FROM users WHERE id = $1", [req.auth!.user.id]);
  res.json({
    user: req.auth!.user,
    csrfToken: req.auth!.csrfToken,
    organizations: await listMemberships(req.auth!.user.id),
    // Open invitations to the user's confirmed address, to accept from the app.
    invitations: rows[0]?.verified ? await pendingInvitationsFor(req.auth!.user.email) : [],
  });
});

/** Switches the session to another organization the user belongs to. */
authRouter.post("/organization", requireAuth, requireCsrf, async (req, res) => {
  const { organizationId } = parse(z.object({ organizationId: z.string().uuid() }).strict(), req.body);
  await switchOrganization(req.auth!.sessionId, req.auth!.user.id, organizationId);
  await audit({ actor: { id: req.auth!.user.id, username: req.auth!.user.username }, ip: req.ip, action: "auth.organization_switched", entityType: "organization", entityId: organizationId, organizationId });
  res.status(204).end();
});

authRouter.post("/logout", requireAuth, requireCsrf, async (req, res) => {
  await logout(req.auth!.sessionId);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.status(204).end();
});

authRouter.post("/password", requireAuth, requireCsrf, loginLimiter, async (req, res) => {
  const body = parse(z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().max(200) }), req.body);
  await changeOwnPassword(req.auth!.user.id, req.auth!.sessionId, body.currentPassword, body.newPassword);
  await audit({ actor: { id: req.auth!.user.id, username: req.auth!.user.username }, ip: req.ip, action: "user.password_changed", entityType: "user", entityId: req.auth!.user.id });
  res.status(204).end();
});
