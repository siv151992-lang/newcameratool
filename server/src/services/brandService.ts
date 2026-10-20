import { pool } from "../db/pool.js";
import type { BrandRegistry } from "../integrations/registry.js";

/**
 * Mirrors the built-in adapters into camera_brands so cameras can reference brands by FK, then
 * loads the registry's view of all integrations. An administrator's enable/disable choice
 * (status) is never overwritten here.
 */
export async function syncBrands(registry: BrandRegistry) {
  for (const b of registry.builtins()) {
    await pool.query(
      `INSERT INTO camera_brands (key, display_name, support_status, auth_methods, default_http_port, default_https_port, capabilities, notes,
                                  integration_type, integration_version, compatibility_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'builtin',$9,$10)
       ON CONFLICT (key) DO UPDATE SET display_name = EXCLUDED.display_name, support_status = EXCLUDED.support_status,
         auth_methods = EXCLUDED.auth_methods, default_http_port = EXCLUDED.default_http_port,
         default_https_port = EXCLUDED.default_https_port, capabilities = EXCLUDED.capabilities,
         notes = EXCLUDED.notes, integration_type = 'builtin', integration_version = EXCLUDED.integration_version,
         compatibility_notes = EXCLUDED.compatibility_notes`,
      [b.key, b.displayName, b.supportStatus, b.authMethods, b.defaultPorts.http, b.defaultPorts.https, b.capabilities, b.notes, b.version, b.compatibility ?? null],
    );
  }
  await registry.refresh();
}
