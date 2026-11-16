import { z } from "zod";
import { pool } from "../db/pool.js";
import { HttpError, notFound } from "../lib/errors.js";

/**
 * Where people are signed in: each session's device (from its browser's description), IP address,
 * when it started and when it was last used. People sign out their own other sessions; an Org Admin
 * signs a member out everywhere (never the super admin, unless it is themself). Sessions also end
 * after a while without use (security settings).
 */

export interface SessionView {
  id: string;
  device: string;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
  organizationName: string | null;
}

/** "Chrome on Windows" from a User-Agent header; "Unknown device" when it says nothing usable. */
export function describeDevice(userAgent: string | null): string {
  const ua = userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl|python|node|axios|PowerShell/i.test(ua) ? "Script" : null;
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad|iOS/.test(ua) ? "iPhone / iPad"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : null;
  if (!browser && !os) return "Unknown device";
  return [browser ?? "Browser", os].filter(Boolean).join(" on ");
}

/** Removes sessions past their end or unused for longer than the idle limit (they cannot be used any more). */
export async function purgeEndedSessions(userId?: string): Promise<number> {
  const { idleTimeoutMinutes } = await getSecuritySettings();
  const { rowCount } = await pool.query(
    `DELETE FROM sessions WHERE ($1::uuid IS NULL OR user_id = $1)
       AND (expires_at <= now() OR ($2 > 0 AND last_seen_at < now() - make_interval(mins => $2 + 5)))`,
    [userId ?? null, idleTimeoutMinutes],
  );
  return rowCount ?? 0;
}

export async function listSessions(userId: string, currentSessionId: string | null): Promise<SessionView[]> {
  await purgeEndedSessions(userId);
  const { rows } = await pool.query(
    `SELECT s.id, s.user_agent, s.ip, s.created_at, s.last_seen_at, o.name AS org_name
     FROM sessions s LEFT JOIN organizations o ON o.id = s.organization_id
     WHERE s.user_id = $1 AND s.expires_at > now()
     ORDER BY (s.id = $2) DESC, s.last_seen_at DESC`,
    [userId, currentSessionId ?? ""],
  );
  return rows.map((r) => ({
    // The id is a hash of the session's token: it names the session but cannot be used to sign in.
    id: r.id,
    device: describeDevice(r.user_agent),
    ip: r.ip,
    createdAt: new Date(r.created_at).toISOString(),
    lastSeenAt: new Date(r.last_seen_at).toISOString(),
    current: r.id === currentSessionId,
    organizationName: r.org_name ?? null,
  }));
}

/** Ends one of the user's own sessions (not the one in use: that is Sign out). */
export async function endOwnSession(userId: string, sessionId: string, currentSessionId: string) {
  if (!/^[0-9a-f]{64}$/.test(sessionId)) throw notFound("Session");
  if (sessionId === currentSessionId) throw new HttpError(400, "CURRENT_SESSION", "This is the session you are using: use Sign out.");
  const { rowCount } = await pool.query("DELETE FROM sessions WHERE id = $1 AND user_id = $2", [sessionId, userId]);
  if (!rowCount) throw notFound("Session");
}

/** Ends every session of the user except `keep` (the one in use), or all of them. Returns how many. */
export async function endSessions(userId: string, keep: string | null = null): Promise<number> {
  const { rowCount } = await pool.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [userId, keep ?? ""]);
  return rowCount ?? 0;
}

// ---------------------------------------------------------------- security settings (server-wide)

export const securitySettingsSchema = z
  .object({
    /** Sign out after this many minutes without use; 0 = never. */
    idleTimeoutMinutes: z.number().int().min(0).max(24 * 60),
  })
  .partial()
  .strict();

export interface SecuritySettings {
  idleTimeoutMinutes: number;
}
const DEFAULTS: SecuritySettings = { idleTimeoutMinutes: 60 };

let cache: { at: number; value: SecuritySettings } | undefined;
export async function getSecuritySettings(): Promise<SecuritySettings> {
  if (cache && Date.now() - cache.at < 15_000) return cache.value;
  const { rows } = await pool.query<{ value: Partial<SecuritySettings> }>("SELECT value FROM app_settings WHERE key = 'security'");
  const value = { ...DEFAULTS, ...securitySettingsSchema.catch({}).parse(rows[0]?.value ?? {}) };
  cache = { at: Date.now(), value };
  return value;
}

export async function updateSecuritySettings(patch: z.infer<typeof securitySettingsSchema>, userId: string): Promise<SecuritySettings> {
  const next = { ...(await getSecuritySettings()), ...patch };
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ('security', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(next), userId],
  );
  cache = undefined;
  return next;
}
