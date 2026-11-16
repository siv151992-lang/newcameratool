import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { inspectBackup, restoreBackup } from "../services/backupService.js";

/**
 * Restores a backup made by the app, replacing everything in the database. Stop the app first.
 *   node dist/cli/restoreBackup.js <backup file> [--yes]
 * Without --yes it only shows what the backup contains.
 */
let restored = false;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { yes: { type: "boolean", default: false } } });
  const file = positionals[0] ? resolve(positionals[0]) : "";
  if (!file || !existsSync(file)) throw new Error(`Usage: restoreBackup <backup file> [--yes]${file ? `\nNot found: ${file}` : ""}`);

  const { header, counts } = await inspectBackup(file);
  const rows = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`Backup of ${header.createdAt} (app ${header.appVersion}): ${rows} rows in ${Object.keys(counts).length} tables`);
  console.log(`  cameras: ${counts.cameras ?? 0} · users: ${counts.users ?? 0} · organizations: ${counts.organizations ?? 0} · alerts: ${counts.alerts ?? 0}`);
  if (!values.yes) {
    console.log("Nothing changed. Add --yes to replace the current database with this backup.");
    return;
  }
  // The app must be stopped: it would keep writing while the database is replaced.
  const others = (await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'",
  )).rows[0]!.n;
  if (others > 0) throw new Error(`The app is still connected to the database (${others} connections). Stop it first (STOP.bat, or docker compose stop api worker), then restore.`);

  await restoreBackup(file, pool, (m) => console.log(m));
  restored = true;
  await migrate(pool, (m) => console.log(m)); // brings an older backup up to this version
  console.log("Restore complete. Start the app again (START.bat, or docker compose start api worker). Everyone signs in again.");
}

main()
  .catch((err) => {
    console.error(`Restore failed: ${err.message}`);
    console.error(restored ? "The backup was restored, but updating it to this version failed: start the app to retry, or send this message to support." : "The database was not changed.");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
