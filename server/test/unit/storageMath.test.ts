import { describe, expect, it } from "vitest";
import { aggregate, completeDevice } from "../../src/integrations/storageMath.js";
import { formatBytes } from "../../src/lib/format.js";

describe("storage calculations", () => {
  it("computes used = capacity - free and percentages", () => {
    const d = completeDevice({ id: "x", healthStatus: "healthy", totalBytes: 1000, freeBytes: 250 });
    expect(d.usedBytes).toBe(750);
    expect(d.usedPercentage).toBe(75);
  });

  it("aggregates only consistent devices", () => {
    const r = aggregate([
      { id: "a", healthStatus: "healthy", totalBytes: 100, freeBytes: 0 },
      { id: "b", healthStatus: "healthy", totalBytes: 300, freeBytes: 100 },
      { id: "c", healthStatus: "healthy" },
    ]);
    expect(r).toMatchObject({ totalBytes: 400, freeBytes: 100, usedBytes: 300, usedPercentage: 75 });
  });

  it("returns no totals when nothing is measurable", () => {
    expect(aggregate([{ id: "a", healthStatus: "unknown" }]).totalBytes).toBeUndefined();
  });

  it("formats bytes in decimal units", () => {
    expect(formatBytes(127_865_454_592)).toBe("128 GB");
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
    expect(formatBytes(undefined)).toBe("unknown");
  });
});
