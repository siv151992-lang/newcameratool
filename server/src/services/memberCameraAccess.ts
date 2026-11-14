import { z } from "zod";
import { pool, withTransaction } from "../db/pool.js";
import { badRequest, notFound } from "../lib/errors.js";
import { clearInsightsCache } from "../ai/insightsService.js";
import { type Actor, audit } from "./auditService.js";

/**
 * Which cameras a member may see (see auth/cameraScope): every camera ("all"), or only those in
 * the chosen locations (sites) plus the chosen cameras ("limited"). Locations follow the cameras:
 * a camera added later to a chosen location is seen too. Org Admins always see every camera, so
 * a limit set for one only applies if their role is changed to Operator or Viewer.
 */

export const cameraAccessSchema = z
  .object({
    mode: z.enum(["all", "limited"]),
    locations: z.array(z.string().trim().min(1).max(120)).max(500).default([]),
    cameraIds: z.array(z.string().uuid()).max(20_000).default([]),
  })
  .strict();
export type CameraAccessInput = z.infer<typeof cameraAccessSchema>;

export interface CameraAccess {
  mode: "all" | "limited";
  locations: string[];
  cameraIds: string[];
  /** The member's role: Org Admins see every camera whatever is set here. */
  role: string;
}

const isUuid = (v: string) => z.string().uuid().safeParse(v).success;

export async function getCameraAccess(orgId: string, userId: string): Promise<CameraAccess> {
  if (!isUuid(userId)) throw notFound("Member");
  const { rows } = await pool.query<{ camera_access: "all" | "limited"; role: string }>(
    "SELECT camera_access, role FROM organization_members WHERE organization_id = $1 AND user_id = $2",
    [orgId, userId],
  );
  if (!rows[0]) throw notFound("Member");
  const chosen = await pool.query<{ camera_id: string | null; location: string | null }>(
    `SELECT a.camera_id, a.location FROM member_camera_access a
     LEFT JOIN cameras c ON c.id = a.camera_id
     WHERE a.organization_id = $1 AND a.user_id = $2 AND (a.camera_id IS NULL OR c.deleted_at IS NULL)`,
    [orgId, userId],
  );
  return {
    mode: rows[0].camera_access,
    role: rows[0].role,
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
    const member = await db.query("SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2 FOR UPDATE", [orgId, userId]);
    if (!member.rowCount) throw notFound("Member");
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
        details: input.mode === "all" ? { mode: "all" } : { mode: "limited", locations, cameras: cameraIds.length },
      },
      db,
    );
  });
  // A member's AI Mode analysis covers only their cameras: start it again with the new set.
  clearInsightsCache();
  return getCameraAccess(orgId, userId);
}
