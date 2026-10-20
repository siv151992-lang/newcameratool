import { describe, expect, it } from "vitest";
import { HostGuard, HostNotAllowedError } from "../../src/security/hostGuard.js";
import { cidrError, networkSettingsSchema } from "../../src/services/networkSettings.js";

describe("camera network validation", () => {
  it("accepts ranges and single addresses", () => {
    for (const ok of ["10.10.15.0/24", "10.10.15.57", "192.168.0.0/16", "10.0.0.0/8", "fd00::/16", "fd00::10"]) expect(cidrError(ok), ok).toBeNull();
  });

  it("rejects invalid, malformed and overly broad entries", () => {
    expect(cidrError("10.10.15")).toMatch(/not an IP address/);
    expect(cidrError("10.0.0.0/24/1")).toMatch(/not an IP address/);
    expect(cidrError("http://10.0.0.1")).toMatch(/not an IP address/);
    expect(cidrError("10.0.0.0/33")).toMatch(/invalid prefix/);
    expect(cidrError("10.0.0.0/x")).toMatch(/invalid prefix/);
    expect(cidrError("0.0.0.0/0")).toMatch(/too broad/);
    expect(cidrError("10.0.0.0/7")).toMatch(/too broad/);
    expect(cidrError("::/0")).toMatch(/too broad/);
  });

  it("trims and de-duplicates the list and requires at least one entry", () => {
    expect(networkSettingsSchema.parse({ allowedNetworks: [" 10.10.15.0/24 ", "10.10.15.0/24", "10.10.16.5"] })).toEqual({
      allowedNetworks: ["10.10.15.0/24", "10.10.16.5"],
    });
    expect(networkSettingsSchema.safeParse({ allowedNetworks: [] }).success).toBe(false);
    const bad = networkSettingsSchema.safeParse({ allowedNetworks: ["10.10.15.0/24", "nope"] });
    expect(bad.success || bad.error.issues[0]).toMatchObject({ path: ["allowedNetworks", 1] });
  });
});

describe("HostGuard with a reloadable allowlist", () => {
  it("uses the loaded list, keeps it on loader failure, and reloads after invalidate()", async () => {
    let list = ["10.10.15.0/24"];
    let fail = false;
    let loads = 0;
    const guard = new HostGuard({
      allowedNetworks: "192.168.0.0/16",
      reloadMs: 60_000,
      loadAllowedNetworks: async () => {
        loads++;
        if (fail) throw new Error("db down");
        return list;
      },
    });
    // Before the first resolve the environment list applies.
    expect(() => guard.checkAddress("192.168.1.10")).not.toThrow();

    await expect(guard.resolve("10.10.15.57")).resolves.toMatchObject({ address: "10.10.15.57" });
    await expect(guard.resolve("192.168.1.10")).rejects.toThrow(HostNotAllowedError);
    expect(loads).toBe(1); // cached within reloadMs

    list = ["10.20.0.0/16"];
    await expect(guard.resolve("10.20.1.1")).rejects.toThrow(/Settings → Camera networks/);
    guard.invalidate();
    await expect(guard.resolve("10.20.1.1")).resolves.toMatchObject({ address: "10.20.1.1" });

    fail = true;
    guard.invalidate();
    await expect(guard.resolve("10.20.1.1")).resolves.toBeTruthy();
    expect(loads).toBe(3);
  });

  it("never allows reserved ranges, even when listed", async () => {
    const guard = new HostGuard({ allowedNetworks: "10.0.0.0/8", loadAllowedNetworks: async () => ["169.254.0.0/16", "127.0.0.0/8"] });
    await expect(guard.resolve("169.254.169.254")).rejects.toThrow(/reserved range/);
    await expect(guard.resolve("127.0.0.1")).rejects.toThrow(/loopback/);
  });
});
