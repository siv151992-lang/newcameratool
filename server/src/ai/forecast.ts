/**
 * Transparent statistical storage forecasting. No machine learning: an ordinary least-squares
 * line through recent usage measurements, with the assumptions spelled out in the result so a
 * person can judge it.
 *
 * - Only the measurements since the last "reset" are used: a usage drop of 5+ points (a card was
 *   formatted, replaced or started overwriting) or a capacity change of more than 5% starts a new
 *   segment, because the old trend no longer describes the card.
 * - A forecast needs at least MIN_POINTS measurements spanning MIN_SPAN_HOURS; otherwise the result
 *   says the data is insufficient instead of extrapolating from noise.
 * - Projections are only offered for horizons the history can support (at most twice the period
 *   observed, or 30 days after a week of well-fitting history), so a one-day history never
 *   produces a 30-day projection.
 */

export interface UsagePoint {
  /** Epoch milliseconds. */
  t: number;
  usedPercentage: number;
  usedBytes?: number | null;
  totalBytes?: number | null;
}

export type ForecastStatus =
  | "insufficient_data" // too few measurements or too short a period
  | "growing" // usage rising: days-to-threshold are estimated
  | "stable" // usage not rising meaningfully
  | "decreasing" // usage falling (e.g. old recordings deleted)
  | "full_overwriting"; // pinned near 100%: the camera is overwriting old footage

export type Confidence = "high" | "medium" | "low";

export interface Projection {
  horizonDays: number;
  usedPercentage: number;
}

export interface Forecast {
  status: ForecastStatus;
  confidence: Confidence | null;
  /** Why the confidence or status is what it is, in plain words. */
  notes: string[];
  current: { usedPercentage: number; usedBytes: number | null; totalBytes: number | null; freeBytes: number | null; measuredAt: number } | null;
  /** Fitted growth in percentage points per day (negative when falling). */
  growthPercentPerDay: number | null;
  /** Fitted growth in bytes per day, from the percentage slope and the current capacity. */
  growthBytesPerDay: number | null;
  /** Rate over the last 24 hours (points/day), for comparison with the long-run trend. */
  recentPercentPerDay: number | null;
  /** Goodness of fit (0-1); null when usage is flat and the fit is trivially exact. */
  rSquared: number | null;
  daysToWarning: number | null;
  daysToCritical: number | null;
  /** ISO timestamps for the estimated crossings. */
  warningAt: string | null;
  criticalAt: string | null;
  projections: Projection[];
  period: { from: number; to: number; points: number; days: number } | null;
}

export interface ForecastOptions {
  warningThreshold: number;
  criticalThreshold: number;
  now?: number;
}

export const MIN_POINTS = 6;
export const MIN_SPAN_HOURS = 6;
const DAY = 86_400_000;
const RESET_DROP_POINTS = 5;
const CAPACITY_CHANGE = 0.05;
const FLAT_PERCENT_PER_DAY = 0.05;
const FULL_PERCENT = 97;
const HORIZONS = [1, 7, 30];

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const clampPct = (n: number) => Math.min(100, Math.max(0, n));

/** Returns the points after the last reset (format, overwrite drop or card swap). */
export function currentSegment(points: UsagePoint[]): UsagePoint[] {
  let start = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;
    const dropped = prev.usedPercentage - cur.usedPercentage >= RESET_DROP_POINTS;
    const resized =
      !!prev.totalBytes && !!cur.totalBytes && Math.abs(cur.totalBytes - prev.totalBytes) / prev.totalBytes > CAPACITY_CHANGE;
    if (dropped || resized) start = i;
  }
  return points.slice(start);
}

/** Least squares y = a + b·x; x in days. */
export function linearFit(xs: number[], ys: number[]) {
  const n = xs.length;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const rSquared = syy === 0 || sxx === 0 ? null : Math.min(1, (sxy * sxy) / (sxx * syy));
  return { slope, intercept, rSquared };
}

function confidenceOf(points: number, spanDays: number, rSquared: number | null, flat: boolean): { confidence: Confidence; notes: string[] } {
  const notes: string[] = [];
  const fit = flat ? 1 : (rSquared ?? 0);
  let confidence: Confidence;
  if (spanDays >= 3 && points >= 24 && fit >= 0.8) confidence = "high";
  else if (spanDays >= 1 && points >= 12 && fit >= 0.5) confidence = "medium";
  else confidence = "low";
  if (spanDays < 1) notes.push(`Based on only ${round(spanDays * 24, 1)} hours of measurements.`);
  else if (spanDays < 3) notes.push(`Based on ${round(spanDays, 1)} days of measurements; more history will improve the estimate.`);
  if (!flat && rSquared !== null && rSquared < 0.5) notes.push("Usage is irregular, so the trend line fits the measurements poorly.");
  return { confidence, notes };
}

export function forecastUsage(all: UsagePoint[], opts: ForecastOptions): Forecast {
  const now = opts.now ?? Date.now();
  const points = all.filter((p) => Number.isFinite(p.usedPercentage)).sort((a, b) => a.t - b.t);
  const latest = points.at(-1);
  const current = latest
    ? {
        usedPercentage: round(latest.usedPercentage),
        usedBytes: latest.usedBytes ?? null,
        totalBytes: latest.totalBytes ?? null,
        freeBytes: latest.totalBytes != null && latest.usedBytes != null ? latest.totalBytes - latest.usedBytes : null,
        measuredAt: latest.t,
      }
    : null;
  const empty: Forecast = {
    status: "insufficient_data", confidence: null, notes: [], current, growthPercentPerDay: null, growthBytesPerDay: null,
    recentPercentPerDay: null, rSquared: null, daysToWarning: null, daysToCritical: null, warningAt: null, criticalAt: null,
    projections: [], period: null,
  };
  if (!latest) return { ...empty, notes: ["No successful storage measurements yet."] };

  const segment = currentSegment(points);
  const resetNote = segment.length < points.length
    ? ["Usage dropped or the capacity changed recently (card formatted, replaced or overwriting); only measurements since then are used."]
    : [];
  const first = segment[0]!;
  const spanDays = (latest.t - first.t) / DAY;
  const period = { from: first.t, to: latest.t, points: segment.length, days: round(spanDays, 2) };
  if (segment.length < MIN_POINTS || spanDays * 24 < MIN_SPAN_HOURS) {
    return {
      ...empty,
      period,
      notes: [
        ...resetNote,
        `Not enough history to forecast: ${segment.length} measurement(s) over ${round(spanDays * 24, 1)} hours ` +
          `(needs at least ${MIN_POINTS} over ${MIN_SPAN_HOURS} hours).`,
      ],
    };
  }

  const xs = segment.map((p) => (p.t - first.t) / DAY);
  const ys = segment.map((p) => p.usedPercentage);
  const { slope, rSquared } = linearFit(xs, ys);

  // Recent rate: endpoints of the last 24 hours (needs at least two points six hours apart).
  const recent = segment.filter((p) => p.t >= latest.t - DAY);
  const recentSpan = recent.length >= 2 ? (recent.at(-1)!.t - recent[0]!.t) / DAY : 0;
  const recentPercentPerDay =
    recentSpan * 24 >= MIN_SPAN_HOURS ? round((recent.at(-1)!.usedPercentage - recent[0]!.usedPercentage) / recentSpan, 3) : null;

  const flat = Math.abs(slope) < FLAT_PERCENT_PER_DAY;
  const { confidence, notes } = confidenceOf(segment.length, spanDays, rSquared, flat);
  const cur = latest.usedPercentage;
  const capacity = latest.totalBytes ?? null;

  let status: ForecastStatus;
  if (cur >= FULL_PERCENT && slope < FLAT_PERCENT_PER_DAY * 4) status = "full_overwriting";
  else if (flat) status = "stable";
  else if (slope > 0) status = "growing";
  else status = "decreasing";

  const daysTo = (threshold: number): number | null => {
    if (cur >= threshold) return 0;
    if (status !== "growing") return null;
    return round((threshold - cur) / slope, 1);
  };
  const daysToWarning = daysTo(opts.warningThreshold);
  const daysToCritical = daysTo(opts.criticalThreshold);
  const at = (days: number | null) => (days === null ? null : new Date(latest.t + days * DAY).toISOString());

  // Offer a horizon only when the history covers at least half of it; 30 days also when a week
  // or more of history fits the trend well.
  const supported = (h: number) =>
    (h <= Math.max(1, spanDays * 2) && (h < 30 || confidence !== "low")) || (h === 30 && spanDays >= 7 && confidence === "high");
  const projections = HORIZONS.filter(supported).map((h) => ({
    horizonDays: h,
    usedPercentage: round(clampPct(cur + slope * h)),
  }));
  if (projections.length < HORIZONS.length) {
    notes.push(`Longer projections are withheld until there is enough history (${round(spanDays, 1)} days so far).`);
  }
  // A recent burst the long-run line cannot show yet: say what happens if it continues.
  if (recentPercentPerDay !== null && recentPercentPerDay >= 1 && recentPercentPerDay >= 2 * Math.max(slope, 0) && cur < opts.criticalThreshold) {
    const atRecent = round((opts.criticalThreshold - cur) / recentPercentPerDay, 1);
    notes.push(
      `Usage grew ${round(recentPercentPerDay, 1)} points per day over the last 24 hours, much faster than the trend; ` +
        `if that continues, the critical threshold would be reached in about ${atRecent} days.`,
    );
  }
  if (status === "full_overwriting") {
    notes.push("Storage is pinned near full, which normally means the camera overwrites its oldest recordings.");
  }
  // Data older than a day says little about now.
  if (now - latest.t > DAY) notes.push("The most recent measurement is more than a day old.");

  return {
    status,
    confidence,
    notes: [...resetNote, ...notes],
    current,
    growthPercentPerDay: round(slope, 3),
    growthBytesPerDay: capacity !== null ? Math.round((slope / 100) * capacity) : null,
    recentPercentPerDay,
    rSquared: rSquared === null ? null : round(rSquared, 3),
    daysToWarning,
    daysToCritical,
    warningAt: at(daysToWarning),
    criticalAt: at(daysToCritical),
    projections,
    period,
  };
}
