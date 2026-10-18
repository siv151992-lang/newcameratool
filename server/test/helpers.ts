import { pool } from "../src/db/pool.js";
import { migrate } from "../src/db/migrate.js";
import { registry } from "../src/integrations/registry.js";
import { syncBrands } from "../src/services/brandService.js";
import { updateMonitoringSettings } from "../src/services/settingsService.js";
import { createUser } from "../src/services/userService.js";

export async function prepareDb() {
  await migrate(pool);
  await syncBrands(registry);
}

/** Empties all data tables between tests (roles and brands are kept). */
export async function resetData() {
  await pool.query(`TRUNCATE users, sessions, cameras, camera_credentials, camera_status, storage_devices,
    storage_checks, connection_events, alerts, alert_events, notification_channels, notification_deliveries,
    audit_logs, app_settings CASCADE`);
  // Fast, deterministic monitoring for tests.
  await updateMonitoringSettings({ requestTimeoutMs: 1500, retryBaseDelayMs: 100, maxRetries: 1 }, null);
}

export async function createTestUser(role: "admin" | "operator" | "viewer", username = `${role}-user`) {
  const id = await createUser({ username, password: "Correct-Horse-9", role }, null);
  return { id, username };
}

export const PASSWORD = "Correct-Horse-9";
