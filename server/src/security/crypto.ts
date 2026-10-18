import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encryption for camera passwords.
 * Stored format: v<keyVersion>:<iv b64>:<authTag b64>:<ciphertext b64>
 * Several key versions can be loaded at once so keys can be rotated: new secrets are
 * written with the current version, old ones still decrypt until re-encrypted.
 */
export class CredentialCipher {
  private readonly keys = new Map<number, Buffer>();

  constructor(keys: Record<number, string>, private readonly currentVersion: number) {
    for (const [version, b64] of Object.entries(keys)) {
      const key = Buffer.from(b64, "base64");
      if (key.length !== 32) throw new Error(`Encryption key v${version} must be 32 bytes (base64-encoded)`);
      this.keys.set(Number(version), key);
    }
    if (!this.keys.has(currentVersion)) throw new Error(`No encryption key configured for version ${currentVersion}`);
  }

  get keyVersion() {
    return this.currentVersion;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.keys.get(this.currentVersion)!, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v${this.currentVersion}:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
  }

  decrypt(payload: string): string {
    const m = /^v(\d+):([^:]+):([^:]+):([^:]*)$/.exec(payload);
    if (!m) throw new Error("Malformed encrypted credential");
    const key = this.keys.get(Number(m[1]));
    if (!key) throw new Error(`Encryption key v${m[1]} is not configured`);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(m[2]!, "base64"));
    decipher.setAuthTag(Buffer.from(m[3]!, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(m[4]!, "base64")), decipher.final()]).toString("utf8");
  }
}

export function parseKeyConfig(single: string | undefined, multi: string | undefined, version: number) {
  const keys: Record<number, string> = {};
  if (multi) {
    for (const part of multi.split(",").map((s) => s.trim()).filter(Boolean)) {
      const idx = part.indexOf(":");
      if (idx < 1) throw new Error("CREDENTIAL_ENCRYPTION_KEYS must look like '2:<base64>,1:<base64>'");
      keys[Number(part.slice(0, idx))] = part.slice(idx + 1);
    }
  }
  if (single) keys[version] = single;
  if (Object.keys(keys).length === 0) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY is required. Generate one with: openssl rand -base64 32");
  }
  return keys;
}
