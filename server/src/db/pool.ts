import pg from "pg";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

// bigint columns (byte counts) come back as strings by default; they fit safely in a JS number.
pg.types.setTypeParser(20, (v) => Number(v));
// numeric columns (percentages)
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 15 });
pool.on("error", (err) => logger.error({ err: err.message }, "Postgres pool error"));

export type Queryable = pg.Pool | pg.PoolClient;

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
