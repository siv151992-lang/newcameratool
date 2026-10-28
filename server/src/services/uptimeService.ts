import { pool } from "../db/pool.js";

/**
 * Uptime over a period, from the online/offline changes the checks record (connection_events): for
 * each camera, the share of the observed time it was online. Time before a camera was first checked
 * ("unknown") is not counted. A camera with no change in the period kept its current status all along.
 */
export interface UptimeRow {
  id: string;
  name: string;
  location: string | null;
  /** 0–100, or null when the camera was not observed in the period. */
  uptime: number | null;
  onlineSeconds: number;
  observedSeconds: number;
  /** Times it went offline in the period, and the longest time offline (seconds). */
  outages: number;
  longestOutageSeconds: number;
}

export interface UptimeReport {
  from: string;
  to: string;
  days: number;
  overall: { uptime: number | null; cameras: number; below99: number; outages: number; downtimeSeconds: number };
  locations: { location: string | null; cameras: number; uptime: number | null; outages: number; downtimeSeconds: number }[];
  /** All cameras, lowest uptime first. */
  cameras: UptimeRow[];
}

const pct = (online: number, observed: number) => (observed > 0 ? Math.round((online / observed) * 100_000) / 1000 : null);

export async function uptimeReport(orgId: string, days: number): Promise<UptimeReport> {
  const { rows } = await pool.query<{
    id: string; name: string; location: string | null; online_s: number | null; observed_s: number | null; outages: number; longest_s: number | null; from_at: Date; to_at: Date;
  }>(
    `WITH bounds AS (SELECT now() - make_interval(days => $2) AS from_at, now() AS to_at),
     cams AS (
       SELECT c.id, c.name, c.location, greatest(c.created_at, b.from_at) AS start_at, s.connection_status
       FROM cameras c JOIN camera_status s ON s.camera_id = c.id, bounds b
       WHERE c.organization_id = $1 AND c.deleted_at IS NULL AND c.monitoring_enabled
     ),
     ev AS (
       SELECT e.camera_id, e.occurred_at, e.from_status, e.to_status,
              lead(e.occurred_at) OVER w AS next_at, row_number() OVER w AS rn
       FROM connection_events e JOIN cams ON cams.id = e.camera_id
       WHERE e.occurred_at > cams.start_at
       WINDOW w AS (PARTITION BY e.camera_id ORDER BY e.occurred_at, e.id)
     ),
     -- Per camera: its changes in the period (one pass; a lookup per camera would scan them all each time).
     changes AS (SELECT camera_id, count(*) FILTER (WHERE to_status = 'offline')::int AS outages FROM ev GROUP BY camera_id),
     segs AS (
       -- After each change, until the next one (or now).
       SELECT ev.camera_id, ev.to_status AS state, ev.occurred_at AS a, coalesce(ev.next_at, b.to_at) AS b FROM ev, bounds b
       UNION ALL
       -- Before the first change in the period: the status it changed from.
       SELECT ev.camera_id, ev.from_status, cams.start_at, ev.occurred_at FROM ev JOIN cams ON cams.id = ev.camera_id WHERE ev.rn = 1
       UNION ALL
       -- No change in the period: its status now, all along.
       SELECT cams.id, cams.connection_status, cams.start_at, b.to_at FROM cams LEFT JOIN changes ch ON ch.camera_id = cams.id, bounds b
       WHERE ch.camera_id IS NULL
     ),
     per AS (
       SELECT camera_id,
              sum(extract(epoch FROM b - a)) FILTER (WHERE state = 'online') AS online_s,
              sum(extract(epoch FROM b - a)) FILTER (WHERE state IN ('online', 'offline')) AS observed_s,
              max(extract(epoch FROM b - a)) FILTER (WHERE state = 'offline') AS longest_s
       FROM segs WHERE b > a GROUP BY camera_id
     )
     SELECT cams.id, cams.name, cams.location, per.online_s::float8 AS online_s, per.observed_s::float8 AS observed_s,
            coalesce(ch.outages, 0) AS outages,
            per.longest_s::float8 AS longest_s, b.from_at, b.to_at
     FROM cams LEFT JOIN per ON per.camera_id = cams.id LEFT JOIN changes ch ON ch.camera_id = cams.id, bounds b`,
    [orgId, days],
  );

  const cameras: UptimeRow[] = rows.map((r) => {
    const online = Math.round(r.online_s ?? 0);
    const observed = Math.round(r.observed_s ?? 0);
    return {
      id: r.id, name: r.name, location: r.location, uptime: pct(online, observed), onlineSeconds: online, observedSeconds: observed,
      outages: r.outages, longestOutageSeconds: Math.round(r.longest_s ?? 0),
    };
  });
  // Lowest uptime first; cameras not observed at the end.
  cameras.sort((a, b) => (a.uptime ?? 101) - (b.uptime ?? 101) || b.outages - a.outages || a.name.localeCompare(b.name));

  const byLocation = new Map<string | null, { cameras: number; online: number; observed: number; outages: number }>();
  let online = 0;
  let observed = 0;
  let outages = 0;
  for (const c of cameras) {
    const l = byLocation.get(c.location) ?? { cameras: 0, online: 0, observed: 0, outages: 0 };
    l.cameras += 1;
    l.online += c.onlineSeconds;
    l.observed += c.observedSeconds;
    l.outages += c.outages;
    byLocation.set(c.location, l);
    online += c.onlineSeconds;
    observed += c.observedSeconds;
    outages += c.outages;
  }
  const locations = [...byLocation.entries()]
    .map(([location, l]) => ({ location, cameras: l.cameras, uptime: pct(l.online, l.observed), outages: l.outages, downtimeSeconds: l.observed - l.online }))
    .sort((a, b) => (a.uptime ?? 101) - (b.uptime ?? 101) || (a.location ?? "").localeCompare(b.location ?? ""));

  return {
    from: (rows[0]?.from_at ?? new Date(Date.now() - days * 86_400_000)).toISOString(),
    to: (rows[0]?.to_at ?? new Date()).toISOString(),
    days,
    overall: {
      uptime: pct(online, observed),
      cameras: cameras.length,
      below99: cameras.filter((c) => c.uptime !== null && c.uptime < 99).length,
      outages,
      downtimeSeconds: observed - online,
    },
    locations,
    cameras,
  };
}

const csvCell = (v: string | number | null) => {
  const s = v === null ? "" : String(v);
  // Quote when needed; neutralise spreadsheet formulas (=, +, -, @ at the start).
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The report as CSV: one row per camera. */
export function uptimeCsv(r: UptimeReport): string {
  const head = ["Camera", "Location", "Uptime %", "Online (hours)", "Observed (hours)", "Downtime (minutes)", "Outages", "Longest outage (minutes)"];
  const lines = r.cameras.map((c) => [
    c.name, c.location, c.uptime, (c.onlineSeconds / 3600).toFixed(2), (c.observedSeconds / 3600).toFixed(2),
    Math.round((c.observedSeconds - c.onlineSeconds) / 60), c.outages, Math.round(c.longestOutageSeconds / 60),
  ].map(csvCell).join(","));
  return `﻿${[head.join(","), ...lines].join("\r\n")}\r\n`;
}
