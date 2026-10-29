import { describe, expect, it } from "vitest";
import { buildRate } from "./LiveVideo";

describe("building the playback reserve", () => {
  it("plays slower the closer the reserve is to running out, and at normal speed once it is there", () => {
    expect(buildRate(0.4, 10)).toBe(0.7);
    expect(buildRate(1.5, 10)).toBe(0.82);
    expect(buildRate(4, 10)).toBe(0.92);
    expect(buildRate(8, 10)).toBe(0.97);
    expect(buildRate(11, 10)).toBe(1);
    // Always slower than the camera sends (1 s per s) while low: the reserve grows, never shrinks.
    for (const ahead of [0, 0.5, 1, 2, 4.9]) expect(buildRate(ahead, 10)).toBeLessThan(1);
  });
});
