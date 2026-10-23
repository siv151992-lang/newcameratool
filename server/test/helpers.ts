import { pool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { registry } from "../src/integrations/registry.js";
import { syncBrands } from "../src/services/brandService.js";
import { clearEmailSettingsCache } from "../src/services/emailSettings.js";
import { updateMonitoringSettings } from "../src/services/settingsService.js";
import { createUser } from "../src/services/userService.js";

export async function prepareDb() {
  await migrate(pool);
  await syncBrands(registry);
}

/** The organization test data belongs to unless a test creates another (reset by resetData). */
export let testOrgId = "";

/** Creates an organization directly (no members). */
export async function createTestOrg(name: string) {
  return (await pool.query<{ id: string }>("INSERT INTO organizations (name) VALUES ($1) RETURNING id", [name])).rows[0]!.id;
}

/** Empties all data tables between tests (roles are kept; built-in brands are restored). */
export async function resetData() {
  await pool.query(`TRUNCATE users, sessions, cameras, camera_credentials, camera_status, storage_devices,
    storage_checks, connection_events, alerts, alert_events, notification_channels, notification_deliveries,
    audit_logs, app_settings, organizations, organization_members, organization_settings CASCADE`);
  // TRUNCATE users CASCADE also empties camera_brands (created_by): restore the built-in brands.
  await pool.query("TRUNCATE camera_brands CASCADE");
  clearEmailSettingsCache();
  await syncBrands(registry);
  // Fast, deterministic monitoring for tests.
  testOrgId = await createTestOrg("Test organization");
  await updateMonitoringSettings(testOrgId, { requestTimeoutMs: 1500, retryBaseDelayMs: 100, maxRetries: 1 }, null);
}

export async function createTestUser(
  role: "admin" | "operator" | "viewer", username = `${role}-user`, orgId = testOrgId, opts: { systemAdmin?: boolean } = {},
) {
  const id = await createUser(orgId, { username, password: "Correct-Horse-9", role }, null);
  if (opts.systemAdmin) await pool.query("UPDATE users SET is_system_admin = true WHERE id = $1", [id]);
  return { id, username };
}

export const PASSWORD = "Correct-Horse-9";
