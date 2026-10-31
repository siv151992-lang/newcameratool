import { z } from "zod";
import { pool } from "../db/pool.js";
import { toCsv } from "../lib/csv.js";

/**
 * Firmware inventory: every camera's model and firmware version (as the camera reports them at its
 * checks), grouped by brand and model, with the newest version seen per model and the cameras still
 * on an older one. "Newest" is the newest among this organization's own cameras: the app does not
 * know the manufacturers' latest releases.
 */

/** The parts of a firmware version that order it: its numbers (V5.7.3 → 5,7,3) and its build (220112). */
export function firmwareKey(version: string): { numbers: number[]; build: number } {
  const numbers = (/\d+(?:\.\d+)+/.exec(version)?.[0] ?? /\d+/.exec(version)?.[0] ?? "").split(".").filter(Boolean).map(Number);
  const build = Number((/build(?:\s*date)?\s*[:\s]\s*([\d-]+)/i.exec(version)?.[1] ?? "").replace(/-/g, "")) || 0;
  return { numbers, build };
}

/** Orders two firmware versions: negative when a is older. Unparseable versions compare as text. */
export function compareFirmware(a: string, b: string): number {
  const x = firmwareKey(a), y = firmwareKey(b);
  if (!x.numbers.length || !y.numbers.length) return a.localeCompare(b, undefined, { numeric: true });
  for (let i = 0; i < Math.max(x.numbers.length, y.numbers.length); i++) {
    const d = (x.numbers[i] ?? 0) - (y.numbers[i] ?? 0);
    if (d) return d;
  }
  return x.build - y.build;
}

const UNKNOWN_MODEL = "";

export interface FirmwareModel {
  brand: string;
  brandName: string;
  model: string | null;
  cameras: number;
  /** Cameras whose firmware has not been read (yet). */
  unknown: number;
  /** Cameras on an older version than the newest of this model. */
  outdated: number;
  newest: string | null;
  /** Each version, newest first, with how many cameras run it. */
  versions: { version: string; cameras: number }[];
}

export async function firmwareInventory(orgId: string) {
  const { rows } = await pool.query<{ brand: string; brand_name: string; model: string; version: string | null; n: number }>(
    `SELECT c.brand_key AS brand, b.display_name AS brand_name,
            COALESCE(NULLIF(s.device_model, ''), NULLIF(c.model, ''), '') AS model, NULLIF(s.firmware_version, '') AS version, count(*)::int AS n
     FROM cameras c JOIN camera_brands b ON b.key = c.brand_key LEFT JOIN camera_status s ON s.camera_id = c.id
     WHERE c.organization_id = $1 AND c.deleted_at IS NULL
     GROUP BY 1, 2, 3, 4`,
    [orgId],
  );
  const groups = new Map<string, FirmwareModel>();
  for (const r of rows) {
    const key = `${r.brand}\u0000${r.model}`;
    const g = groups.get(key) ?? { brand: r.brand, brandName: r.brand_name, model: r.model === UNKNOWN_MODEL ? null : r.model, cameras: 0, unknown: 0, outdated: 0, newest: null, versions: [] };
    g.cameras += r.n;
    if (r.version === null) g.unknown += r.n;
    else g.versions.push({ version: r.version, cameras: r.n });
    groups.set(key, g);
  }
  const models = [...groups.values()];
  for (const g of models) {
    g.versions.sort((a, b) => compareFirmware(b.version, a.version));
    g.newest = g.versions[0]?.version ?? null;
    // A camera whose model is not known is compared with nothing.
    g.outdated = g.model === null ? 0 : g.versions.filter((v) => compareFirmware(v.version, g.newest!) < 0).reduce((n, v) => n + v.cameras, 0);
  }
  models.sort((a, b) => b.outdated - a.outdated || b.cameras - a.cameras || `${a.brandName} ${a.model}`.localeCompare(`${b.brandName} ${b.model}`));
  const sum = (f: (g: FirmwareModel) => number) => models.reduce((n, g) => n + f(g), 0);
  return {
    summary: {
      cameras: sum((g) => g.cameras),
      unknown: sum((g) => g.unknown),
      outdated: sum((g) => g.outdated),
      models: models.filter((g) => g.model !== null).length,
      versions: sum((g) => g.versions.length),
    },
    models,
  };
}

export const firmwareCamerasQuery = z.object({
  brand: z.string().min(1).max(64),
  /** Empty: cameras whose model is not known. */
  model: z.string().max(200).default(""),
});

/** The cameras of one brand and model, with their version and whether it is older than the newest. */
export async function firmwareCameras(orgId: string, q: z.infer<typeof firmwareCamerasQuery>) {
  const { rows } = await pool.query<{ id: string; name: string; host: string; location: string | null; device_type: string; firmware: string | null; serial: string | null; read_at: Date | null; connection: string | null }>(
    `SELECT c.id, c.name, c.host, c.location, c.device_type, NULLIF(s.firmware_version, '') AS firmware, s.device_serial AS serial,
            s.device_info_at AS read_at, s.connection_status AS connection
     FROM cameras c LEFT JOIN camera_status s ON s.camera_id = c.id
     WHERE c.organization_id = $1 AND c.deleted_at IS NULL AND c.brand_key = $2
       AND COALESCE(NULLIF(s.device_model, ''), NULLIF(c.model, ''), '') = $3
     ORDER BY c.name LIMIT 5000`,
    [orgId, q.brand, q.model],
  );
  const known = rows.map((r) => r.firmware).filter((v): v is string => v !== null).sort((a, b) => compareFirmware(b, a));
  const newest = q.model ? known[0] ?? null : null;
  return rows
    .map((r) => ({
      id: r.id, name: r.name, host: r.host, location: r.location, deviceType: r.device_type,
      firmwareVersion: r.firmware, serialNumber: r.serial, readAt: r.read_at, connectionStatus: r.connection,
      outdated: newest !== null && r.firmware !== null && compareFirmware(r.firmware, newest) < 0,
    }))
    .sort((a, b) => Number(b.outdated) - Number(a.outdated) || (a.firmwareVersion && b.firmwareVersion ? compareFirmware(a.firmwareVersion, b.firmwareVersion) : 0) || a.name.localeCompare(b.name));
}

/** The whole inventory, one camera a row, for a spreadsheet. */
export async function firmwareCsv(orgId: string) {
  const inv = await firmwareInventory(orgId);
  const newest = new Map(inv.models.map((g) => [`${g.brand}\u0000${g.model ?? ""}`, g.model ? g.newest : null]));
  const { rows } = await pool.query<{ name: string; host: string; location: string | null; brand: string; brand_name: string; model: string; firmware: string | null; serial: string | null; read_at: Date | null }>(
    `SELECT c.name, c.host, c.location, c.brand_key AS brand, b.display_name AS brand_name,
            COALESCE(NULLIF(s.device_model, ''), NULLIF(c.model, ''), '') AS model, NULLIF(s.firmware_version, '') AS firmware,
            s.device_serial AS serial, s.device_info_at AS read_at
     FROM cameras c JOIN camera_brands b ON b.key = c.brand_key LEFT JOIN camera_status s ON s.camera_id = c.id
     WHERE c.organization_id = $1 AND c.deleted_at IS NULL ORDER BY b.display_name, 6, c.name`,
    [orgId],
  );
  const lines: unknown[][] = [["Camera", "Address", "Location", "Brand", "Model", "Serial number", "Firmware", "Newest firmware of this model here", "Older than the newest", "Read at"]];
  for (const r of rows) {
    const top = newest.get(`${r.brand}\u0000${r.model}`) ?? null;
    const older = top !== null && r.firmware !== null && compareFirmware(r.firmware, top) < 0;
    lines.push([r.name, r.host, r.location ?? "", r.brand_name, r.model, r.serial ?? "", r.firmware ?? "Not read yet", top ?? "", older ? "Yes" : r.firmware ? "No" : "", r.read_at?.toISOString() ?? ""]);
  }
  return { csv: toCsv(lines), rows: rows.length };
}
