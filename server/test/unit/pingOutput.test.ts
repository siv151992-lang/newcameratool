import { describe, expect, it } from "vitest";
import { parsePingOutput } from "../../src/services/pingService.js";

describe("reading ping's output", () => {
  it("gives each echo's time, with lost ones as null", () => {
    const out = `PING 10.10.17.73 (10.10.17.73) 56(84) bytes of data.
64 bytes from 10.10.17.73: icmp_seq=1 ttl=64 time=0.412 ms
64 bytes from 10.10.17.73: icmp_seq=2 ttl=64 time=1.08 ms
64 bytes from 10.10.17.73: icmp_seq=4 ttl=64 time=0.390 ms

--- 10.10.17.73 ping statistics ---
4 packets transmitted, 3 received, 25% packet loss, time 905ms`;
    expect(parsePingOutput(out, 4)).toEqual({ times: [0.412, 1.08, null, 0.39] });
  });

  it("reads BusyBox ping too (counts from 0)", () => {
    const out = "64 bytes from 10.0.0.5: seq=0 ttl=64 time=0.512 ms\n64 bytes from 10.0.0.5: seq=1 ttl=64 time=0.401 ms\n\n--- 10.0.0.5 ping statistics ---\n4 packets transmitted, 2 packets received, 50% packet loss";
    expect(parsePingOutput(out, 4)).toEqual({ times: [0.512, 0.401, null, null] });
  });

  it("all lost, and ping not allowed to run", () => {
    expect(parsePingOutput("4 packets transmitted, 0 received, 100% packet loss", 4)).toEqual({ times: [null, null, null, null] });
    expect(parsePingOutput("ping: socket: Operation not permitted", 4)).toBeNull();
  });
});
