import { describe, expect, it } from "vitest";
import type { StorageReading } from "../../src/integrations/types.js";
import { type CheckResult, evaluateConditions, storageHealth, type Thresholds } from "../../src/monitoring/evaluate.js";
import { DEFAULT_MONITORING_SETTINGS } from "../../src/services/settingsService.js";

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

  it("is critical for unhealthy disks or no disks, warning for read-only", () => {
    expect(storageHealth(reading(10, { healthStatus: "unhealthy" }), T)).toBe("critical");
    expect(storageHealth({ devices: [] }, T)).toBe("critical");
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
    expect(types(e)).toEqual(["disk_unhealthy:critical"]);
    expect(e.active[0]!.description).toContain("smartFailed");
  });

  it("reports read-only and missing storage", () => {
    expect(types(evalWith({ ok: true, reading: reading(20, { writable: false }) }))).toEqual(["disk_readonly:warning"]);
    expect(types(evalWith({ ok: true, reading: { devices: [] } }))).toEqual(["no_storage_device:critical"]);
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
