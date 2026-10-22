import { createHash, randomBytes } from "node:crypto";

/** A random link token (256 bits) and the SHA-256 hash that is stored instead of it. */
export function newLinkToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashLinkToken(token) };
}

export const hashLinkToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Shape check before any lookup: 43 base64url characters. */
export const isLinkToken = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{43}$/.test(v);
