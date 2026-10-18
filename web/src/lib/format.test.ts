import { describe, expect, it } from "vitest";
import { errorCategory, formatBytes, formatPercent, relativeTime } from "./format";

describe("format helpers", () => {
  it("formats bytes and percentages", () => {
    expect(formatBytes(127_865_454_592)).toBe("128 GB");
    expect(formatBytes(null)).toBe("—");
    expect(formatPercent(95.38)).toBe("95.4%");
    expect(formatPercent(100)).toBe("100%");
    expect(formatPercent(null)).toBe("—");
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    expect(relativeTime("2026-01-01T11:59:50Z", now)).toBe("just now");
    expect(relativeTime("2026-01-01T11:55:00Z", now)).toMatch(/5 minutes ago/);
    expect(relativeTime(null)).toBe("Never");
  });

  it("categorises errors", () => {
    expect(errorCategory("TIMEOUT")).toBe("Network");
    expect(errorCategory("AUTH_FAILED")).toBe("Authentication");
    expect(errorCategory("INVALID_RESPONSE")).toBe("Camera API");
    expect(errorCategory(null)).toBeNull();
  });
});
