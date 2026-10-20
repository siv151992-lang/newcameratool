import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { pool, type Queryable } from "../db/pool.js";
import { formatBytes } from "../lib/format.js";
import type { CameraInsight, FleetInsights } from "./insightsService.js";

/**
 * The only way the assistant can read data. Each tool is a fixed, parameterised query or a view
 * over the statistical insights; inputs are validated with zod before anything runs, results are
 * plain JSON built from an allow-list of fields (never credentials, keys or request headers), and
 * a tool that needs a permission the signed-in user lacks is not offered at all.
 */

export interface ToolContext {
  permissions: readonly string[];
  /** Loaded once per question, on first use. */
  insights: () => Promise<FleetInsights>;
  now: number;
  /** Database for the fixed queries; the shared pool unless a test supplies one. */
  db?: Queryable;
}

interface ToolDef<S extends z.ZodTypeAny> {
  name: string;
  description: string;
  permission: string;
  schema: S;
  inputSchema: Anthropic.Beta.Messages.BetaTool["input_schema"];
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown>;
}

const define = <S extends z.ZodTypeAny>(def: ToolDef<S>) => def;
const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
const pct = (n: number | null | undefined) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);

/** The facts about one camera that every tool shares. Observed values only. */
function cameraFacts(i: CameraInsight) {
  const c = i.camera;
  return {
    id: c.id,
    name: c.name,
    ip: c.host,
    location: c.location,
    brand: c.brand,
    monitoring: c.monitoringEnabled ? "enabled" : "disabled",
    connection: c.connection,
    recording: c.recordingState,
    storageHealth: c.storageHealth,
    usedPercent: pct(c.usedPercentage),
    freePercent: c.usedPercentage === null ? null : pct(100 - c.usedPercentage),
    total: c.totalBytes === null ? null : formatBytes(c.totalBytes),
    used: c.usedBytes === null ? null : formatBytes(c.usedBytes),
    free: c.freeBytes === null ? null : formatBytes(c.freeBytes),
    lastSuccessfulCheck: iso(c.lastSuccessAt),
    lastError: c.lastErrorCode ? `${c.lastErrorCode}: ${c.lastErrorMessage ?? ""}`.trim() : null,
    openAlerts: c.openAlerts.map((a) => ({ id: a.id, severity: a.severity, title: a.title, link: "/alerts" })),
    healthScore: i.health.grade === "unknown" ? null : i.health.score,
    link: i.link,
  };
}

/** The forecast for one camera, labelled as an estimate. */
function forecastFacts(i: CameraInsight) {
  const f = i.forecast;
  return {
    kind: "estimate",
    status: f.status,
    confidence: f.confidence,
    growthPercentPerDay: f.growthPercentPerDay,
    growthPerDay: f.growthBytesPerDay === null ? null : formatBytes(Math.abs(f.growthBytesPerDay)),
    warningThreshold: i.camera.warningThreshold,
    criticalThreshold: i.camera.criticalThreshold,
    daysToWarning: f.daysToWarning,
    daysToCritical: f.daysToCritical,
    criticalReachedAround: f.criticalAt,
    projections: f.projections,
    basedOn: f.period ? { from: iso(f.period.from), to: iso(f.period.to), measurements: f.period.points } : null,
    notes: f.notes,
  };
}

function findCameras(insights: FleetInsights, query: string): CameraInsight[] {
  const q = query.trim().toLowerCase();
  const exact = insights.cameras.filter((i) => i.camera.id === query || i.camera.host.toLowerCase() === q || i.camera.name.toLowerCase() === q);
  if (exact.length) return exact;
  return insights.cameras.filter((i) => i.camera.name.toLowerCase().includes(q) || (i.camera.location ?? "").toLowerCase().includes(q));
}

const sinceHours = z.number().int().min(1).max(24 * 30);

export const TOOLS = [
  define({
    name: "get_fleet_overview",
    description:
      "Counts of cameras by connection, recording and storage state, the average health score, the cameras that most need attention, and the top recommended actions. Start here for broad questions such as 'what needs attention today'.",
    permission: "cameras:read",
    schema: z.object({}).strict(),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async (_input, ctx) => {
      const ins = await ctx.insights();
      const attention = ins.cameras
        .filter((i) => i.camera.monitoringEnabled && i.health.grade !== "good")
        .sort((a, b) => a.health.score - b.health.score)
        .slice(0, 10)
        .map((i) => ({ ...cameraFacts(i), healthFactors: i.health.factors.map((f) => f.label) }));
      return { generatedAt: ins.generatedAt, summary: ins.summary, needsAttention: attention, topActions: ins.actions.slice(0, 10) };
    },
  }),
  define({
    name: "list_cameras",
    description:
      "Current observed status of cameras, optionally filtered. Use min_used_percent for 'utilization above X%' and max_free_percent for 'less than X% free'. Results include IP address, storage values, last successful check and a link.",
    permission: "cameras:read",
    schema: z
      .object({
        connection: z.enum(["online", "offline", "unknown"]).optional(),
        recording: z.enum(["recording", "idle", "error", "unknown"]).optional(),
        storage_health: z.enum(["healthy", "warning", "critical", "unknown"]).optional(),
        min_used_percent: z.number().min(0).max(100).optional(),
        max_free_percent: z.number().min(0).max(100).optional(),
        location: z.string().max(120).optional(),
        brand: z.string().max(40).optional(),
        search: z.string().max(100).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      })
      .strict(),
    inputSchema: {
      type: "object",
      properties: {
        connection: { type: "string", enum: ["online", "offline", "unknown"] },
        recording: { type: "string", enum: ["recording", "idle", "error", "unknown"], description: "idle means not recording" },
        storage_health: { type: "string", enum: ["healthy", "warning", "critical", "unknown"] },
        min_used_percent: { type: "number", minimum: 0, maximum: 100 },
        max_free_percent: { type: "number", minimum: 0, maximum: 100 },
        location: { type: "string" },
        brand: { type: "string" },
        search: { type: "string", description: "Matches name, IP or location" },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    run: async (input, ctx) => {
      const ins = await ctx.insights();
      const s = input.search?.toLowerCase();
      const matches = ins.cameras.filter((i) => {
        const c = i.camera;
        if (input.connection && (!c.monitoringEnabled || c.connection !== input.connection)) return false;
        if (input.recording && c.recordingState !== input.recording) return false;
        if (input.storage_health && c.storageHealth !== input.storage_health) return false;
        if (input.min_used_percent !== undefined && (c.usedPercentage === null || c.usedPercentage < input.min_used_percent)) return false;
        if (input.max_free_percent !== undefined && (c.usedPercentage === null || 100 - c.usedPercentage > input.max_free_percent)) return false;
        if (input.location && (c.location ?? "").toLowerCase() !== input.location.toLowerCase()) return false;
        if (input.brand && c.brand !== input.brand.toLowerCase()) return false;
        if (s && ![c.name, c.host, c.location ?? ""].some((v) => v.toLowerCase().includes(s))) return false;
        return true;
      });
      return { matched: matches.length, cameras: matches.slice(0, input.limit ?? 100).map(cameraFacts) };
    },
  }),
  define({
    name: "get_camera_details",
    description:
      "Everything known about one camera: observed status, storage, open alerts, forecast, detected anomalies, health score with the reasons, and recommended actions. Pass a name, IP address or id.",
    permission: "cameras:read",
    schema: z.object({ camera: z.string().min(1).max(120) }).strict(),
    inputSchema: {
      type: "object",
      properties: { camera: { type: "string", description: "Camera name, IP address or id" } },
      required: ["camera"],
      additionalProperties: false,
    },
    run: async (input, ctx) => {
      const found = findCameras(await ctx.insights(), input.camera);
      if (found.length === 0) return { found: 0, message: `No camera matches "${input.camera}".` };
      if (found.length > 1) return { found: found.length, candidates: found.slice(0, 20).map((i) => ({ name: i.camera.name, ip: i.camera.host, link: i.link })) };
      const i = found[0]!;
      const { rows } = await (ctx.db ?? pool).query(
        `SELECT occurred_at, from_status, to_status, reason FROM connection_events WHERE camera_id = $1 ORDER BY occurred_at DESC LIMIT 10`,
        [i.camera.id],
      );
      return {
        observed: cameraFacts(i),
        forecast: forecastFacts(i),
        anomalies: i.anomalies,
        health: i.health,
        recommendedActions: i.actions,
        recentConnectionChanges: rows.map((r) => ({ at: new Date(r.occurred_at).toISOString(), from: r.from_status, to: r.to_status, reason: r.reason })),
      };
    },
  }),
  define({
    name: "get_storage_forecasts",
    description:
      "Statistical estimates of which cameras will reach their warning or critical storage threshold within a number of days (linear trend over recent measurements). Cameras already at or above the threshold are included with daysToThreshold 0. Always present these as estimates with their confidence.",
    permission: "cameras:read",
    schema: z.object({ threshold: z.enum(["warning", "critical"]), within_days: z.number().min(0).max(365) }).strict(),
    inputSchema: {
      type: "object",
      properties: {
        threshold: { type: "string", enum: ["warning", "critical"] },
        within_days: { type: "number", minimum: 0, maximum: 365, description: "e.g. 7 for 'next seven days', 30 for 'this month'" },
      },
      required: ["threshold", "within_days"],
      additionalProperties: false,
    },
    run: async (input, ctx) => {
      const ins = await ctx.insights();
      const monitored = ins.cameras.filter((i) => i.camera.monitoringEnabled);
      const days = (i: CameraInsight) => (input.threshold === "warning" ? i.forecast.daysToWarning : i.forecast.daysToCritical);
      const hits = monitored
        .filter((i) => i.forecast.status !== "full_overwriting" && days(i) !== null && days(i)! <= input.within_days)
        .sort((a, b) => days(a)! - days(b)!)
        .map((i) => ({ name: i.camera.name, ip: i.camera.host, link: i.link, usedPercent: pct(i.camera.usedPercentage), daysToThreshold: days(i), forecast: forecastFacts(i) }));
      return {
        threshold: input.threshold,
        withinDays: input.within_days,
        cameras: hits,
        overwritingAtFull: monitored.filter((i) => i.forecast.status === "full_overwriting").map((i) => ({ name: i.camera.name, link: i.link })),
        notEnoughHistory: monitored.filter((i) => i.forecast.status === "insufficient_data").map((i) => ({ name: i.camera.name, link: i.link })),
      };
    },
  }),
  define({
    name: "get_alerts",
    description: "Alerts raised by the threshold-based monitoring, filtered by status, severity, age and camera.",
    permission: "alerts:read",
    schema: z
      .object({
        status: z.enum(["open", "active", "acknowledged", "resolved", "all"]).optional(),
        severity: z.enum(["info", "warning", "critical"]).optional(),
        since_hours: sinceHours.optional(),
        camera: z.string().max(120).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "active", "acknowledged", "resolved", "all"], description: "open = active or acknowledged (default)" },
        severity: { type: "string", enum: ["info", "warning", "critical"] },
        since_hours: { type: "integer", minimum: 1, maximum: 720, description: "Only alerts last seen within this many hours" },
        camera: { type: "string", description: "Camera name or IP" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    run: async (input, ctx) => {
      const db = ctx.db ?? pool;
      const where = ["c.deleted_at IS NULL"];
      const params: unknown[] = [];
      const p = (v: unknown) => `$${params.push(v)}`;
      const status = input.status ?? "open";
      if (status === "open") where.push("a.status <> 'resolved'");
      else if (status !== "all") where.push(`a.status = ${p(status)}`);
      if (input.severity) where.push(`a.severity = ${p(input.severity)}`);
      if (input.since_hours) where.push(`a.last_seen_at > now() - make_interval(hours => ${p(input.since_hours)})`);
      if (input.camera) where.push(`(lower(c.name) LIKE ${p(`%${input.camera.toLowerCase().replace(/[%_\\]/g, (m) => `\\${m}`)}%`)} OR c.host = ${p(input.camera)})`);
      const { rows } = await db.query(
        `SELECT a.id, a.type, a.severity, a.status, a.title, a.description, a.first_detected_at, a.last_seen_at, a.occurrence_count,
                a.resolved_at, c.id AS camera_id, c.name AS camera_name, c.host
         FROM alerts a JOIN cameras c ON c.id = a.camera_id
         WHERE ${where.join(" AND ")}
         ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.last_seen_at DESC
         LIMIT ${p(input.limit ?? 50)}`,
        params,
      );
      return {
        count: rows.length,
        alerts: rows.map((r) => ({
          id: r.id, type: r.type, severity: r.severity, status: r.status, title: r.title, description: r.description,
          firstDetected: new Date(r.first_detected_at).toISOString(), lastSeen: new Date(r.last_seen_at).toISOString(),
          occurrences: r.occurrence_count, resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
          camera: { name: r.camera_name, ip: r.host, link: `/cameras/${r.camera_id}` }, link: "/alerts",
        })),
      };
    },
  }),
  define({
    name: "get_incidents",
    description:
      "What happened in a time window: alerts opened, escalated or resolved, connection changes (offline/online), and failed storage checks per camera. Use for 'summarize incidents from the last 24 hours'.",
    permission: "alerts:read",
    schema: z.object({ since_hours: sinceHours }).strict(),
    inputSchema: {
      type: "object",
      properties: { since_hours: { type: "integer", minimum: 1, maximum: 720 } },
      required: ["since_hours"],
      additionalProperties: false,
    },
    run: async (input, ctx) => {
      const db = ctx.db ?? pool;
      const h = input.since_hours;
      const alertEvents = await db.query(
        `SELECT e.event_type, e.severity, e.message, e.created_at, a.id AS alert_id, a.title, c.id AS camera_id, c.name, c.host
         FROM alert_events e JOIN alerts a ON a.id = e.alert_id JOIN cameras c ON c.id = a.camera_id
         WHERE c.deleted_at IS NULL AND e.created_at > now() - make_interval(hours => $1)
         ORDER BY e.created_at DESC LIMIT 200`,
        [h],
      );
      const connection = await db.query(
        `SELECT e.occurred_at, e.from_status, e.to_status, e.reason, c.id AS camera_id, c.name, c.host
         FROM connection_events e JOIN cameras c ON c.id = e.camera_id
         WHERE c.deleted_at IS NULL AND e.occurred_at > now() - make_interval(hours => $1)
         ORDER BY e.occurred_at DESC LIMIT 200`,
        [h],
      );
      const failures = await db.query(
        `SELECT c.id AS camera_id, c.name, c.host, sc.outcome, count(*)::int AS n, max(sc.checked_at) AS last_at
         FROM storage_checks sc JOIN cameras c ON c.id = sc.camera_id
         WHERE c.deleted_at IS NULL AND sc.outcome <> 'success' AND sc.checked_at > now() - make_interval(hours => $1)
         GROUP BY c.id, c.name, c.host, sc.outcome ORDER BY n DESC LIMIT 100`,
        [h],
      );
      const cam = (r: { camera_id: string; name: string; host: string }) => ({ name: r.name, ip: r.host, link: `/cameras/${r.camera_id}` });
      return {
        windowHours: h,
        alertEvents: alertEvents.rows.map((r) => ({
          at: new Date(r.created_at).toISOString(), event: r.event_type, severity: r.severity, title: r.title, message: r.message,
          camera: cam(r), link: "/alerts",
        })),
        connectionChanges: connection.rows.map((r) => ({ at: new Date(r.occurred_at).toISOString(), from: r.from_status, to: r.to_status, reason: r.reason, camera: cam(r) })),
        failedChecks: failures.rows.map((r) => ({ camera: cam(r), errorCode: r.outcome, count: r.n, lastAt: new Date(r.last_at).toISOString() })),
      };
    },
  }),
  define({
    name: "get_anomalies",
    description:
      "Unusual behaviour detected from storage history and connection events: consumption spikes, sharp usage drops, capacity changes, usage unchanged for 24 hours, repeated disconnections, stale data. Each includes an explanation and the evidence.",
    permission: "cameras:read",
    schema: z
      .object({
        type: z.enum(["usage_spike", "usage_drop", "capacity_changed", "stagnant_usage", "repeated_disconnects", "stale_data"]).optional(),
        min_severity: z.enum(["info", "warning", "critical"]).optional(),
      })
      .strict(),
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["usage_spike", "usage_drop", "capacity_changed", "stagnant_usage", "repeated_disconnects", "stale_data"] },
        min_severity: { type: "string", enum: ["info", "warning", "critical"] },
      },
      additionalProperties: false,
    },
    run: async (input, ctx) => {
      const rank = { info: 0, warning: 1, critical: 2 } as const;
      const min = rank[input.min_severity ?? "info"];
      const ins = await ctx.insights();
      const out = ins.cameras.flatMap((i) =>
        i.anomalies
          .filter((a) => (!input.type || a.type === input.type) && rank[a.severity] >= min)
          .map((a) => ({ camera: { name: i.camera.name, ip: i.camera.host, link: i.link }, ...a })),
      );
      return { count: out.length, anomalies: out, historyDays: ins.historyDays };
    },
  }),
  define({
    name: "compare_storage_usage",
    description: "Side-by-side storage figures for all cameras (or one location): used %, free space, capacity and growth per day, sorted.",
    permission: "cameras:read",
    schema: z
      .object({ sort_by: z.enum(["used_percent", "free", "growth"]).optional(), location: z.string().max(120).optional() })
      .strict(),
    inputSchema: {
      type: "object",
      properties: { sort_by: { type: "string", enum: ["used_percent", "free", "growth"] }, location: { type: "string" } },
      additionalProperties: false,
    },
    run: async (input, ctx) => {
      const ins = await ctx.insights();
      const rows = ins.cameras
        .filter((i) => !input.location || (i.camera.location ?? "").toLowerCase() === input.location.toLowerCase())
        .map((i) => ({
          name: i.camera.name, ip: i.camera.host, location: i.camera.location, link: i.link,
          usedPercent: pct(i.camera.usedPercentage), free: i.camera.freeBytes === null ? null : formatBytes(i.camera.freeBytes),
          freeBytes: i.camera.freeBytes, total: i.camera.totalBytes === null ? null : formatBytes(i.camera.totalBytes),
          growthPercentPerDay: i.forecast.growthPercentPerDay, forecastStatus: i.forecast.status,
        }));
      const key = input.sort_by ?? "used_percent";
      const val = (r: (typeof rows)[number]) => (key === "free" ? -(r.freeBytes ?? Infinity) : key === "growth" ? (r.growthPercentPerDay ?? -Infinity) : (r.usedPercent ?? -1));
      rows.sort((a, b) => val(b) - val(a));
      return { sortedBy: key, cameras: rows.map(({ freeBytes: _f, ...r }) => r) };
    },
  }),
  define({
    name: "get_recommended_actions",
    description: "Prioritised actions derived from status, alerts, forecasts and anomalies, each with the reason.",
    permission: "cameras:read",
    schema: z.object({ priority: z.enum(["critical", "high", "medium", "low"]).optional() }).strict(),
    inputSchema: {
      type: "object",
      properties: { priority: { type: "string", enum: ["critical", "high", "medium", "low"] } },
      additionalProperties: false,
    },
    run: async (input, ctx) => {
      const ins = await ctx.insights();
      const actions = ins.actions.filter((a) => !input.priority || a.priority === input.priority);
      return { count: actions.length, actions: actions.map((a) => ({ ...a, link: `/cameras/${a.cameraId}` })) };
    },
  }),
];

export type ToolName = (typeof TOOLS)[number]["name"];

/** Tool definitions for the API, limited to what the user may see. */
export function toolsFor(permissions: readonly string[]): Anthropic.Beta.Messages.BetaTool[] {
  return TOOLS.filter((t) => permissions.includes(t.permission)).map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
}

/** Validates and runs one tool call. Errors come back as text for the model, never thrown. */
export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<{ content: string; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool || !ctx.permissions.includes(tool.permission)) return { content: `Unknown or unavailable tool "${name}".`, isError: true };
  const parsed = tool.schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return { content: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`, isError: true };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (tool.run as (input: any, ctx: ToolContext) => Promise<unknown>)(parsed.data, ctx);
    return { content: JSON.stringify(result), isError: false };
  } catch {
    return { content: "The data could not be retrieved.", isError: true };
  }
}
