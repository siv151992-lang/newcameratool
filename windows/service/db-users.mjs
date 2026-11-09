// Prints how many users the database has (setup.ps1 creates the first administrator when it is 0).
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = process.env.CCTV_DATA_DIR ?? path.join(ROOT, "data");
const require = createRequire(path.join(ROOT, "app", "package.json"));
const { Client } = require("pg");
const client = new Client({ host: "127.0.0.1", port: 54329, user: "cctv", database: "postgres", password: fs.readFileSync(path.join(DATA, "db_password"), "utf8").trim() });
try {
  await client.connect();
  const exists = (await client.query("SELECT to_regclass('public.users') IS NOT NULL AS ok")).rows[0].ok;
  console.log(exists ? (await client.query("SELECT count(*)::int AS n FROM users")).rows[0].n : 0);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
