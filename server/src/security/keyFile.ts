import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Reads the credential encryption key from `path`, creating the file with a new random
 * 32-byte key (base64) on first use. Used when no key is configured in the environment, so a
 * Docker deployment works without generating one by hand.
 *
 * Creation is safe when the API and worker start at the same time: the key is written to a
 * private temp file and hard-linked into place, which fails atomically if the other process won.
 */
export function loadOrCreateKeyFile(path: string): { key: string; created: boolean } {
  try {
    return { key: readKey(path), created: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
  }
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600, flag: "wx" });
    try {
      linkSync(tmp, path);
      return { key: readKey(path), created: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return { key: readKey(path), created: false };
      throw err;
    } finally {
      unlinkSync(tmp);
    }
  } catch (err) {
    throw new Error(
      `No CREDENTIAL_ENCRYPTION_KEY is set and the key file ${path} could not be created ` +
        `(${(err as Error).message}). Set CREDENTIAL_ENCRYPTION_KEY, or make the folder writable.`,
    );
  }
}

function readKey(path: string): string {
  const key = readFileSync(path, "utf8").trim();
  if (Buffer.from(key, "base64").length !== 32) {
    throw new Error(`The key file ${path} does not contain a base64-encoded 32-byte key`);
  }
  return key;
}
