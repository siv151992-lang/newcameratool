import { parseArgs } from "node:util";
import { pool } from "../db/pool.js";
import { registry } from "../integrations/registry.js";
import { formatBytes } from "../lib/format.js";
import { mapWithConcurrency } from "../lib/concurrency.js";
import { runCheck } from "../monitoring/checkService.js";
import { getMonitoringSettings } from "../services/settingsService.js";

/**
 * Prints the status of every registered camera as a table.
 *   npm run status                 last known status (does not contact cameras)
 *   npm run status -- --check      check every monitored camera now, then print
 *   npm run status -- --json       machine-readable output
 */

interface Row {
  name: string;
  host: string;
  port: number;
  location: string | null;
  monitoring_enabled: boolean;
  connection_status: string;
  storage_health: string;
  recording_state: string;
  total_bytes: number | null;
  used_bytes: number | null;
  free_bytes: number | null;
  used_percentage: number | null;
  last_success_at: Date | null;
  last_error_code: string | null;
  last_error_message: string | null;
}

function ago(d: Date | null): string {
  if (!d) return "never";
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function table(headers: string[], rows: string[][]) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
  console.log(line(headers));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
}

async function main() {
  const { values } = parseArgs({ options: { check: { type: "boolean", default: false }, json: { type: "boolean", default: false } } });

  if (values.check) {
    const settings = await getMonitoringSettings();
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM cameras WHERE deleted_at IS NULL AND monitoring_enabled ORDER BY name",
    );
    if (!values.json) console.log(`Checking ${rows.length} camera(s)...`);
    // Notifications are sent by the worker; a status check from the terminal only records results.
    await mapWithConcurrency(rows, settings.concurrency, (r) =>
      runCheck(r.id, "manual", { registry, notifier: { dispatch: async () => undefined } }),
    );
  }

  const { rows } = await pool.query<Row>(
    `SELECT c.name, c.host, c.port, c.location, c.monitoring_enabled,
            s.connection_status, s.storage_health, s.recording_state, s.total_bytes, s.used_bytes, s.free_bytes, s.used_percentage,
            s.last_success_at, s.last_error_code, s.last_error_message
     FROM cameras c JOIN camera_status s ON s.camera_id = c.id
     WHERE c.deleted_at IS NULL ORDER BY lower(c.name)`,
  );

  if (values.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("No cameras registered.");
    return;
  }

  table(
    ["CAMERA", "ADDRESS", "LOCATION", "STATUS", "STORAGE", "RECORDING", "USED", "FREE", "TOTAL", "LAST OK", "LAST ERROR"],
    rows.map((r) => [
      r.name,
      `${r.host}:${r.port}`,
      r.location ?? "-",
      r.monitoring_enabled ? r.connection_status.toUpperCase() : "DISABLED",
      r.storage_health.toUpperCase(),
      r.recording_state === "idle" ? "NOT RECORDING" : r.recording_state.toUpperCase(),
      r.used_percentage === null ? "-" : `${r.used_percentage.toFixed(1)}%`,
      r.free_bytes === null ? "-" : formatBytes(r.free_bytes),
      r.total_bytes === null ? "-" : formatBytes(r.total_bytes),
      ago(r.last_success_at),
      r.last_error_code ? `${r.last_error_code}: ${r.last_error_message ?? ""}`.slice(0, 70) : "-",
    ]),
  );

  const count = (f: (r: Row) => boolean) => rows.filter(f).length;
  console.log(
    `\n${rows.length} cameras: ${count((r) => r.monitoring_enabled && r.connection_status === "online")} online, ` +
      `${count((r) => r.monitoring_enabled && r.connection_status === "offline")} offline, ` +
      `${count((r) => r.monitoring_enabled && r.connection_status === "unknown")} unknown, ` +
      `${count((r) => !r.monitoring_enabled)} disabled; ` +
      `${count((r) => r.storage_health === "warning")} storage warning, ${count((r) => r.storage_health === "critical")} critical; ` +
      `${count((r) => r.monitoring_enabled && (r.recording_state === "idle" || r.recording_state === "error"))} not recording`,
  );
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
