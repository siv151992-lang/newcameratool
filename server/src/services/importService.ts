import { z } from "zod";
import { pool } from "../db/pool.js";
import { registry } from "../integrations/registry.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { HttpError } from "../lib/errors.js";
import { type Actor, audit } from "./auditService.js";
import { type CameraInput, cameraInputSchema, createCamera, defaultPort } from "./cameraService.js";
import { testCameraConfig } from "./connectionService.js";

/**
 * Bulk import. The browser parses the CSV file locally and sends rows as JSON, so no uploaded
 * file is ever written to the server; rows (and any passwords in them) exist only in memory for
 * the duration of the request.
 */

export const IMPORT_COLUMNS = ["name", "ip", "brand", "model", "username", "password", "location", "port", "protocol"] as const;
export const MAX_IMPORT_ROWS = 500;

const cell = z.union([z.string(), z.number()]).optional().nullable().transform((v) => (v == null ? "" : String(v).trim()));

export const importRowSchema = z.object({
  row: z.number().int().min(1),
  name: cell, ip: cell, brand: cell, model: cell, username: cell, password: cell, location: cell, port: cell, protocol: cell,
});
export type ImportRow = z.infer<typeof importRowSchema>;

export const importOptionsSchema = z
  .object({
    sharedCredentials: z
      .object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(128) })
      .optional(),
    // "missing": use shared credentials only where the row has none; "all": override every row.
    sharedCredentialsMode: z.enum(["missing", "all"]).default("missing"),
    monitoringEnabled: z.boolean().default(true),
    testConnectivity: z.boolean().default(false),
    testConcurrency: z.number().int().min(1).max(10).default(3),
    skipFailedTests: z.boolean().default(false),
  })
  .strict();
export type ImportOptions = z.infer<typeof importOptionsSchema>;

export const importRequestSchema = z.object({
  rows: z.array(importRowSchema).min(1, "No rows to import").max(MAX_IMPORT_ROWS, `At most ${MAX_IMPORT_ROWS} rows per request`),
  options: importOptionsSchema.default({}),
});

export interface RowValidation {
  row: number;
  status: "valid" | "invalid" | "duplicate";
  errors: { field: string; message: string }[];
  camera?: Omit<CameraInput, "password" | "caCertificate"> & { port: number; usesSharedCredentials: boolean };
  input?: CameraInput;
}

const FIELD_MAP: Record<string, string> = { host: "ip" };

function toInput(r: ImportRow, o: ImportOptions): { input: unknown; shared: boolean } {
  const useShared = !!o.sharedCredentials && (o.sharedCredentialsMode === "all" || (!r.username && !r.password));
  return {
    shared: useShared,
    input: {
      name: r.name,
      host: r.ip,
      brand: r.brand,
      model: r.model || null,
      location: r.location || null,
      username: useShared ? o.sharedCredentials!.username : r.username,
      password: useShared ? o.sharedCredentials!.password : r.password,
      port: r.port === "" ? null : r.port,
      protocol: r.protocol === "" ? "http" : r.protocol.toLowerCase(),
      monitoringEnabled: o.monitoringEnabled,
    },
  };
}

export async function validateImport(orgId: string, rows: ImportRow[], options: ImportOptions): Promise<RowValidation[]> {
  const results: RowValidation[] = rows.map((r) => {
    const { input, shared } = toInput(r, options);
    const parsed = cameraInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        row: r.row,
        status: "invalid",
        // Error messages describe the field, never echo the submitted value.
        errors: parsed.error.issues.map((i) => {
          const field = String(i.path[0] ?? "row");
          return { field: FIELD_MAP[field] ?? field, message: i.message };
        }),
      };
    }
    const v = parsed.data;
    const port = v.port ?? defaultPort(v.brand, v.protocol);
    const { password: _p, caCertificate: _c, ...rest } = v;
    return { row: r.row, status: "valid", errors: [], camera: { ...rest, port, usesSharedCredentials: shared }, input: { ...v, port } };
  });

  // Duplicates within the file and against registered cameras (brand + host + port).
  const seen = new Map<string, number>();
  const keys = results.filter((r) => r.camera).map((r) => `${r.camera!.brand}|${r.camera!.host}|${r.camera!.port}`);
  const existing = new Set<string>();
  if (keys.length) {
    const { rows: found } = await pool.query<{ k: string }>(
      `SELECT brand_key || '|' || host || '|' || port AS k FROM cameras
       WHERE organization_id = $2 AND deleted_at IS NULL AND (brand_key || '|' || host || '|' || port) = ANY($1::text[])`,
      [keys, orgId],
    );
    for (const f of found) existing.add(f.k);
  }
  for (const r of results) {
    if (!r.camera) continue;
    const key = `${r.camera.brand}|${r.camera.host}|${r.camera.port}`;
    if (existing.has(key)) {
      r.status = "duplicate";
      r.errors.push({ field: "ip", message: "A camera with this brand, address and port is already registered" });
    } else if (seen.has(key)) {
      r.status = "duplicate";
      r.errors.push({ field: "ip", message: `Same camera as row ${seen.get(key)}` });
    } else {
      seen.set(key, r.row);
    }
  }
  return results;
}

/** Strips internal fields (which include passwords) before results go back to the browser. */
export function publicValidation(results: RowValidation[]) {
  return results.map(({ input: _input, ...rest }) => rest);
}

export interface ImportRowResult {
  row: number;
  status: "imported" | "skipped" | "failed";
  message: string;
  cameraId?: string;
  test?: { ok: boolean; code?: string; message: string };
}

export async function commitImport(orgId: string, rows: ImportRow[], options: ImportOptions, actor: Actor, ip?: string | null) {
  const validation = await validateImport(orgId, rows, options);
  const results: ImportRowResult[] = await mapWithConcurrency(
    validation,
    options.testConnectivity ? options.testConcurrency : 1,
    async (v): Promise<ImportRowResult> => {
      if (v.status !== "valid" || !v.input) {
        return { row: v.row, status: "skipped", message: v.errors.map((e) => `${e.field}: ${e.message}`).join("; ") };
      }
      let test: ImportRowResult["test"];
      if (options.testConnectivity) {
        const r = await testCameraConfig(registry.get(v.input.brand), v.input);
        test = r.ok
          ? { ok: true, message: r.steps.find((s) => s.key === "storage")?.message ?? "Connected" }
          : { ok: false, code: r.error?.code, message: r.error?.message ?? "Connection test failed" };
        if (!r.ok && options.skipFailedTests) {
          return { row: v.row, status: "skipped", message: "Connection test failed; row skipped as requested", test };
        }
      }
      try {
        const cameraId = await createCamera(orgId, v.input, actor, ip);
        return { row: v.row, status: "imported", message: "Camera registered", cameraId, test };
      } catch (err) {
        const message = err instanceof HttpError ? err.message : "Could not save camera";
        return { row: v.row, status: "failed", message, test };
      }
    },
  );
  const summary = {
    total: results.length,
    imported: results.filter((r) => r.status === "imported").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
  await audit({ actor, ip, action: "camera.import", entityType: "camera", details: { ...summary, testConnectivity: options.testConnectivity } });
  return { summary, results };
}

export function csvTemplate(): string {
  return [
    IMPORT_COLUMNS.join(","),
    "Office Camera 01,192.168.1.101,Hikvision,DS-2CD2143G2-I,admin,change-me,Reception,80,http",
    "Office Camera 02,192.168.1.102,Hikvision,DS-2CD2143G2-I,admin,change-me,Entrance,443,https",
    "",
  ].join("\r\n");
}
