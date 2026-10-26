import type { RecordingChannelStatus, RecordingReading, RecordingState, StorageReading } from "./types.js";

/**
 * Combines per-channel recording states into one camera state: recording if any channel
 * records, else error if any channel reports an error, else idle, else unknown.
 * `overall` (a camera-wide status some brands report) takes precedence when it is known.
 */
export function combineRecording(channels: RecordingChannelStatus[], overall?: { state: RecordingState; rawStatus?: string }): RecordingReading {
  const states = new Set(channels.map((c) => c.state));
  let state: RecordingState = "unknown";
  if (overall && overall.state !== "unknown") state = overall.state;
  else if (states.has("recording")) state = "recording";
  else if (states.has("error")) state = "error";
  else if (states.has("idle")) state = "idle";
  return { state, channels, detail: describe(channels, overall?.rawStatus) };
}

function describe(channels: RecordingChannelStatus[], overallRaw?: string): string | undefined {
  const parts = channels
    .filter((c) => c.rawStatus !== undefined || c.mode !== undefined)
    .map((c) => `${c.id}: ${[c.rawStatus, c.mode && `(${c.mode})`].filter(Boolean).join(" ")}`);
  if (overallRaw) parts.unshift(`status: ${overallRaw}`);
  return parts.length ? parts.join("; ").slice(0, 500) : undefined;
}

/** Maps the common true/false and 0/1/2 recording flags. */
export function flagToRecordingState(raw: string | boolean | number | undefined): RecordingState {
  if (raw === undefined) return "unknown";
  const s = String(raw).trim().toLowerCase();
  if (["true", "1", "2", "yes", "on"].includes(s)) return "recording";
  if (["false", "0", "no", "off"].includes(s)) return "idle";
  return "unknown";
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s_-]+/g, "");

/** Builds a case/spacing-insensitive mapper from status words to a recording state. */
export function recordingMapper(table: { recording: string[]; idle: string[]; error: string[] }) {
  const sets = {
    recording: new Set(table.recording.map(norm)),
    idle: new Set(table.idle.map(norm)),
    error: new Set(table.error.map(norm)),
  };
  return (raw: string | undefined): RecordingState => {
    if (!raw) return "unknown";
    const s = norm(raw);
    if (sets.recording.has(s)) return "recording";
    if (sets.idle.has(s)) return "idle";
    if (sets.error.has(s)) return "error";
    return "unknown";
  };
}

/**
 * Checks a "recording" status against the storage read in the same check. Many cameras report
 * recording as switched on (schedule active) whatever the card's state, so a camera whose SD card
 * is missing, failed or read-only would show as recording while nothing can be written: that is a
 * recording error. Other states are returned as they are.
 */
export function reconcileRecording(recording: RecordingReading, storage: StorageReading): RecordingReading {
  if (recording.state !== "recording") return recording;
  const devices = storage.devices;
  const why =
    devices.length === 0 ? "no SD card or disk is installed"
    : devices.every((d) => d.healthStatus === "unhealthy") ? "its storage reports an error"
    : devices.every((d) => d.writable === false || d.healthStatus === "unhealthy") ? "its storage is read-only"
    : undefined;
  if (!why) return recording;
  return {
    ...recording,
    state: "error",
    detail: `recording is on, but ${why}, so nothing is being recorded${recording.detail ? ` (${recording.detail})` : ""}`.slice(0, 500),
  };
}
