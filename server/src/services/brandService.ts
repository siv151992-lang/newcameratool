import { pool } from "../db/pool.js";
import type { BrandRegistry } from "../integrations/registry.js";

/** Mirrors the in-code registry into camera_brands so cameras can reference brands by FK. */
export async function syncBrands(registry: BrandRegistry) {
  for (const b of registry.list()) {
    await pool.query(
      `INSERT INTO camera_brands (key, display_name, support_status, auth_methods, default_http_port, default_https_port, capabilities, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (key) DO UPDATE SET display_name = EXCLUDED.display_name, support_status = EXCLUDED.support_status,
         auth_methods = EXCLUDED.auth_methods, default_http_port = EXCLUDED.default_http_port,
         default_https_port = EXCLUDED.default_https_port, capabilities = EXCLUDED.capabilities,
         notes = EXCLUDED.notes, updated_at = now()`,
      [b.key, b.displayName, b.supportStatus, b.authMethods, b.defaultPorts.http, b.defaultPorts.https, b.capabilities, b.notes],
    );
  }
}
