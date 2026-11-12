import type { RecordingList } from "../integrations/types.js";

/** A stretch of the last 24 hours without recordings, in the camera's own clock (YYYY-MM-DD HH:MM). */
export interface RecordingGap {
  from: string;
  to: string;
  minutes: number;
  /** Runs up to now: recording has stopped (the "not recording" alert covers it). */
  ongoing?: boolean;
}

const WINDOW_MS = 24 * 3_600_000;
/** The newest minutes are left out: the clip being recorded is often not listed yet. */
const RECENT_MS = 15 * 60_000;
const wall = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/**
 * Gaps of at least `minMinutes` between the camera's clips over the last 24 hours (its own clock).
 * When the oldest clip found starts inside the window (a new or formatted card), the window starts
 * there: the time before it is not a gap. No clips at all is one gap of the whole window.
 */
export function findRecordingGaps(list: RecordingList, minMinutes: number): RecordingGap[] {
  const end = list.nowMs - RECENT_MS;
  let start = list.nowMs - WINDOW_MS;
  const clips = list.segments.filter((s) => s.end > start - 3_600_000 && s.start < end).sort((a, b) => a.start - b.start);
  const earliest = list.segments.reduce((m, s) => Math.min(m, s.start), Infinity);
  if (clips.length && earliest > start) start = earliest;
  const gaps: RecordingGap[] = [];
  let cursor = start;
  for (const c of clips) {
    if (c.start - cursor >= minMinutes * 60_000) gaps.push({ from: wall(cursor), to: wall(c.start), minutes: Math.round((c.start - cursor) / 60_000) });
    cursor = Math.max(cursor, c.end);
  }
  if (end - cursor >= minMinutes * 60_000) gaps.push({ from: wall(cursor), to: wall(end), minutes: Math.round((end - cursor) / 60_000), ongoing: true });
  return gaps;
}

/** "1 h 30 min", "45 min", "1 day 2 h". */
export function describeMinutes(total: number): string {
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  return [d && `${d} day${d === 1 ? "" : "s"}`, h && `${h} h`, (m || !(d || h)) && `${m} min`].filter(Boolean).join(" ");
}
