import { pool } from "../db/pool.js";
import { migrate } from "../db/migrate.js";

migrate(pool, console.log)
  .then(() => console.log("Database is up to date"))
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
