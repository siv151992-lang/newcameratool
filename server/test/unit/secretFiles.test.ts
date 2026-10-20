import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "pg-connection-string";
import { describe, expect, it } from "vitest";
import { withPasswordFromFile } from "../../src/config.js";
import { CredentialCipher, parseKeyConfig } from "../../src/security/crypto.js";
import { loadOrCreateKeyFile } from "../../src/security/keyFile.js";

const tempDir = () => mkdtempSync(join(tmpdir(), "cctv-secrets-"));

describe("loadOrCreateKeyFile", () => {
  it("creates a private 32-byte key on first use, in a new folder, and reuses it afterwards", () => {
    const path = join(tempDir(), "data", "credential.key");
    const first = loadOrCreateKeyFile(path);
    expect(first.created).toBe(true);
    expect(Buffer.from(first.key, "base64")).toHaveLength(32);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const again = loadOrCreateKeyFile(path);
    expect(again).toEqual({ key: first.key, created: false });
    // The key actually works for encryption.
    const cipher = new CredentialCipher({ 1: again.key }, 1);
    expect(cipher.decrypt(cipher.encrypt("Cam-Pass-123"))).toBe("Cam-Pass-123");
  });

  it("gives every caller the same key when several start together", () => {
    const path = join(tempDir(), "credential.key");
    const results = Array.from({ length: 5 }, () => loadOrCreateKeyFile(path));
    expect(new Set(results.map((r) => r.key)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it("refuses a corrupted key file and explains an unwritable location", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "bad.key"), "not-a-key\n");
    expect(() => loadOrCreateKeyFile(join(dir, "bad.key"))).toThrow(/does not contain a base64-encoded 32-byte key/);
    writeFileSync(join(dir, "file"), "x");
    expect(() => loadOrCreateKeyFile(join(dir, "file", "credential.key"))).toThrow(/Set CREDENTIAL_ENCRYPTION_KEY/);
  });
});

describe("parseKeyConfig", () => {
  const key = Buffer.alloc(32, 7).toString("base64");

  it("uses the generated key only when no key is configured", () => {
    let calls = 0;
    const fallback = () => (calls++, key);
    expect(parseKeyConfig(undefined, undefined, 1, fallback)).toEqual({ 1: key });
    expect(parseKeyConfig("configured", undefined, 1, fallback)).toEqual({ 1: "configured" });
    expect(calls).toBe(1);
    expect(() => parseKeyConfig(undefined, undefined, 1)).toThrow(/CREDENTIAL_ENCRYPTION_KEY is required/);
  });
});

describe("withPasswordFromFile", () => {
  it("puts the file's password into the database URL, encoding special characters", () => {
    const file = join(tempDir(), "db_password");
    writeFileSync(file, "p@ss/w:rd%1\n");
    const url = withPasswordFromFile("postgres://cctv@db:5432/cctv", file);
    expect(parse(url)).toMatchObject({ user: "cctv", password: "p@ss/w:rd%1", host: "db", port: "5432", database: "cctv" });
    expect(readFileSync(file, "utf8")).toBe("p@ss/w:rd%1\n");
  });

  it("rejects an empty password file", () => {
    const file = join(tempDir(), "empty");
    writeFileSync(file, "\n");
    expect(() => withPasswordFromFile("postgres://cctv@db/cctv", file)).toThrow(/is empty/);
  });
});
