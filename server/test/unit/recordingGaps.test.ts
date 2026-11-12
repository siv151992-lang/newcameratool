import { describe, expect, it } from "vitest";
import { parseDahuaOverwrite } from "../../src/integrations/dahua/parser.js";
import { parseTrackSettings } from "../../src/integrations/hikvision/parser.js";
import { describeMinutes, findRecordingGaps } from "../../src/monitoring/recordingGaps.js";
import { evaluateConditions } from "../../src/monitoring/evaluate.js";
import { DEFAULT_MONITORING_SETTINGS } from "../../src/services/settingsService.js";
import { DS2CD3563G2_TRACK } from "../fixtures/hikvision-ds2cd3563g2.js";

const NOW = Date.UTC(2026, 10, 12, 10, 0); // camera's own clock: 2026-11-12 10:00
const H = 3_600_000;
const list = (segments: [number, number][]) => ({ segments: segments.map(([s, e]) => ({ start: NOW + s * H, end: NOW + e * H })), nowMs: NOW, shiftMs: 0, clips: true });

describe("recording gaps", () => {
  it("finds the stretches without recordings in the last 24 hours", () => {
    // Recording from 2 days ago, a 2-hour break last night (01:00–03:00) and a 20-minute one.
    const gaps = findRecordingGaps(list([[-48, -9], [-7, -2], [-1.6667, 0]]), 30);
    expect(gaps).toEqual([{ from: "2026-11-12 01:00", to: "2026-11-12 03:00", minutes: 120 }]);
    expect(findRecordingGaps(list([[-48, -9], [-7, -2], [-1.6667, 0]]), 15)).toHaveLength(2);
  });

  it("does not count the time before a new or formatted card's first recording, nor the last 15 minutes", () => {
    expect(findRecordingGaps(list([[-3, -0.1]]), 30)).toEqual([]);
  });

  it("reports one gap for the whole day when nothing was recorded, and recording since that stopped", () => {
    expect(findRecordingGaps({ segments: [], nowMs: NOW, shiftMs: 0, clips: true }, 60)).toEqual([{ from: "2026-11-11 10:00", to: "2026-11-12 09:45", minutes: 1425, ongoing: true }]);
    expect(findRecordingGaps(list([[-48, -5]]), 60)).toEqual([{ from: "2026-11-12 05:00", to: "2026-11-12 09:45", minutes: 285, ongoing: true }]);
  });

  it("names durations", () => {
    expect(describeMinutes(45)).toBe("45 min");
    expect(describeMinutes(90)).toBe("1 h 30 min");
    expect(describeMinutes(1500)).toBe("1 day 1 h");
  });
});

describe("recording set-up from the camera", () => {
  it("Hikvision: overwrite from LoopEnable, continuous from the schedule", () => {
    expect(parseTrackSettings(DS2CD3563G2_TRACK())).toEqual({ overwrite: true, continuous: true });
    expect(parseTrackSettings(DS2CD3563G2_TRACK().replace("<LoopEnable>true", "<LoopEnable>false"))).toMatchObject({ overwrite: false });
    const motionOnly = DS2CD3563G2_TRACK().replace(/<ActionRecordingMode>CMR</g, "<ActionRecordingMode>MOTION<");
    expect(parseTrackSettings(motionOnly)).toMatchObject({ continuous: false });
  });

  it("Dahua: overwrite from the storage group", () => {
    expect(parseDahuaOverwrite("table.StorageGroup[0].Name=ReadWrite\r\ntable.StorageGroup[0].OverWrite=true\r\n")).toBe(true);
    expect(parseDahuaOverwrite("table.StorageGroup[0].OverWrite=false\r\n")).toBe(false);
    expect(parseDahuaOverwrite("Error\r\nBad Request!\r\n")).toBeUndefined();
  });
});

describe("overwrite and gap alerts", () => {
  const GB = 1e9;
  const reading = { devices: [{ id: "sd", healthStatus: "healthy" as const, totalBytes: 100 * GB, freeBytes: 50 * GB, usedPercentage: 50 }], totalBytes: 100 * GB, freeBytes: 50 * GB, usedPercentage: 50 };
  const evalWith = (over: Partial<Parameters<typeof evaluateConditions>[0]>) =>
    evaluateConditions({
      result: { ok: true, reading }, connectionStatus: "online", consecutiveFailures: 0, consecutiveAuthFailures: 0, minutesWithoutStorage: 0,
      thresholds: { warning: 80, critical: 90, full: 100, hysteresis: 2, usageAlertsEnabled: true }, settings: DEFAULT_MONITORING_SETTINGS, openTypes: new Set(), ...over,
    });

  it("warns when overwrite is off, resolves when on, and says nothing when not reported", () => {
    expect(evalWith({ recordingOverwrite: false }).active.map((a) => a.type)).toEqual(["overwrite_off"]);
    const on = evalWith({ recordingOverwrite: true });
    expect(on.active).toEqual([]);
    expect(on.evaluated).toContain("overwrite_off");
    expect(evalWith({}).evaluated).not.toContain("overwrite_off");
  });

  it("lists the gaps, and can be turned off", () => {
    const gaps = [{ from: "2026-11-12 01:00", to: "2026-11-12 03:00", minutes: 120 }];
    const e = evalWith({ recordingGaps: gaps });
    expect(e.active[0]).toMatchObject({ type: "recording_gaps", severity: "warning" });
    expect(e.active[0]!.description).toContain("No recordings for 2 h in the last 24 hours (camera time): 01:00–03:00 (2 h)");
    expect(evalWith({ recordingGaps: [] }).evaluated).toContain("recording_gaps");
    // Stopped recording: the gap running up to now is the "not recording" alert, not a second one.
    const ongoing = [{ ...gaps[0]!, ongoing: true }];
    expect(evalWith({ recordingGaps: ongoing, recording: { state: "idle", channels: [] } }).active.map((a) => a.type)).toEqual(["not_recording"]);
    expect(evalWith({ recordingGaps: ongoing, recording: { state: "recording", channels: [] } }).active.map((a) => a.type)).toEqual(["recording_gaps"]);
    expect(evalWith({ recordingGaps: gaps, settings: { ...DEFAULT_MONITORING_SETTINGS, recordingGapMinutes: 0 } }).active).toEqual([]);
  });
});
