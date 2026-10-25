import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/errors.js";
import type { Actor } from "../services/auditService.js";
import { type AuthContext, getSession, passwordConfirmedUntil, SESSION_COOKIE, SYSTEM_PERMISSION } from "./sessions.js";

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === "string" && token.length > 0 && token.length < 200) {
    req.auth = (await getSession(token)) ?? undefined;
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(new HttpError(401, "UNAUTHENTICATED", "Please sign in"));
  next();
}

/** Double-submit style CSRF check: the per-session token must be sent in a header. */
export function requireCsrf(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const sent = req.get("x-csrf-token") ?? "";
  const expected = req.auth?.csrfToken ?? "";
  const ok = sent.length === expected.length && expected.length > 0 && timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
  if (!ok) return next(new HttpError(403, "CSRF_FAILED", "Missing or invalid CSRF token. Reload the page and try again."));
  next();
}

const noOrganization = () =>
  new HttpError(403, "NO_ORGANIZATION", "You are not in any organization yet. Ask an organization administrator to invite you.");

export function requirePermission(permission: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) return next(new HttpError(401, "UNAUTHENTICATED", "Please sign in"));
    if (!req.auth.user.permissions.includes(permission)) {
      if (!req.auth.user.organizationId && permission !== SYSTEM_PERMISSION) return next(noOrganization());
      return next(new HttpError(403, "FORBIDDEN", "You do not have permission to perform this action"));
    }
    next();
  };
}

/**
 * Settings are locked: the user must have entered their password again in this session recently.
 * Each use keeps it open (like sudo), so it locks after a while without settings work.
 */
export async function requirePasswordConfirmation(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) return next(new HttpError(401, "UNAUTHENTICATED", "Please sign in"));
  try {
    if (await passwordConfirmedUntil(req.auth.sessionId, true)) return next();
    next(new HttpError(403, "PASSWORD_CONFIRMATION_REQUIRED", "Settings are locked. Enter your password to open them."));
  } catch (err) {
    next(err);
  }
}

/** Changes need the password confirmation; reading does not (other pages read some settings). */
export function requirePasswordForChanges(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  void requirePasswordConfirmation(req, res, next);
}

/** The current user, recorded in audit entries under the organization the session works in. */
export function actorOf(req: Request): Actor {
  return { id: req.auth!.user.id, username: req.auth!.user.username, organizationId: req.auth!.user.organizationId };
}

/**
 * The organization the request works in. Every organization-owned record (cameras, alerts, channels,
 * settings, audit) is read and changed only within it.
 */
export function orgOf(req: Request): string {
  const org = req.auth?.user.organizationId;
  if (!org) throw noOrganization();
  return org;
}
