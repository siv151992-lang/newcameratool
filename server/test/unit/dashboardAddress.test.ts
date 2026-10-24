import { describe, expect, it } from "vitest";
import { fromInterfaces, fromSiteAddress } from "../../src/services/dashboardAddress.js";

describe("dashboard address", () => {
  it("comes from the Caddy site address", () => {
    expect(fromSiteAddress("10.69.96.25", undefined)).toBe("https://10.69.96.25");
    expect(fromSiteAddress("cctv.example.local", 8443)).toBe("https://cctv.example.local:8443");
    expect(fromSiteAddress("https://10.69.96.25", 443)).toBe("https://10.69.96.25");
    expect(fromSiteAddress("localhost", 8443)).toBeNull();
    expect(fromSiteAddress(":443", undefined)).toBeNull();
    expect(fromSiteAddress(undefined, undefined)).toBeNull();
  });

  it("comes from the first network address, skipping loopback and link-local", () => {
    const nic = (address: string, internal = false) => ({ address, internal, family: "IPv4" as const, netmask: "", mac: "", cidr: null });
    expect(fromInterfaces(4000, { lo: [nic("127.0.0.1", true)], en0: [nic("169.254.3.4"), nic("10.69.96.25")] })).toBe("http://10.69.96.25:4000");
    expect(fromInterfaces(80, { eth0: [nic("192.168.1.20")] })).toBe("http://192.168.1.20");
    expect(fromInterfaces(4000, { lo: [nic("127.0.0.1", true)] })).toBeNull();
  });
});
