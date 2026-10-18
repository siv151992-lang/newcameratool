import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
// Works from src/db (tsx) and dist/db (compiled): migrations live in server/migrations.
const MIGRATIONS_DIR = join(here, "..", "..", "migrations");

/** Applies pending SQL migrations in filename order, each in its own transaction. */
export async function migrate(pool: pg.Pool, log: (msg: string) => void = () => undefined) {
  const client = await pool.connect();
  try {
    // Serialise concurrent migrators (e.g. API and worker starting together).
    await client.query("SELECT pg_advisory_lock(727274)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const applied = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        log(`Applied migration ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => undefined);
    client.release();
  }
}
