import { pool } from "../db/pool.js";
import { toCsv, zonedParts } from "../lib/csv.js";
import { type ListQuery, listFilter, SORT_COLUMNS } from "./cameraService.js";

/**
 * Camera status report: one row per camera with its connection (online/offline) and SD card
 * status, for the cameras matching the camera list's filters, in the list's order.
 */

/** Decimal gigabytes, as the dashboard and card labels show them (a "128 GB" card reads 127.9). */
const GB = 1e9;
const gb = (bytes: number | null) => (bytes === null || bytes === undefined ? "" : (Number(bytes) / GB).toFixed(1));

interface ReportRow {
  name: string;
  host: string;
  port: number;
  brand_name: string;
  model: string | null;
  location: string | null;
  monitoring_enabled: boolean;
  local_storage: boolean;
  connection_status: string | null;
  storage_health: string | null;
  last_attempt_at: Date | null;
  last_success_at: Date | null;
  last_error_message: string | null;
  total_bytes: number | null;
  used_bytes: number | null;
  free_bytes: number | null;
  used_percentage: number | null;
  recording_state: string | null;
  recording_days: number | null;
  recording_oldest: string | null;
  devices: number;
  unhealthy: number;
  degraded: number;
  device_statuses: string | null;
}

const CONNECTION: Record<string, string> = { online: "Online", offline: "Offline", unknown: "Not checked yet" };
const HEALTH: Record<string, string> = { healthy: "Healthy", warning: "Warning", critical: "Critical", unknown: "Unknown" };
const RECORDING: Record<string, string> = { recording: "Recording", idle: "Not recording", error: "Recording error", unknown: "Unknown" };

/** What the report says about a camera's SD card (or other local storage). */
export function sdCardStatus(r: Pick<ReportRow, "local_storage" | "last_success_at" | "devices" | "unhealthy" | "degraded" | "connection_status">): string {
  if (!r.local_storage) return "No local storage (records elsewhere)";
  if (!r.last_success_at) return "Not read yet";
  const status = r.devices === 0 ? "No SD card" : r.unhealthy > 0 ? "Card error" : r.degraded > 0 ? "Card needs attention" : "Card OK";
  return r.connection_status === "offline" ? `${status} (last known; camera offline)` : status;
}

export async function cameraReportCsv(q: ListQuery, timeZone: string): Promise<{ csv: string; rows: number }> {
  zonedParts(Date.now(), timeZone); // validates the zone
  const { clause, params } = listFilter(q);
  const order = `${SORT_COLUMNS[q.sort]} ${q.order === "desc" ? "DESC" : "ASC"} NULLS LAST, c.id`;
  const { rows } = await pool.query<ReportRow>(
    `SELECT c.name, c.host, c.port, b.display_name AS brand_name, c.model, c.location, c.monitoring_enabled, c.local_storage,
            s.connection_status, s.storage_health, s.last_attempt_at, s.last_success_at, s.last_error_message,
            s.total_bytes, s.used_bytes, s.free_bytes, s.used_percentage, s.recording_state,
            s.recording_days, s.recording_oldest,
            coalesce(d.devices, 0)::int AS devices, coalesce(d.unhealthy, 0)::int AS unhealthy, coalesce(d.degraded, 0)::int AS degraded,
            d.device_statuses
     FROM cameras c
     JOIN camera_brands b ON b.key = c.brand_key
     LEFT JOIN camera_status s ON s.camera_id = c.id
     LEFT JOIN LATERAL (
       SELECT count(*) AS devices,
              count(*) FILTER (WHERE health_status = 'unhealthy') AS unhealthy,
              count(*) FILTER (WHERE health_status = 'degraded') AS degraded,
              string_agg(coalesce(name, vendor_id) || ': ' || coalesce(raw_status, health_status), '; ' ORDER BY vendor_id) AS device_statuses
       FROM storage_devices WHERE camera_id = c.id) d ON true
     WHERE ${clause} ORDER BY ${order}`,
    params,
  );
  const time = (d: Date | null) => (d ? zonedParts(new Date(d).getTime(), timeZone).text : "");
  const lines: unknown[][] = [[
    "Camera", "IP address", "Port", "Brand", "Model", "Location", "Monitoring", "Connection", "SD card status",
    "SD card details (from camera)", "Storage health", "Capacity (GB)", "Used (GB)", "Free (GB)", "Used %", "Recording",
    "Recordings available (days)", "Oldest recording (camera time)",
    `Last successful check (${timeZone})`, `Last check attempt (${timeZone})`, "Last error",
  ]];
  for (const r of rows) {
    const monitored = r.monitoring_enabled;
    lines.push([
      r.name, r.host, r.port, r.brand_name, r.model, r.location,
      monitored ? "On" : "Paused",
      monitored ? CONNECTION[r.connection_status ?? "unknown"] ?? r.connection_status : "Paused",
      sdCardStatus(r),
      r.device_statuses,
      r.local_storage ? HEALTH[r.storage_health ?? "unknown"] ?? r.storage_health : "",
      r.local_storage ? gb(r.total_bytes) : "", r.local_storage ? gb(r.used_bytes) : "", r.local_storage ? gb(r.free_bytes) : "",
      r.local_storage && r.used_percentage !== null ? Number(r.used_percentage).toFixed(1) : "",
      r.local_storage ? RECORDING[r.recording_state ?? "unknown"] ?? r.recording_state : "",
      r.local_storage && r.recording_days !== null ? Number(r.recording_days).toFixed(1) : "",
      r.local_storage && r.recording_oldest ? r.recording_oldest.replace("T", " ") : "",
      time(r.last_success_at), time(r.last_attempt_at),
      r.last_error_message, // cleared by the next successful check
    ]);
  }
  return { csv: toCsv(lines), rows: rows.length };
}
