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
import { availableProviders, completeSignIn, listIdentities, PROVIDER_NAMES, startSignIn, unlinkIdentity } from "../auth/oauth.js";
import { PROVIDERS, type Provider } from "../services/providerSettings.js";
import { HttpError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { parse } from "../lib/validate.js";
import { pool } from "../db/pool.js";
import { audit } from "../services/auditService.js";
import { learnDashboardAddress } from "../services/dashboardAddress.js";
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
  res.json({ ...(await signInOptions()), providers: await availableProviders() });
});

// ------------------------------------------------------------------ Sign in with Google / Zoho

const OAUTH_COOKIE = "cctv_oauth_state";
const providerParam = (req: Request): Provider => {
  const p = String(req.params.provider);
  if (!(PROVIDERS as readonly string[]).includes(p)) throw new HttpError(404, "NOT_FOUND", "Unknown sign-in provider");
  return p as Provider;
};

/**
 * A page that moves the browser on. The provider's redirect is a cross-site navigation, so a
 * same-site (SameSite=Strict) session cookie set in it would not be sent on an HTTP redirect; a
 * navigation from our own page is same-site.
 */
function continueTo(res: Response, path: string) {
  const href = path.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  res
    .status(200)
    .type("html")
    .send(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${href}"><title>Signing in…</title><p style="font-family:system-ui">Signing in… <a href="${href}">Continue</a></p>`);
}

/** Sends the browser to Google or Zoho. With ?link=1 (signed in) it connects the provider to this account. */
authRouter.get("/oauth/:provider/start", accountLimiter, async (req, res) => {
  const provider = providerParam(req);
  const q = parse(z.object({ invitation: z.string().max(100).optional(), link: z.literal("1").optional() }), req.query);
  if (q.link && !req.auth) throw new HttpError(401, "UNAUTHENTICATED", "Please sign in");
  const { url, state } = await startSignIn(provider, { linkUserId: q.link ? req.auth!.user.id : undefined, invitationToken: q.invitation });
  // Lax: the cookie must come back on the provider's (cross-site) redirect to the callback.
  res.cookie(OAUTH_COOKIE, state, { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: "lax", path: "/api/auth/oauth", maxAge: 10 * 60_000 });
  res.redirect(302, url);
});

authRouter.get("/oauth/:provider/callback", accountLimiter, async (req, res) => {
  const provider = providerParam(req);
  const browserState = req.cookies?.[OAUTH_COOKIE] as string | undefined;
  res.clearCookie(OAUTH_COOKIE, { path: "/api/auth/oauth" });
  try {
    const result = await completeSignIn(provider, req.query, browserState, req.ip);
    if (result.kind === "linked") return continueTo(res, `/settings/account?connected=${provider}`);
    await signInAs(req, res, result.userId, result.organizationId);
    continueTo(res, "/");
  } catch (err) {
    const message = err instanceof HttpError ? err.message : `Sign in with ${PROVIDER_NAMES[provider]} failed. Try again.`;
    if (!(err instanceof HttpError)) logger.warn({ err: (err as Error).message, provider }, "Sign-in callback failed");
    continueTo(res, `/?signin_error=${encodeURIComponent(message)}`);
  }
});

/** The Google / Zoho accounts connected to the signed-in user. */
authRouter.get("/identities", requireAuth, async (req, res) => {
  const { rows } = await pool.query<{ has_password: boolean }>("SELECT password_hash IS NOT NULL AS has_password FROM users WHERE id = $1", [req.auth!.user.id]);
  res.json({ identities: await listIdentities(req.auth!.user.id), hasPassword: rows[0]?.has_password ?? false, available: await availableProviders() });
});

authRouter.delete("/identities/:provider", requireAuth, requireCsrf, async (req, res) => {
  await unlinkIdentity(req.auth!.user.id, req.auth!.user.username, providerParam(req), req.ip);
  res.status(204).end();
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
    // Links in emails need the address people open the dashboard at: learn it if it is not set.
    await learnDashboardAddress(req.get("origin"), result.user.isSystemAdmin).catch(() => undefined);
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
