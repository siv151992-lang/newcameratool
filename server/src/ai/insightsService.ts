import { pool } from "../db/pool.js";
import { notFound } from "../lib/errors.js";
import { thresholdsFor } from "../monitoring/evaluate.js";
import { getMonitoringSettings } from "../services/settingsService.js";
import {
  type Anomaly,
  assessHealth,
  type CameraSnapshot,
  detectAnomalies,
  type HealthAssessment,
  recommendActions,
  type RecommendedAction,
  sortActions,
} from "./analysis.js";
import { type Forecast, forecastUsage, type UsagePoint } from "./forecast.js";

/**
 * Reads monitoring data for AI Mode and runs the statistical analysis. Read-only: nothing here
 * contacts cameras or changes monitoring state, and no credential column is ever selected.
 */

export const HISTORY_DAYS = 14;
/** Measurements are averaged into 15-minute buckets before fitting. */
const BUCKET = "15 minutes";
const CACHE_MS = 60_000;
/** Above this many cameras the analysis is refreshed every 10 minutes, in the background. */
const LARGE_FLEET = 2000;
const LARGE_FLEET_CACHE_MS = 10 * 60_000;

export interface CameraInsight {
  camera: CameraSnapshot & { totalBytes: number | null; usedBytes: number | null; freeBytes: number | null; lastAttemptAt: number | null };
  forecast: Forecast;
  anomalies: Anomaly[];
  health: HealthAssessment;
  actions: RecommendedAction[];
  link: string;
}

export interface FleetInsights {
  generatedAt: string;
  historyDays: number;
  cameras: CameraInsight[];
  actions: RecommendedAction[];
  summary: {
    cameras: number;
    monitored: number;
    offline: number;
    notRecording: number;
    storageCritical: number;
    storageWarning: number;
    criticalWithin7Days: number;
    anomalies: number;
    averageHealth: number | null;
  };
}

const toMs = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : null);

async function loadSnapshots(cameraId?: string) {
  const settings = await getMonitoringSettings();
  const params: unknown[] = [];
  const filter = cameraId ? `AND c.id = $${params.push(cameraId)}` : "";
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.host, c.location, c.brand_key, c.monitoring_enabled, c.warning_threshold, c.critical_threshold,
            s.connection_status, s.storage_health, s.recording_state, s.recording_detail, s.used_percentage,
            s.total_bytes, s.used_bytes, s.free_bytes, s.last_success_at, s.last_attempt_at, s.last_error_code, s.last_error_message,
            (SELECT count(*)::int FROM connection_events e WHERE e.camera_id = c.id AND e.to_status = 'offline'
               AND e.occurred_at > now() - interval '24 hours') AS disconnects_24h,
            (SELECT count(*)::int FROM connection_events e WHERE e.camera_id = c.id AND e.to_status = 'offline'
               AND e.occurred_at > now() - interval '7 days') AS disconnects_7d,
            coalesce((SELECT json_agg(json_build_object('id', a.id, 'type', a.type, 'severity', a.severity, 'title', a.title) ORDER BY a.id)
               FROM alerts a WHERE a.camera_id = c.id AND a.status <> 'resolved'), '[]') AS open_alerts
     FROM cameras c LEFT JOIN camera_status s ON s.camera_id = c.id
     WHERE c.deleted_at IS NULL ${filter}
     ORDER BY lower(c.name)`,
    params,
  );
  return rows.map((r) => {
    const t = thresholdsFor(settings, r);
    return {
      id: r.id as string,
      name: r.name as string,
      host: r.host as string,
      location: (r.location as string | null) ?? null,
      brand: r.brand_key as string,
      monitoringEnabled: r.monitoring_enabled as boolean,
      connection: (r.connection_status ?? "unknown") as CameraSnapshot["connection"],
      storageHealth: (r.storage_health ?? "unknown") as CameraSnapshot["storageHealth"],
      recordingState: (r.recording_state ?? "unknown") as CameraSnapshot["recordingState"],
      recordingDetail: r.recording_detail ?? null,
      usedPercentage: r.used_percentage ?? null,
      totalBytes: r.total_bytes ?? null,
      usedBytes: r.used_bytes ?? null,
      freeBytes: r.free_bytes ?? null,
      lastSuccessAt: toMs(r.last_success_at),
      lastAttemptAt: toMs(r.last_attempt_at),
      lastErrorCode: r.last_error_code ?? null,
      lastErrorMessage: r.last_error_message ?? null,
      warningThreshold: t.warning,
      criticalThreshold: t.critical,
      openAlerts: r.open_alerts,
      disconnects24h: r.disconnects_24h,
      disconnects7d: r.disconnects_7d,
    };
  });
}

/** Successful storage readings, averaged per 15 minutes, for the given cameras. */
export async function loadHistory(cameraIds: string[], days = HISTORY_DAYS): Promise<Map<string, UsagePoint[]>> {
  const out = new Map<string, UsagePoint[]>(cameraIds.map((id) => [id, []]));
  if (cameraIds.length === 0) return out;
  const { rows } = await pool.query(
    `SELECT camera_id, date_bin($3::interval, checked_at, timestamptz '2000-01-01') AS bucket,
            avg(used_percentage)::float8 AS used_percentage, avg(used_bytes)::float8 AS used_bytes, max(total_bytes) AS total_bytes
     FROM storage_checks
     WHERE camera_id = ANY($1::uuid[]) AND outcome = 'success' AND used_percentage IS NOT NULL
       AND checked_at > now() - make_interval(days => $2)
     GROUP BY camera_id, bucket ORDER BY camera_id, bucket`,
    [cameraIds, days, BUCKET],
  );
  for (const r of rows) {
    out.get(r.camera_id)!.push({
      t: new Date(r.bucket).getTime(),
      usedPercentage: Number(r.used_percentage),
      usedBytes: r.used_bytes === null ? null : Math.round(Number(r.used_bytes)),
      totalBytes: r.total_bytes,
    });
  }
  return out;
}

function analyse(cam: Awaited<ReturnType<typeof loadSnapshots>>[number], points: UsagePoint[], now: number): CameraInsight {
  const forecast = forecastUsage(points, { warningThreshold: cam.warningThreshold, criticalThreshold: cam.criticalThreshold, now });
  const anomalies = cam.monitoringEnabled ? detectAnomalies(cam, points, forecast, now) : [];
  return {
    camera: cam,
    forecast,
    anomalies,
    health: assessHealth(cam, forecast, anomalies),
    actions: recommendActions(cam, forecast, anomalies),
    link: `/cameras/${cam.id}`,
  };
}

let cache: { at: number; value: FleetInsights } | undefined;
let computing: Promise<FleetInsights> | undefined;
/** Cameras whose history is held in memory at once (14 days of 15-minute points each). */
const HISTORY_BATCH = 500;

/**
 * Analysis of every camera. Cached briefly: the data changes at most once per check interval.
 * History is read in batches so memory stays bounded with tens of thousands of cameras, and
 * concurrent callers share one computation.
 */
export async function getFleetInsights(opts: { fresh?: boolean } = {}): Promise<FleetInsights> {
  const start = () =>
    (computing ??= computeFleetInsights().finally(() => {
      computing = undefined;
    }));
  if (!opts.fresh && cache) {
    // Large fleets take a while to analyse: serve the last result and refresh it in the background.
    const maxAge = cache.value.cameras.length > LARGE_FLEET ? LARGE_FLEET_CACHE_MS : CACHE_MS;
    if (Date.now() - cache.at < maxAge) return cache.value;
    if (cache.value.cameras.length > LARGE_FLEET) {
      start().catch(() => undefined);
      return cache.value;
    }
  }
  return start();
}

async function computeFleetInsights(): Promise<FleetInsights> {
  const now = Date.now();
  const cams = await loadSnapshots();
  const cameras: CameraInsight[] = [];
  for (let i = 0; i < cams.length; i += HISTORY_BATCH) {
    const batch = cams.slice(i, i + HISTORY_BATCH);
    const history = await loadHistory(batch.map((c) => c.id));
    for (const c of batch) cameras.push(analyse(c, history.get(c.id) ?? [], now));
  }
  const monitored = cameras.filter((c) => c.camera.monitoringEnabled);
  const scored = monitored.filter((c) => c.health.grade !== "unknown");
  const value: FleetInsights = {
    generatedAt: new Date(now).toISOString(),
    historyDays: HISTORY_DAYS,
    cameras,
    actions: sortActions(cameras.flatMap((c) => c.actions)),
    summary: {
      cameras: cameras.length,
      monitored: monitored.length,
      offline: monitored.filter((c) => c.camera.connection === "offline").length,
      notRecording: monitored.filter((c) => c.camera.recordingState === "idle" || c.camera.recordingState === "error").length,
      storageCritical: monitored.filter((c) => c.camera.storageHealth === "critical").length,
      storageWarning: monitored.filter((c) => c.camera.storageHealth === "warning").length,
      criticalWithin7Days: monitored.filter((c) => c.forecast.daysToCritical !== null && c.forecast.daysToCritical > 0 && c.forecast.daysToCritical <= 7).length,
      anomalies: monitored.reduce((s, c) => s + c.anomalies.length, 0),
      averageHealth: scored.length ? Math.round(scored.reduce((s, c) => s + c.health.score, 0) / scored.length) : null,
    },
  };
  cache = { at: now, value };
  return value;
}

/** Most cameras sent to the browser besides those needing attention (the soonest to critical). */
export const INSIGHTS_FORECAST_LIMIT = 500;
const INSIGHTS_ACTION_LIMIT = 200;

/**
 * What the AI page needs: the INSIGHTS_FORECAST_LIMIT cameras most in need of attention (lowest
 * health, or an anomaly), plus as many monitored cameras closest to critical. With 20 000 cameras the full
 * analysis is tens of megabytes, too much for a browser to download every minute.
 */
export function insightsForClient(ins: FleetInsights): FleetInsights & { camerasShown: number; camerasTotal: number } {
  const needsLook = (c: CameraInsight) => c.anomalies.length > 0 || c.health.grade === "fair" || c.health.grade === "poor";
  const soonest = ins.cameras
    .filter((c) => c.camera.monitoringEnabled && !needsLook(c))
    .sort((a, b) => (a.forecast.daysToCritical ?? Infinity) - (b.forecast.daysToCritical ?? Infinity) || a.camera.name.localeCompare(b.camera.name))
    .slice(0, INSIGHTS_FORECAST_LIMIT);
  const attention = ins.cameras
    .filter(needsLook)
    .sort((a, b) => a.health.score - b.health.score)
    .slice(0, INSIGHTS_FORECAST_LIMIT);
  const cameras = [...attention, ...soonest];
  return { ...ins, cameras, actions: ins.actions.slice(0, INSIGHTS_ACTION_LIMIT), camerasShown: cameras.length, camerasTotal: ins.cameras.length };
}

export function clearInsightsCache() {
  cache = undefined;
  computing = undefined;
}

export interface CameraForecastView extends CameraInsight {
  /** Measured usage (15-minute averages) over the history window. */
  actual: { t: string; usedPercentage: number }[];
  /** Projected usage from the latest measurement, one point per day, while the trend is meaningful. */
  projected: { t: string; usedPercentage: number }[];
}

export async function getCameraForecast(cameraId: string, days = HISTORY_DAYS): Promise<CameraForecastView> {
  const [cam] = await loadSnapshots(cameraId);
  if (!cam) throw notFound("Camera");
  const points = (await loadHistory([cameraId], days)).get(cameraId) ?? [];
  const now = Date.now();
  const insight = analyse(cam, points, now);
  const f = insight.forecast;
  const projected: { t: string; usedPercentage: number }[] = [];
  if (f.current && f.growthPercentPerDay !== null && f.status !== "insufficient_data" && f.projections.length > 0) {
    const horizon = Math.max(...f.projections.map((p) => p.horizonDays));
    for (let d = 0; d <= horizon; d++) {
      const pct = Math.min(100, Math.max(0, f.current.usedPercentage + f.growthPercentPerDay * d));
      projected.push({ t: new Date(f.current.measuredAt + d * 86_400_000).toISOString(), usedPercentage: Math.round(pct * 100) / 100 });
    }
  }
  return {
    ...insight,
    actual: points.map((p) => ({ t: new Date(p.t).toISOString(), usedPercentage: Math.round(p.usedPercentage * 100) / 100 })),
    projected,
  };
}
