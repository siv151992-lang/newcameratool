import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

/**
 * Which cameras the signed-in user may see. Org Admins and members with "All cameras" see every
 * camera of the organization; a member limited by an Org Admin sees only the locations (sites) and
 * cameras chosen for them (member_camera_access).
 *
 * The limit travels with the request (AsyncLocalStorage), and every query that reads an
 * organization's cameras adds cameraScopeSql(): lists, counts, a camera's page, live view,
 * recordings, alerts, reports and AI Mode alike. Background work (checks, notifications, the
 * weekly report) runs outside any request and sees every camera.
 */

interface CameraScope {
  userId: string;
  organizationId: string;
}

const store = new AsyncLocalStorage<CameraScope | null>();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Runs `fn` limited to what `userId` may see in `organizationId` (null: no limit). */
export function runWithCameraScope<T>(scope: CameraScope | null, fn: () => T): T {
  if (scope && !(UUID.test(scope.userId) && UUID.test(scope.organizationId))) throw new Error("Invalid camera scope");
  return store.run(scope, fn);
}

/** Express middleware, after authenticate: limits the rest of the request for a limited member. */
export function cameraScopeMiddleware(req: Request, _res: Response, next: NextFunction) {
  const u = req.auth?.user;
  const limited = u && u.organizationId && u.cameraAccess === "limited" && u.role !== "admin";
  runWithCameraScope(limited ? { userId: u.id, organizationId: u.organizationId! } : null, next);
}

/** Whether the current request is limited to some cameras. */
export const isCameraScoped = () => Boolean(store.getStore());

/**
 * " AND <alias>.id is one the user may see", or "" when not limited. The ids are checked to be
 * UUIDs before they are written into the SQL; everything else comes from the database.
 */
export function cameraScopeSql(alias = "c"): string {
  const s = store.getStore();
  if (!s) return "";
  const own = `mca.organization_id = '${s.organizationId}' AND mca.user_id = '${s.userId}'`;
  return ` AND (${alias}.id IN (SELECT mca.camera_id FROM member_camera_access mca WHERE ${own} AND mca.camera_id IS NOT NULL)` +
    ` OR ${alias}.location IN (SELECT mca.location FROM member_camera_access mca WHERE ${own} AND mca.location IS NOT NULL))`;
}
