import { describe, expect, it } from "vitest";
import { assessHealth, type CameraSnapshot, detectAnomalies, recommendActions } from "../../src/ai/analysis.js";
import { currentSegment, forecastUsage, linearFit, type UsagePoint } from "../../src/ai/forecast.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 20, 12);
const TOTAL = 128e9;

/** Hourly points ending at NOW: usage starts at `start` and grows `perDay` points per day. */
function series(hours: number, start: number, perDay: number, opts: { end?: number; noise?: number } = {}): UsagePoint[] {
  const end = opts.end ?? NOW;
  return Array.from({ length: hours + 1 }, (_, i) => {
    const t = end - (hours - i) * HOUR;
    const wobble = opts.noise ? Math.sin(i * 1.7) * opts.noise : 0;
    const pct = start + (perDay * i) / 24 + wobble;
    return { t, usedPercentage: pct, usedBytes: Math.round((pct / 100) * TOTAL), totalBytes: TOTAL };
  });
}
const T = { warningThreshold: 80, criticalThreshold: 90, now: NOW };

describe("linearFit", () => {
  it("recovers an exact line", () => {
    const fit = linearFit([0, 1, 2, 3], [10, 12, 14, 16]);
    expect(fit.slope).toBeCloseTo(2);
    expect(fit.intercept).toBeCloseTo(10);
    expect(fit.rSquared).toBeCloseTo(1);
  });
});

describe("forecastUsage", () => {
  it("estimates days to the warning and critical thresholds from steady growth", () => {
    // 7 days at 2 points/day: 50% → 64%.
    const f = forecastUsage(series(7 * 24, 50, 2), T);
    expect(f.status).toBe("growing");
    expect(f.confidence).toBe("high");
    expect(f.growthPercentPerDay).toBeCloseTo(2, 2);
    expect(f.growthBytesPerDay).toBeCloseTo(0.02 * TOTAL, -6);
    expect(f.current?.usedPercentage).toBe(64);
    expect(f.daysToWarning).toBe(8); // (80 - 64) / 2
    expect(f.daysToCritical).toBe(13); // (90 - 64) / 2
    expect(f.criticalAt).toBe(new Date(NOW + 13 * 24 * HOUR).toISOString());
    expect(f.projections).toEqual([
      { horizonDays: 1, usedPercentage: 66 },
      { horizonDays: 7, usedPercentage: 78 },
      { horizonDays: 30, usedPercentage: 100 },
    ]);
    expect(f.period).toMatchObject({ points: 169, days: 7 });
  });

  it("refuses to forecast from too little history", () => {
    const f = forecastUsage(series(3, 50, 2), T);
    expect(f.status).toBe("insufficient_data");
    expect(f.daysToCritical).toBeNull();
    expect(f.notes[0]).toMatch(/Not enough history/);
    expect(forecastUsage([], T).notes[0]).toMatch(/No successful storage measurements/);
  });

  it("withholds long projections for short histories and lowers confidence", () => {
    const f = forecastUsage(series(12, 50, 2), T); // 12 hours
    expect(f.projections.map((p) => p.horizonDays)).toEqual([1]);
    expect(f.confidence).toBe("low");
    expect(f.notes.join(" ")).toMatch(/Longer projections are withheld/);
  });

  it("uses only the measurements since the card was formatted", () => {
    const before = series(48, 70, 3, { end: NOW - 49 * HOUR });
    const after = series(48, 10, 1);
    expect(currentSegment([...before, ...after])).toHaveLength(after.length);
    const f = forecastUsage([...before, ...after], T);
    expect(f.growthPercentPerDay).toBeCloseTo(1, 2);
    expect(f.notes[0]).toMatch(/only measurements since then are used/);
  });

  it("recognises stable usage, a full card that overwrites, and an already crossed threshold", () => {
    const stable = forecastUsage(series(48, 40, 0), T);
    expect(stable.status).toBe("stable");
    expect(stable.daysToWarning).toBeNull();

    const full = forecastUsage(series(48, 99, 0), T);
    expect(full.status).toBe("full_overwriting");
    expect(full.daysToCritical).toBe(0);
    expect(full.notes.join(" ")).toMatch(/overwrites its oldest recordings/);

    expect(forecastUsage(series(48, 85, 1), T)).toMatchObject({ daysToWarning: 0, daysToCritical: 3 });
  });

  it("flags irregular usage with a poor fit", () => {
    const f = forecastUsage(series(48, 50, 0.2, { noise: 2 }), T);
    expect(f.confidence).toBe("low");
    expect(f.notes.join(" ")).toMatch(/irregular/);
  });
});

const cam = (over: Partial<CameraSnapshot> = {}): CameraSnapshot => ({
  id: "c1", name: "Office 03", host: "10.10.15.57", location: "Office", brand: "hikvision", monitoringEnabled: true,
  connection: "online", storageHealth: "healthy", recordingState: "recording", recordingDetail: null, usedPercentage: 50,
  lastSuccessAt: NOW, lastErrorCode: null, lastErrorMessage: null, warningThreshold: 80, criticalThreshold: 90,
  openAlerts: [], disconnects24h: 0, disconnects7d: 0, ...over,
});

describe("detectAnomalies", () => {
  const types = (a: { type: string }[]) => a.map((x) => x.type);

  it("finds nothing for a healthy, steadily recording camera", () => {
    const points = series(7 * 24, 30, 1);
    expect(detectAnomalies(cam(), points, forecastUsage(points, T), NOW)).toEqual([]);
  });

  it("detects a consumption spike against the long-run trend", () => {
    const points = [...series(6 * 24, 30, 0.5, { end: NOW - 24 * HOUR }), ...series(23, 33, 12).slice(1)];
    const found = detectAnomalies(cam(), points, forecastUsage(points, T), NOW);
    expect(types(found)).toContain("usage_spike");
    expect(forecastUsage(points, T).notes.join(" ")).toMatch(/if that continues, the critical threshold would be reached in about \d/);
    expect(found.find((a) => a.type === "usage_spike")!.severity).toBe("critical");
  });

  it("detects a sharp drop and a capacity change", () => {
    const drop = [...series(24, 70, 1, { end: NOW - 25 * HOUR }), ...series(24, 20, 1)];
    expect(types(detectAnomalies(cam(), drop, forecastUsage(drop, T), NOW))).toContain("usage_drop");
    const swapped = [...series(24, 50, 1, { end: NOW - 25 * HOUR }), ...series(24, 50, 1).map((p) => ({ ...p, totalBytes: 256e9 }))];
    expect(types(detectAnomalies(cam(), swapped, forecastUsage(swapped, T), NOW))).toContain("capacity_changed");
  });

  it("warns when usage is frozen while the camera claims to record", () => {
    const points = series(30, 42, 0);
    const found = detectAnomalies(cam(), points, forecastUsage(points, T), NOW);
    expect(found.find((a) => a.type === "stagnant_usage")).toMatchObject({ severity: "warning" });
    // A full card that overwrites is not flagged.
    const full = series(30, 99, 0);
    expect(types(detectAnomalies(cam({ usedPercentage: 99 }), full, forecastUsage(full, T), NOW))).not.toContain("stagnant_usage");
  });

  it("detects repeated disconnections and stale data", () => {
    const found = detectAnomalies(cam({ disconnects24h: 3, disconnects7d: 4, lastSuccessAt: NOW - 8 * HOUR }), [], forecastUsage([], T), NOW);
    expect(found.find((a) => a.type === "repeated_disconnects")?.severity).toBe("critical");
    expect(types(found)).toContain("stale_data");
  });
});

describe("assessHealth and recommendActions", () => {
  it("scores a healthy camera as good and explains deductions for a bad one", () => {
    const points = series(7 * 24, 30, 1);
    const f = forecastUsage(points, T);
    expect(assessHealth(cam(), f, [])).toEqual({ score: 100, grade: "good", factors: [] });

    const bad = cam({ connection: "offline", recordingState: "error", openAlerts: [{ id: 1, type: "offline", severity: "critical", title: "Camera offline" }] });
    const h = assessHealth(bad, f, []);
    expect(h.grade).toBe("poor");
    expect(h.score).toBe(10);
    expect(h.factors[0]).toEqual({ label: "Camera is offline", impact: 50 });
  });

  it("recommends concrete, prioritised actions with reasons", () => {
    const points = series(7 * 24, 80, 2); // 94% now, past critical
    const f = forecastUsage(points, T);
    const actions = recommendActions(cam({ recordingState: "idle", connection: "offline", lastErrorMessage: "Timed out" }), f, []);
    expect(actions[0]).toMatchObject({ priority: "critical", action: expect.stringContaining("10.10.15.57"), reason: "Timed out" });
    expect(actions.map((a) => a.priority)).toEqual(["critical", "high", "high"]);

    const soon = forecastUsage(series(7 * 24, 70, 2.5), T); // 87.5% now, critical in 1 day
    expect(recommendActions(cam(), soon, [])[0]).toMatchObject({ priority: "high", action: expect.stringContaining("before") });
    expect(recommendActions(cam({ monitoringEnabled: false }), soon, [])).toEqual([]);
  });
});
