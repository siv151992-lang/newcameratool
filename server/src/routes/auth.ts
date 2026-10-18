import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { requireAuth, requireCsrf } from "../auth/middleware.js";
import { changeOwnPassword, login, logout, SESSION_COOKIE } from "../auth/sessions.js";
import { parse } from "../lib/validate.js";
import { audit } from "../services/auditService.js";
import { loginLimiter } from "./limits.js";

export const authRouter = Router();

const cookieOptions = () => ({
  httpOnly: true,
  secure: config.COOKIE_SECURE,
  sameSite: "strict" as const,
  path: "/",
  maxAge: config.SESSION_TTL_HOURS * 3600_000,
});

authRouter.post("/login", loginLimiter, async (req, res) => {
  const body = parse(z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) }), req.body);
  try {
    const result = await login(body.username, body.password, { ip: req.ip, userAgent: req.get("user-agent") });
    res.cookie(SESSION_COOKIE, result.token, cookieOptions());
    await audit({ actor: { id: result.user.id, username: result.user.username }, ip: req.ip, action: "auth.login", entityType: "user", entityId: result.user.id });
    res.json({ user: result.user, csrfToken: result.csrfToken });
  } catch (err) {
    await audit({ actor: null, ip: req.ip, action: "auth.login_failed", entityType: "user", details: { username: body.username } });
    throw err;
  }
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.auth!.user, csrfToken: req.auth!.csrfToken });
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
