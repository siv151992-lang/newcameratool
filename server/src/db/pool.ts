import pg from "pg";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

// bigint columns (byte counts) come back as strings by default; they fit safely in a JS number.
pg.types.setTypeParser(20, (v) => Number(v));
// numeric columns (percentages)
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DATABASE_POOL_SIZE,
  // No JIT compilation: PostgreSQL compiles queries it estimates as costly (the dashboard summary over
  // 20 000 cameras), which took ~0.5 s per call (5 s under load) for queries that run in ~0.1 s. It
  // is meant for long analytical queries, not for these. Done before the connection is first used;
  // a database that refuses it still works, with JIT.
  onConnect: async (client: pg.ClientBase) => {
    await client.query("SET jit = off").catch((err: Error) => logger.warn({ err: err.message }, "Could not turn off JIT for a database connection"));
  },
});
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
