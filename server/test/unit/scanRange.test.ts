import { describe, expect, it } from "vitest";
import { parseRange } from "../../src/services/networkScanService.js";

describe("scan ranges", () => {
  it("reads a network, a range, a short range and one address", () => {
    const net = parseRange("192.168.1.0/24");
    expect(net).toHaveLength(254); // without the network and broadcast addresses
    expect([net[0], net.at(-1)]).toEqual(["192.168.1.1", "192.168.1.254"]);
    expect(parseRange("192.168.1.10-192.168.1.12")).toEqual(["192.168.1.10", "192.168.1.11", "192.168.1.12"]);
    expect(parseRange("10.0.0.250-252")).toEqual(["10.0.0.250", "10.0.0.251", "10.0.0.252"]);
    expect(parseRange(" 10.0.0.7 ")).toEqual(["10.0.0.7"]);
    expect(parseRange("10.0.0.5/32")).toEqual(["10.0.0.5"]);
    expect(parseRange("10.0.4.0/22")).toHaveLength(1022);
  });

  it("refuses what is not a range, or too large", () => {
    expect(() => parseRange("10.0.0.0/16")).toThrow(/at most 1024/);
    expect(() => parseRange("10.0.0.1-10.0.9.1")).toThrow(/at most 1024/);
    expect(() => parseRange("10.0.0.9-10.0.0.1")).toThrow(/ends before/);
    expect(() => parseRange("camera.local")).toThrow(/not an IPv4/);
    expect(() => parseRange("10.0.0.300")).toThrow(/not an IPv4/);
  });
});
