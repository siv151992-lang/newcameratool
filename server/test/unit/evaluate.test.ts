import { describe, expect, it } from "vitest";
import type { StorageReading } from "../../src/integrations/types.js";
import { type CheckResult, type EvaluationInput, describeOffset, evaluateConditions, storageHealth, type Thresholds } from "../../src/monitoring/evaluate.js";
import { DEFAULT_MONITORING_SETTINGS } from "../../src/services/settingsService.js";
import { capacityChanged, recordingsDropped } from "../../src/monitoring/checkService.js";

const T: Thresholds = { warning: 80, critical: 90, full: 100, hysteresis: 2, usageAlertsEnabled: true };
const GB = 1e9;
const reading = (usedPct: number, extra: Partial<StorageReading["devices"][number]> = {}): StorageReading => {
  const total = 100 * GB;
  const free = total * (1 - usedPct / 100);
  return {
    devices: [{ id: "hdd-1", healthStatus: "healthy", totalBytes: total, freeBytes: free, usedBytes: total - free, usedPercentage: usedPct, writable: true, ...extra }],
    totalBytes: total, freeBytes: free, usedBytes: total - free, usedPercentage: usedPct,
  };
};
const evalWith = (result: CheckResult, over: Partial<Parameters<typeof evaluateConditions>[0]> = {}) =>
  evaluateConditions({
    result,
    connectionStatus: result.ok ? "online" : "unknown",
    consecutiveFailures: result.ok ? 0 : 1,
    consecutiveAuthFailures: 0,
    minutesWithoutStorage: 0,
    thresholds: T,
    settings: DEFAULT_MONITORING_SETTINGS,
    openTypes: new Set(),
    ...over,
  });
const types = (e: ReturnType<typeof evalWith>) => e.active.map((a) => `${a.type}:${a.severity}`);

describe("storageHealth", () => {
  it.each([
    [50, "healthy"], [80, "warning"], [89.99, "warning"], [90, "critical"], [100, "critical"],
  ])("%s%% used → %s", (pct, expected) => {
    expect(storageHealth(reading(pct), T)).toBe(expected);
  });

  it("is a warning (not critical) for unhealthy disks, no disks and read-only", () => {
    expect(storageHealth(reading(10, { healthStatus: "unhealthy" }), T)).toBe("warning");
    expect(storageHealth({ devices: [] }, T)).toBe("warning");
    expect(storageHealth(reading(10, { writable: false }), T)).toBe("warning");
  });

  it("ignores usage when usage alerts are disabled (overwrite mode)", () => {
    expect(storageHealth(reading(99), { ...T, usageAlertsEnabled: false })).toBe("healthy");
  });
});

describe("evaluateConditions", () => {
  it("raises warning, critical and full usage alerts", () => {
    expect(types(evalWith({ ok: true, reading: reading(50) }))).toEqual([]);
    expect(types(evalWith({ ok: true, reading: reading(85) }))).toEqual(["storage_usage:warning"]);
    expect(types(evalWith({ ok: true, reading: reading(95) }))).toEqual(["storage_usage:critical"]);
    const full = evalWith({ ok: true, reading: reading(100) });
    expect(full.active[0]?.title).toBe("Storage full");
  });

  it("applies hysteresis before clearing an open usage alert", () => {
    const open = new Set(["storage_usage" as const]);
    expect(types(evalWith({ ok: true, reading: reading(79) }, { openTypes: open }))).toEqual(["storage_usage:warning"]);
    expect(types(evalWith({ ok: true, reading: reading(77) }, { openTypes: open }))).toEqual([]);
    expect(types(evalWith({ ok: true, reading: reading(79) }))).toEqual([]);
  });

  it("reports disk failures from the vendor status", () => {
    const e = evalWith({ ok: true, reading: reading(20, { healthStatus: "unhealthy", rawStatus: "smartFailed" }) });
    expect(types(e)).toEqual(["disk_unhealthy:warning"]);
    expect(e.active[0]!.description).toContain("smartFailed");
  });

  it("reports read-only and missing storage", () => {
    expect(types(evalWith({ ok: true, reading: reading(20, { writable: false }) }))).toEqual(["disk_readonly:warning"]);
    expect(types(evalWith({ ok: true, reading: { devices: [] } }))).toEqual(["no_storage_device:warning"]);
  });

  it("never infers disk problems from a network failure and does not resolve storage alerts", () => {
    const e = evalWith({ ok: false, errorCode: "TIMEOUT", errorMessage: "timeout" });
    expect(e.active).toEqual([]);
    expect(e.evaluated).toEqual(["offline", "auth_failure"]);
  });

  it("raises offline only when the connection status is offline", () => {
    const fail: CheckResult = { ok: false, errorCode: "UNREACHABLE", errorMessage: "refused" };
    expect(types(evalWith(fail, { connectionStatus: "online", consecutiveFailures: 1 }))).toEqual([]);
    expect(types(evalWith(fail, { connectionStatus: "offline", consecutiveFailures: 3 }))).toEqual(["offline:critical"]);
  });

  it("raises auth failures after the configured number of attempts", () => {
    const fail: CheckResult = { ok: false, errorCode: "AUTH_FAILED", errorMessage: "rejected" };
    expect(types(evalWith(fail, { consecutiveAuthFailures: 1 }))).toEqual([]);
    expect(types(evalWith(fail, { consecutiveAuthFailures: 2 }))).toEqual(["auth_failure:critical"]);
  });

  it("raises storage-unavailable after the configured period of API errors", () => {
    const fail: CheckResult = { ok: false, errorCode: "API_UNAVAILABLE", errorMessage: "404" };
    expect(types(evalWith(fail, { minutesWithoutStorage: 10 }))).toEqual([]);
    expect(types(evalWith(fail, { minutesWithoutStorage: 31 }))).toEqual(["storage_unavailable:warning"]);
  });
});

describe("recording alerts", () => {
  const ok: CheckResult = { ok: true, reading: reading(50) };
  const rec = (state: "recording" | "idle" | "error" | "unknown") => ({ state, channels: [], detail: `status: ${state}` });

  it("warns when not recording and is critical on a recording error", () => {
    expect(types(evalWith(ok, { recording: rec("recording") }))).toEqual([]);
    expect(types(evalWith(ok, { recording: rec("idle") }))).toEqual(["not_recording:warning"]);
    expect(types(evalWith(ok, { recording: rec("error") }))).toEqual(["not_recording:critical"]);
    expect(evalWith(ok, { recording: rec("idle") }).active[0]!.description).toContain("status: idle");
  });

  it("resolves when recording again, but leaves the alert alone when the state is unknown or not read", () => {
    expect(evalWith(ok, { recording: rec("recording") }).evaluated).toContain("not_recording");
    expect(evalWith(ok, { recording: rec("unknown") }).evaluated).not.toContain("not_recording");
    expect(evalWith(ok).evaluated).not.toContain("not_recording");
  });

  it("can be switched off, which also resolves open alerts", () => {
    const off = evalWith(ok, { recording: rec("idle"), settings: { ...DEFAULT_MONITORING_SETTINGS, recordingAlertsEnabled: false } });
    expect(off.active).toEqual([]);
    expect(off.evaluated).toContain("not_recording");
  });
});

describe("recording retention", () => {
  const input = (days: number, atLeast = false, min = 30): EvaluationInput => ({
    result: { ok: true, reading: { devices: [{ id: "sd", healthStatus: "healthy" }] } },
    connectionStatus: "online", consecutiveFailures: 0, consecutiveAuthFailures: 0, minutesWithoutStorage: 0,
    thresholds: { warning: 80, critical: 90, full: 98, hysteresis: 3, usageAlertsEnabled: true },
    settings: { ...DEFAULT_MONITORING_SETTINGS, minRecordingDays: min }, openTypes: new Set(),
    recordingDays: { days, atLeast },
  });
  it("warns below the required days, not at or above, nor when only a minimum is known", () => {
    expect(evaluateConditions(input(12.5)).active.find((a) => a.type === "recording_retention")).toMatchObject({ severity: "warning", context: { days: 12.5, required: 30 } });
    expect(evaluateConditions(input(30)).active.some((a) => a.type === "recording_retention")).toBe(false);
    expect(evaluateConditions(input(20, true)).active.some((a) => a.type === "recording_retention")).toBe(false);
  });
  it("is off at 0 days required", () => {
    expect(evaluateConditions(input(1, false, 0)).evaluated).not.toContain("recording_retention");
  });
});

describe("camera clock", () => {
  const input = (offsetSeconds: number, minutes = 5): EvaluationInput => ({
    result: { ok: true, reading: { devices: [{ id: "sd", healthStatus: "healthy" }] } },
    connectionStatus: "online", consecutiveFailures: 0, consecutiveAuthFailures: 0, minutesWithoutStorage: 0,
    thresholds: { warning: 80, critical: 90, full: 98, hysteresis: 3, usageAlertsEnabled: true },
    settings: { ...DEFAULT_MONITORING_SETTINGS, clockDriftAlertMinutes: minutes }, openTypes: new Set(),
    clockOffsetSeconds: offsetSeconds,
  });
  it("warns when the clock is off by more than the setting, ahead or behind", () => {
    expect(evaluateConditions(input(750)).active.find((a) => a.type === "clock_wrong")).toMatchObject({
      severity: "warning", description: expect.stringContaining("12 min 30 s ahead"), context: { offsetSeconds: 750 },
    });
    expect(evaluateConditions(input(-7500)).active.find((a) => a.type === "clock_wrong")?.description).toContain("2 h 5 min behind");
    expect(evaluateConditions(input(300)).active.some((a) => a.type === "clock_wrong")).toBe(false);
    expect(evaluateConditions(input(-20)).evaluated).toContain("clock_wrong");
  });
  it("is off at 0 minutes", () => {
    expect(evaluateConditions(input(99_999, 0)).evaluated).not.toContain("clock_wrong");
  });
});

describe("describeOffset", () => {
  it("names days, hours, minutes and seconds", () => {
    expect(describeOffset(5)).toBe("5 s ahead");
    expect(describeOffset(-90_000)).toBe("1 day 1 h behind");
    expect(describeOffset(3600)).toBe("1 h ahead");
  });
});

describe("SD card replaced, formatted or stuck", () => {
  it("sees a card of another size, not small differences in what the camera reports", () => {
    expect(capacityChanged(128 * GB, 64 * GB)).toMatch(/size changed from .* to .*: the card was replaced/);
    expect(capacityChanged(128 * GB, 125 * GB)).toBeNull();
    expect(capacityChanged(null, 64 * GB)).toBeNull();
    expect(capacityChanged(128 * GB, undefined)).toBeNull();
  });

  it("sees recordings that suddenly shrank, not the normal day-to-day changes", () => {
    expect(recordingsDropped(30, { days: 0.4 })).toBe("Recordings dropped from 30 days to 0.4 days: the SD card was formatted or replaced, and the older footage is gone.");
    expect(recordingsDropped(30, { days: 29.5 })).toBeNull();
    expect(recordingsDropped(30, { days: 10 })).toBeNull(); // a third: not "sudden" enough
    expect(recordingsDropped(1.5, { days: 0.1 })).toBeNull(); // too little to tell
    expect(recordingsDropped(30, { days: 0.4, atLeast: true })).toBeNull(); // the search stopped early
    expect(recordingsDropped(30, null)).toBeNull();
    expect(recordingsDropped(null, { days: 0.4 })).toBeNull();
  });

  it("shows a replaced or formatted card for a day", () => {
    const detail = "Recordings dropped from 30 days to 0.4 days";
    expect(types(evalWith({ ok: true, reading: reading(5) }, { storageChange: { minutesAgo: 10, detail } }))).toEqual(["storage_changed:warning"]);
    expect(evalWith({ ok: true, reading: reading(5) }, { storageChange: { minutesAgo: 10, detail } }).active[0]!.description).toBe(detail);
    const later = evalWith({ ok: true, reading: reading(5) }, { storageChange: { minutesAgo: 25 * 60, detail } });
    expect(later.active).toEqual([]);
    expect(later.evaluated).toContain("storage_changed"); // resolves the open alert
  });

  it("warns when a card has been formatting or repairing for an hour", () => {
    const busy = reading(5, { healthStatus: "degraded", rawStatus: "formatting", name: "SD card 1" });
    expect(types(evalWith({ ok: true, reading: busy }, { storageDegradedMinutes: 20 }))).toEqual([]);
    const e = evalWith({ ok: true, reading: busy }, { storageDegradedMinutes: 90 });
    expect(types(e)).toEqual(["storage_stuck:warning"]);
    expect(e.active[0]!.description).toContain('SD card 1: "formatting" for 1.5 hours');
    expect(evalWith({ ok: true, reading: reading(5) }, { storageDegradedMinutes: 90 }).active).toEqual([]);
  });

  it("does not apply to cameras without local storage, nor guess when the camera cannot be read", () => {
    const off = evalWith({ ok: true, reading: reading(5) }, { localStorage: false, storageChange: { minutesAgo: 1, detail: "x" } });
    expect(off.active).toEqual([]);
    expect(off.evaluated).toEqual(expect.arrayContaining(["storage_changed", "storage_stuck"]));
    const down = evalWith({ ok: false, errorCode: "TIMEOUT", errorMessage: "timeout" }, { storageChange: { minutesAgo: 1, detail: "x" } });
    expect(down.evaluated).not.toContain("storage_changed");
  });
});

describe("SD card wear and age", () => {
  it("warns from 80% wear, and says replace now from 100%", () => {
    expect(evalWith({ ok: true, reading: reading(5, { wearPercent: 79 }) }).active).toEqual([]);
    const soon = evalWith({ ok: true, reading: reading(5, { wearPercent: 85, name: "SD_DISK" }) });
    expect(types(soon)).toEqual(["storage_worn:warning"]);
    expect(soon.active[0]).toMatchObject({ title: "SD card wearing out" });
    expect(soon.active[0]!.description).toContain("SD_DISK: 85% of its expected life used");
    const past = evalWith({ ok: true, reading: reading(5, { wearPercent: 140 }) });
    expect(past.active[0]).toMatchObject({ title: "SD card past its expected life" });
    expect(past.active[0]!.description).toContain("Replace it now");
  });

  it("is due for replacement after the months set, and off at 0", () => {
    const settings = { ...DEFAULT_MONITORING_SETTINGS, sdCardReplaceMonths: 6 };
    expect(evalWith({ ok: true, reading: reading(5) }, { settings, cardAgeDays: 150 }).active).toEqual([]);
    const due = evalWith({ ok: true, reading: reading(5) }, { settings, cardAgeDays: 200 });
    expect(types(due)).toEqual(["storage_card_age:warning"]);
    expect(due.active[0]!.description).toContain("in use for 6 months; your policy is to replace SD cards every 6 months");
    expect(evalWith({ ok: true, reading: reading(5) }, { cardAgeDays: 2000 }).active).toEqual([]); // 0 = off (the default)
    expect(evalWith({ ok: true, reading: { devices: [] } }, { settings, cardAgeDays: 200 }).active.map((a) => a.type)).toEqual(["no_storage_device"]);
  });
});
