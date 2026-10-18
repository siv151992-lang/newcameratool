import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { createUser } from "./userService.js";

/** Creates the first administrator from BOOTSTRAP_ADMIN_* variables if no users exist yet. */
export async function bootstrapAdmin() {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM users");
  if (rows[0].n > 0) return;
  if (!config.BOOTSTRAP_ADMIN_USERNAME || !config.BOOTSTRAP_ADMIN_PASSWORD) {
    logger.warn("No users exist. Create an administrator with: npm run create-admin -- --username <name>");
    return;
  }
  await createUser({ username: config.BOOTSTRAP_ADMIN_USERNAME, password: config.BOOTSTRAP_ADMIN_PASSWORD, role: "admin" }, null);
  logger.info({ username: config.BOOTSTRAP_ADMIN_USERNAME }, "Created initial administrator. Remove BOOTSTRAP_ADMIN_PASSWORD from the environment now.");
}
