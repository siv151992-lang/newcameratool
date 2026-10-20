/**
 * Plain-language advice for errors that stop the API or worker from starting, logged next to the
 * raw error so an operator knows what to change.
 */
export function startupHint(err: unknown): string | undefined {
  const code = (err as { code?: string } | null)?.code;
  if (code === "28P01") {
    return (
      "The database rejected the password. Postgres keeps the password it was first created with, so " +
      "POSTGRES_PASSWORD must match it: put the original value back in .env and run `docker compose up -d`. " +
      "If the database holds nothing you need, `docker compose down -v` deletes it (and the generated " +
      "secrets) so everything is created again."
    );
  }
  if (code === "3D000") return "The database named in DATABASE_URL does not exist. Create it, or fix the name in DATABASE_URL.";
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "The database could not be reached. Check that PostgreSQL is running and that DATABASE_URL points to it.";
  }
  return undefined;
}
