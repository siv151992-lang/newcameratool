import pg from "pg";

/** Starts every test run from an empty test database schema. */
export default async function () {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://cctv:cctv@localhost:5432/cctv_test";
  if (!/test/.test(url)) throw new Error("Refusing to reset a database whose URL does not contain 'test'");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await client.end();
}
