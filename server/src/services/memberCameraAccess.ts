import { z } from "zod";
import { assertNotSuperAdmin } from "./organizationService.js";
import { pool, withTransaction } from "../db/pool.js";
import { badRequest, notFound } from "../lib/errors.js";
import { clearInsightsCache } from "../ai/insightsService.js";
import { type Actor, audit } from "./auditService.js";

/**
 * Dashboard, Alerts, reports and AI Mode show every camera to every member. Per member, live view,
 * recordings and camera actions can be turned off, and the Cameras list, camera pages and those
 * features can be limited to chosen cameras (see auth/cameraScope): every camera ("all"), or only those in
 * the chosen locations (sites) plus the chosen cameras ("limited"). Locations follow the cameras:
 * a camera added later to a chosen location is seen too. Org Admins always see every camera, so
 * a limit set for one only applies if their role is changed to Operator or Viewer.
 */

export const cameraAccessSchema = z
  .object({
    mode: z.enum(["all", "limited"]),
    locations: z.array(z.string().trim().min(1).max(120)).max(500).default([]),
    cameraIds: z.array(z.string().uuid()).max(20_000).default([]),
    /** Live view, recordings and camera actions: each can be turned off (never more than the role allows). */
    features: z.object({ live: z.boolean(), recordings: z.boolean(), actions: z.boolean() }).strict().optional(),
  })
  .strict();
export type CameraAccessInput = z.infer<typeof cameraAccessSchema>;

export interface CameraAccess {
  mode: "all" | "limited";
  locations: string[];
  cameraIds: string[];
  /** The member's role: Org Admins see every camera whatever is set here. */
  role: string;
  /** Switched on for this member (Org Admins: always). */
  features: { live: boolean; recordings: boolean; actions: boolean };
  /** What the role allows at all (a Viewer has no live view, recordings or camera actions). */
  available: { live: boolean; recordings: boolean; actions: boolean };
}

const isUuid = (v: string) => z.string().uuid().safeParse(v).success;

export async function getCameraAccess(orgId: string, userId: string): Promise<CameraAccess> {
  if (!isUuid(userId)) throw notFound("Member");
  const { rows } = await pool.query<{ camera_access: "all" | "limited"; role: string; can_live: boolean; can_recordings: boolean; can_actions: boolean; permissions: string[] }>(
    `SELECT m.camera_access, m.role, m.can_live, m.can_recordings, m.can_actions, r.permissions
     FROM organization_members m JOIN roles r ON r.name = m.role WHERE m.organization_id = $1 AND m.user_id = $2`,
    [orgId, userId],
  );
  if (!rows[0]) throw notFound("Member");
  const chosen = await pool.query<{ camera_id: string | null; location: string | null }>(
    `SELECT a.camera_id, a.location FROM member_camera_access a
     LEFT JOIN cameras c ON c.id = a.camera_id
     WHERE a.organization_id = $1 AND a.user_id = $2 AND (a.camera_id IS NULL OR c.deleted_at IS NULL)`,
    [orgId, userId],
  );
  const m = rows[0];
  const admin = m.role === "admin";
  const live = m.permissions.includes("cameras:live");
  return {
    mode: m.camera_access,
    role: m.role,
    features: { live: admin || m.can_live, recordings: admin || m.can_recordings, actions: admin || m.can_actions },
    available: { live, recordings: live, actions: m.permissions.includes("cameras:check") },
    locations: chosen.rows.filter((r) => r.location !== null).map((r) => r.location!).sort((a, b) => a.localeCompare(b)),
    cameraIds: chosen.rows.filter((r) => r.camera_id !== null).map((r) => r.camera_id!),
  };
}

export async function setCameraAccess(orgId: string, userId: string, input: CameraAccessInput, actor: Actor, ip?: string | null): Promise<CameraAccess> {
  if (!isUuid(userId)) throw notFound("Member");
  const locations = [...new Set(input.locations)];
  const cameraIds = [...new Set(input.cameraIds)];
  if (input.mode === "limited" && !locations.length && !cameraIds.length) {
    throw badRequest("Choose at least one location or camera, or give access to all cameras.");
  }
  await withTransaction(async (db) => {
    const member = await db.query<{ superAdmin: boolean }>(
      `SELECT u.is_system_admin AS "superAdmin" FROM organization_members m JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = $1 AND m.user_id = $2 FOR UPDATE OF m`,
      [orgId, userId],
    );
    if (!member.rows[0]) throw notFound("Member");
    assertNotSuperAdmin(member.rows[0], userId, actor.id);
    if (cameraIds.length) {
      const own = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM cameras WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND deleted_at IS NULL",
        [cameraIds, orgId],
      );
      if (own.rows[0]!.n !== cameraIds.length) throw badRequest("Some of the chosen cameras are not in this organization.");
    }
    if (locations.length) {
      const known = await db.query<{ location: string }>(
        "SELECT DISTINCT location FROM cameras WHERE organization_id = $1 AND deleted_at IS NULL AND location = ANY($2::text[])",
        [orgId, locations],
      );
      const missing = locations.filter((l) => !known.rows.some((r) => r.location === l));
      if (missing.length) throw badRequest(`No camera has the location ${missing.map((m) => `"${m}"`).join(", ")}.`);
    }
    await db.query("UPDATE organization_members SET camera_access = $3 WHERE organization_id = $1 AND user_id = $2", [orgId, userId, input.mode]);
    if (input.features) {
      await db.query(
        "UPDATE organization_members SET can_live = $3, can_recordings = $4, can_actions = $5 WHERE organization_id = $1 AND user_id = $2",
        [orgId, userId, input.features.live, input.features.recordings, input.features.actions],
      );
    }
    await db.query("DELETE FROM member_camera_access WHERE organization_id = $1 AND user_id = $2", [orgId, userId]);
    if (input.mode === "limited") {
      await db.query(
        `INSERT INTO member_camera_access (organization_id, user_id, location)
         SELECT $1, $2, l FROM unnest($3::text[]) AS l`,
        [orgId, userId, locations],
      );
      await db.query(
        `INSERT INTO member_camera_access (organization_id, user_id, camera_id)
         SELECT $1, $2, c FROM unnest($3::uuid[]) AS c`,
        [orgId, userId, cameraIds],
      );
    }
    await audit(
      {
        actor, ip, action: "user.camera_access_changed", entityType: "user", entityId: userId,
        details: { ...(input.mode === "all" ? { mode: "all" } : { mode: "limited", locations, cameras: cameraIds.length }), ...(input.features ? { features: input.features } : {}) },
      },
      db,
    );
  });
  // A member's AI Mode analysis covers only their cameras: start it again with the new set.
  clearInsightsCache();
  return getCameraAccess(orgId, userId);
}
