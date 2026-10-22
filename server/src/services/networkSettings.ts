import { isIP } from "node:net";
import { z } from "zod";
import { config } from "../config.js";
import { pool, type Queryable } from "../db/pool.js";
import { HostGuard } from "../security/hostGuard.js";

/**
 * The networks cameras may be contacted on (the SSRF allowlist), editable in Settings → Camera
 * networks. Until an administrator saves a list, CAMERA_ALLOWED_NETWORKS from the environment is
 * used. Loopback, link-local/metadata, multicast and reserved ranges stay blocked whatever is set
 * here (see HostGuard).
 */

/** The narrowest prefix accepted: anything broader would let the monitor reach most of the internet. */
const MIN_PREFIX = { 4: 8, 6: 16 } as const;

/** Returns an error message for an invalid range, or null when it is a valid CIDR or single address. */
export function cidrError(value: string): string | null {
  const [addr = "", prefix, extra] = value.split("/");
  const family = isIP(addr);
  if (!family || extra !== undefined) return `"${value}" is not an IP address or range such as 10.10.15.0/24`;
  if (prefix === undefined) return null;
  const max = family === 4 ? 32 : 128;
  const min = family === 4 ? MIN_PREFIX[4] : MIN_PREFIX[6];
  if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max) return `"${value}" has an invalid prefix length (0–${max})`;
  if (Number(prefix) < min) return `"${value}" is too broad; use /${min} or narrower`;
  return null;
}

const cidrSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .superRefine((v, ctx) => {
    const message = cidrError(v);
    if (message) ctx.addIssue({ code: "custom", message });
  });

export const networkSettingsSchema = z
  .object({
    allowedNetworks: z
      .array(cidrSchema)
      .min(1, "Add at least one network, otherwise no camera can be checked")
      .max(100)
      .transform((list) => [...new Set(list)]),
  })
  .strict();

export interface NetworkSettings {
  allowedNetworks: string[];
  /** True while no list has been saved and the environment default is in use. */
  isDefault: boolean;
}

export function defaultNetworks(): string[] {
  return config.CAMERA_ALLOWED_NETWORKS.split(",").map((s) => s.trim()).filter(Boolean);
}

export async function getNetworkSettings(db: Queryable = pool): Promise<NetworkSettings> {
  const { rows } = await db.query<{ value: unknown }>("SELECT value FROM app_settings WHERE key = 'networks'");
  const parsed = rows[0] ? networkSettingsSchema.safeParse(rows[0].value) : null;
  // An unreadable stored value falls back to the environment rather than blocking every camera.
  return parsed?.success ? { allowedNetworks: parsed.data.allowedNetworks, isDefault: false } : { allowedNetworks: defaultNetworks(), isDefault: true };
}

export async function updateNetworkSettings(input: unknown, userId: string | null, db: Queryable = pool): Promise<NetworkSettings> {
  const next = networkSettingsSchema.parse(input);
  await db.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ('networks', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [JSON.stringify(next), userId],
  );
  return { allowedNetworks: next.allowedNetworks, isDefault: false };
}

/**
 * Registered cameras (by IP address) that the given list would no longer allow, in `orgId` (null: every
 * organization). Hostnames are not resolved here.
 */
export async function camerasOutside(
  allowedNetworks: string[], orgId: string | null = null, db: Queryable = pool,
): Promise<{ id: string; name: string; host: string }[]> {
  const guard = new HostGuard({ allowedNetworks: allowedNetworks.join(","), allowLoopback: config.CAMERA_ALLOW_LOOPBACK });
  const { rows } = await db.query<{ id: string; name: string; host: string }>(
    "SELECT id, name, host FROM cameras WHERE deleted_at IS NULL AND ($1::uuid IS NULL OR organization_id = $1) ORDER BY lower(name)",
    [orgId],
  );
  return rows.filter((c) => {
    if (!isIP(c.host)) return false;
    try {
      guard.checkAddress(c.host);
      return false;
    } catch {
      return true;
    }
  });
}
