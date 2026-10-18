import { describe, expect, it } from "vitest";
import { CredentialCipher, parseKeyConfig } from "../../src/security/crypto.js";
import { HostGuard, HostNotAllowedError, normalizeHost } from "../../src/security/hostGuard.js";
import { hashPassword, verifyPassword } from "../../src/security/passwords.js";
import { redactSecrets } from "../../src/security/redact.js";

const K1 = Buffer.alloc(32, 1).toString("base64");
const K2 = Buffer.alloc(32, 2).toString("base64");

describe("CredentialCipher (AES-256-GCM)", () => {
  it("round-trips and never stores plaintext", () => {
    const c = new CredentialCipher({ 1: K1 }, 1);
    const enc = c.encrypt("Fantasiz_345");
    expect(enc).not.toContain("Fantasiz_345");
    expect(enc.startsWith("v1:")).toBe(true);
    expect(c.decrypt(enc)).toBe("Fantasiz_345");
    expect(c.encrypt("same")).not.toBe(c.encrypt("same")); // random IV
  });

  it("detects tampering", () => {
    const c = new CredentialCipher({ 1: K1 }, 1);
    const parts = c.encrypt("secret").split(":");
    const ct = Buffer.from(parts[3]!, "base64");
    ct[0] = ct[0]! ^ 0xff;
    parts[3] = ct.toString("base64");
    expect(() => c.decrypt(parts.join(":"))).toThrow();
  });

  it("supports key rotation", () => {
    const old = new CredentialCipher({ 1: K1 }, 1).encrypt("old-secret");
    const rotated = new CredentialCipher(parseKeyConfig(undefined, `2:${K2},1:${K1}`, 2), 2);
    expect(rotated.decrypt(old)).toBe("old-secret");
    expect(rotated.encrypt("new").startsWith("v2:")).toBe(true);
    expect(() => new CredentialCipher({ 2: K2 }, 2).decrypt(old)).toThrow(/v1/);
  });

  it("rejects keys of the wrong length", () => {
    expect(() => new CredentialCipher({ 1: Buffer.alloc(16).toString("base64") }, 1)).toThrow(/32 bytes/);
    expect(() => parseKeyConfig(undefined, undefined, 1)).toThrow(/required/);
  });
});

describe("redactSecrets", () => {
  it("removes passwords, auth headers and URL credentials", () => {
    const out = redactSecrets('Authorization: Digest username="admin", response="abc" http://admin:pw123@10.0.0.1/ pw123', ["pw123"]);
    expect(out).not.toContain("pw123");
    expect(out).not.toContain('response="abc"');
    expect(out).toContain("[REDACTED]");
  });
});

describe("user password hashing", () => {
  it("verifies correct passwords only", async () => {
    const h = await hashPassword("Correct-Horse-9");
    expect(h).not.toContain("Correct-Horse-9");
    expect(await verifyPassword("Correct-Horse-9", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
});

describe("HostGuard (SSRF protection)", () => {
  const guard = new HostGuard({ allowedNetworks: "10.0.0.0/8,192.168.0.0/16" });
  const blocked = (a: string) => {
    try {
      guard.checkAddress(a);
      return false;
    } catch (e) {
      return e instanceof HostNotAllowedError;
    }
  };

  it("allows addresses on camera networks", () => {
    expect(blocked("10.10.15.57")).toBe(false);
    expect(blocked("192.168.1.101")).toBe(false);
  });

  it("blocks loopback, metadata, link-local, multicast and outside networks", () => {
    for (const a of ["127.0.0.1", "::1", "::ffff:127.0.0.1", "169.254.169.254", "0.0.0.0", "224.0.0.1", "8.8.8.8", "172.20.0.1", "fe80::1"]) {
      expect(blocked(a), a).toBe(true);
    }
  });

  it("allows loopback only when explicitly enabled", () => {
    expect(() => new HostGuard({ allowedNetworks: "10.0.0.0/8", allowLoopback: true }).checkAddress("127.0.0.1")).not.toThrow();
  });

  it("rejects URLs, credentials and paths in the host field", () => {
    for (const bad of ["http://10.0.0.1", "admin:pw@10.0.0.1", "10.0.0.1/ISAPI", "10.0.0.256", "", "bad_host!"]) {
      expect(() => normalizeHost(bad), bad).toThrow(HostNotAllowedError);
    }
    expect(normalizeHost(" Camera-01.Office.Local ")).toBe("camera-01.office.local");
    expect(normalizeHost("[fd00::10]")).toBe("fd00::10");
  });

  it("resolves hostnames and checks every address", async () => {
    await expect(guard.resolve("localhost")).rejects.toThrow(HostNotAllowedError);
    await expect(guard.resolve("10.1.2.3")).resolves.toEqual({ address: "10.1.2.3", family: 4 });
  });
});
