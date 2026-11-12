import { z } from "zod";
import { pool } from "../db/pool.js";
import { zonedParts } from "../lib/csv.js";
import { badRequest } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { publicLink, sendMail } from "../notifications/mailer.js";
import { cameraReportCsv } from "./cameraReportService.js";
import { listQuerySchema } from "./cameraService.js";
import { getMonitoringSettings } from "./settingsService.js";
import { uptimeReport } from "./uptimeService.js";

/**
 * The weekly email report: per camera, how many days of recordings it holds, and every open
 * problem, with the week's outages. It goes to the organization's email alert addresses
 * (Settings → Notifications), on the day and hour chosen there, with the full camera list as CSV.
 */

export const weeklyReportSettingsSchema = z
  .object({
    enabled: z.boolean(),
    /** 0 = Sunday … 6 = Saturday. */
    day: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    timeZone: z.string().trim().min(1).max(64),
  })
  .strict();
export type WeeklyReportSettings = z.infer<typeof weeklyReportSettingsSchema>;

const SERVER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const DEFAULTS: WeeklyReportSettings = { enabled: true, day: 1, hour: 9, timeZone: SERVER_ZONE };
const KEY = "weekly_report";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export async function getWeeklyReportSettings(orgId: string): Promise<WeeklyReportSettings & { recipients: string[]; lastSent: string | null }> {
  const { rows } = await pool.query<{ value: Partial<WeeklyReportSettings> & { lastSent?: string } }>(
    "SELECT value FROM organization_settings WHERE organization_id = $1 AND key = $2",
    [orgId, KEY],
  );
  const { lastSent, ...stored } = rows[0]?.value ?? {};
  const parsed = weeklyReportSettingsSchema.safeParse({ ...DEFAULTS, ...stored });
  return { ...(parsed.success ? parsed.data : DEFAULTS), recipients: await reportRecipients(orgId), lastSent: lastSent ?? null };
}

export async function updateWeeklyReportSettings(orgId: string, patch: Partial<WeeklyReportSettings>, userId: string | null) {
  const current = await getWeeklyReportSettings(orgId);
  const next = weeklyReportSettingsSchema.parse({ enabled: current.enabled, day: current.day, hour: current.hour, timeZone: current.timeZone, ...patch });
  zonedParts(Date.now(), next.timeZone); // rejects an unknown time zone
  await pool.query(
    `INSERT INTO organization_settings (organization_id, key, value, updated_by) VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, key) DO UPDATE
       SET value = EXCLUDED.value || jsonb_build_object('lastSent', organization_settings.value->'lastSent'),
           updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [orgId, KEY, JSON.stringify(next), userId],
  );
  return getWeeklyReportSettings(orgId);
}

/** Every address of the organization's enabled email alert channels. */
export async function reportRecipients(orgId: string): Promise<string[]> {
  const { rows } = await pool.query<{ config: { recipients?: string[] } }>(
    "SELECT config FROM notification_channels WHERE organization_id = $1 AND type = 'email' AND enabled",
    [orgId],
  );
  return [...new Set(rows.flatMap((r) => r.config.recipients ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean))];
}

// ----------------------------------------------------------------------------------- the report

interface CameraRow {
  id: string;
  name: string;
  host: string;
  location: string | null;
  local_storage: boolean;
  connection_status: string | null;
  recording_state: string | null;
  recording_days: string | null;
  recording_days_at_least: boolean | null;
  used_percentage: string | null;
  devices: number;
  unhealthy: number;
  last_success_at: Date | null;
}

export interface WeeklyReport {
  subject: string;
  text: string;
  html: string;
  csv: string;
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const days = (r: CameraRow) => (r.recording_days === null ? null : Number(r.recording_days));
const daysText = (r: CameraRow) => {
  const d = days(r);
  return d === null ? "unknown" : `${r.recording_days_at_least ? "at least " : ""}${d.toFixed(1)} days`;
};
/** Longest list in the email; the attached CSV has every camera. */
const LIST_LIMIT = 200;

export async function buildWeeklyReport(orgId: string, timeZone: string, now = new Date()): Promise<WeeklyReport> {
  const [{ rows: org }, { rows: cameras }, { rows: alerts }, settings, uptime] = await Promise.all([
    pool.query<{ name: string }>("SELECT name FROM organizations WHERE id = $1", [orgId]),
    pool.query<CameraRow>(
      `SELECT c.id, c.name, c.host, c.location, c.local_storage,
              s.connection_status, s.recording_state, s.recording_days, s.recording_days_at_least, s.used_percentage, s.last_success_at,
              coalesce(d.devices, 0)::int AS devices, coalesce(d.unhealthy, 0)::int AS unhealthy
       FROM cameras c
       LEFT JOIN camera_status s ON s.camera_id = c.id
       LEFT JOIN LATERAL (SELECT count(*) AS devices, count(*) FILTER (WHERE health_status = 'unhealthy') AS unhealthy
                          FROM storage_devices WHERE camera_id = c.id) d ON true
       WHERE c.organization_id = $1 AND c.deleted_at IS NULL AND c.monitoring_enabled
       ORDER BY lower(c.name)`,
      [orgId],
    ),
    pool.query<{ title: string; severity: string; name: string; host: string; since: Date }>(
      `SELECT a.title, a.severity, c.name, c.host, a.first_detected_at AS since
       FROM alerts a JOIN cameras c ON c.id = a.camera_id
       WHERE c.organization_id = $1 AND c.deleted_at IS NULL AND a.status <> 'resolved'
       ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, a.title, lower(c.name)`,
      [orgId],
    ),
    getMonitoringSettings(orgId),
    uptimeReport(orgId, 7),
  ]);
  const orgName = org[0]?.name ?? "CCTV";
  const minDays = settings.minRecordingDays;
  const date = zonedParts(now.getTime(), timeZone).text.slice(0, 10);

  // ---- summary
  const withStorage = cameras.filter((c) => c.local_storage);
  const read = withStorage.filter((c) => c.last_success_at);
  const known = read.filter((c) => days(c) !== null);
  const offline = cameras.filter((c) => c.connection_status === "offline");
  const notRecording = read.filter((c) => c.recording_state === "idle" || c.recording_state === "error");
  const sdProblem = read.filter((c) => c.devices === 0 || c.unhealthy > 0);
  const below = minDays > 0 ? known.filter((c) => days(c)! < minDays) : [];
  const sortedDays = [...known].sort((a, b) => days(a)! - days(b)!);
  const fewest = sortedDays[0];
  const average = known.length ? known.reduce((t, c) => t + days(c)!, 0) / known.length : null;

  const summary: [string, string | number, boolean][] = [
    ["Cameras monitored", cameras.length, false],
    ["Online", cameras.length - offline.length, false],
    ["Offline", offline.length, offline.length > 0],
    ["Not recording", notRecording.length, notRecording.length > 0],
    ["SD card missing or in error", sdProblem.length, sdProblem.length > 0],
    ...(minDays > 0 ? [[`Fewer than ${minDays} days of recordings`, below.length, below.length > 0] as [string, number, boolean]] : []),
    ["Average days of recordings", average === null ? "—" : average.toFixed(1), false],
    ["Fewest days of recordings", fewest ? `${daysText(fewest)} (${fewest.name})` : "—", false],
    ["Open alerts", alerts.length, alerts.length > 0],
    ["Uptime last 7 days", uptime.overall.uptime === null ? "—" : `${uptime.overall.uptime.toFixed(1)}%`, false],
  ];

  // ---- issues, grouped by alert title
  const groups = new Map<string, { severity: string; cameras: string[] }>();
  for (const a of alerts) {
    const g = groups.get(a.title) ?? { severity: a.severity, cameras: [] };
    g.cameras.push(`${a.name} (${a.host})`);
    groups.set(a.title, g);
  }
  const outages = uptime.cameras.filter((c) => c.outages > 0).slice(0, 20);

  // ---- recordings per camera: fewest days first, unknown at the end
  const recordingRows = [...sortedDays, ...withStorage.filter((c) => !known.includes(c))].slice(0, LIST_LIMIT);
  const status = (c: CameraRow) =>
    !c.last_success_at ? "Not read yet"
    : c.connection_status === "offline" ? "Offline"
    : c.devices === 0 ? "No SD card"
    : c.unhealthy > 0 ? "SD card error"
    : c.recording_state === "idle" ? "Not recording"
    : c.recording_state === "error" ? "Recording error"
    : minDays > 0 && days(c) !== null && days(c)! < minDays ? `Below ${minDays} days`
    : "OK";

  const link = (await publicLink("/cameras")) ?? "";
  const subject = `${orgName} — weekly CCTV report ${date}: ${alerts.length ? `${alerts.length} open issue${alerts.length === 1 ? "" : "s"}` : "no open issues"}`;

  // ---- text
  const text: string[] = [`Weekly CCTV report — ${orgName} — ${date}`, ""];
  for (const [k, v] of summary) text.push(`${k}: ${v}`);
  text.push("", "OPEN ISSUES");
  if (!groups.size) text.push("None.");
  for (const [title, g] of groups) text.push(`- ${title} (${g.severity}, ${g.cameras.length}): ${g.cameras.join(", ")}`);
  text.push("", "DAYS OF RECORDINGS PER CAMERA (fewest first)");
  for (const c of recordingRows) text.push(`- ${c.name} (${c.host}): ${daysText(c)}${c.used_percentage === null ? "" : `, card ${Number(c.used_percentage).toFixed(0)}% used`} — ${status(c)}`);
  if (withStorage.length > LIST_LIMIT) text.push(`…and ${withStorage.length - LIST_LIMIT} more (see the attached CSV).`);
  if (outages.length) {
    text.push("", "OUTAGES IN THE LAST 7 DAYS");
    for (const c of outages) text.push(`- ${c.name}: ${c.outages} time${c.outages === 1 ? "" : "s"} offline, uptime ${c.uptime === null ? "—" : c.uptime.toFixed(1)}%`);
  }
  text.push("", link ? `Dashboard: ${link}` : "", "The attached CSV lists every camera.");

  // ---- html
  const td = "padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top";
  const th = `${td};background:#f3f4f6;font-weight:600`;
  const red = "color:#b91c1c;font-weight:600";
  const html = `<!doctype html><html><body style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#111827;margin:0;padding:16px">
<h2 style="margin:0 0 4px;color:#0b4a8b">Weekly CCTV report — ${esc(orgName)}</h2>
<p style="margin:0 0 16px;color:#6b7280">${esc(date)} · ${esc(timeZone)}</p>
<table style="border-collapse:collapse;margin-bottom:20px">${summary
    .map(([k, v, bad]) => `<tr><td style="${td}">${esc(k)}</td><td style="${td};${bad ? red : "font-weight:600"}">${esc(v)}</td></tr>`)
    .join("")}</table>
<h3 style="margin:0 0 8px">Open issues</h3>
${groups.size
    ? `<table style="border-collapse:collapse;margin-bottom:20px;width:100%"><tr><th style="${th}">Issue</th><th style="${th}">Cameras</th></tr>${[...groups]
        .map(([title, g]) => `<tr><td style="${td};${g.severity === "critical" ? red : ""}">${esc(title)} (${g.cameras.length})</td><td style="${td}">${esc(g.cameras.join(", "))}</td></tr>`)
        .join("")}</table>`
    : `<p style="margin:0 0 20px">None.</p>`}
<h3 style="margin:0 0 8px">Days of recordings per camera (fewest first)</h3>
<table style="border-collapse:collapse;margin-bottom:8px;width:100%"><tr><th style="${th}">Camera</th><th style="${th}">IP</th><th style="${th}">Location</th><th style="${th}">Recordings</th><th style="${th}">SD card used</th><th style="${th}">Status</th></tr>${recordingRows
    .map((c) => {
      const st = status(c);
      return `<tr><td style="${td}">${esc(c.name)}</td><td style="${td}">${esc(c.host)}</td><td style="${td}">${esc(c.location ?? "")}</td><td style="${td}">${esc(daysText(c))}</td><td style="${td}">${c.used_percentage === null ? "—" : `${Number(c.used_percentage).toFixed(0)}%`}</td><td style="${td};${st === "OK" ? "color:#15803d" : red}">${esc(st)}</td></tr>`;
    })
    .join("")}</table>
${withStorage.length > LIST_LIMIT ? `<p style="color:#6b7280">…and ${withStorage.length - LIST_LIMIT} more (see the attached CSV).</p>` : ""}
${outages.length
    ? `<h3 style="margin:20px 0 8px">Outages in the last 7 days</h3><table style="border-collapse:collapse;width:100%"><tr><th style="${th}">Camera</th><th style="${th}">Times offline</th><th style="${th}">Uptime</th></tr>${outages
        .map((c) => `<tr><td style="${td}">${esc(c.name)}</td><td style="${td}">${c.outages}</td><td style="${td}">${c.uptime === null ? "—" : c.uptime.toFixed(1)}%</td></tr>`)
        .join("")}</table>`
    : ""}
<p style="margin-top:20px;color:#6b7280">${link ? `<a href="${esc(link)}">Open the dashboard</a> · ` : ""}The attached CSV lists every camera.</p>
</body></html>`;

  const { csv } = await cameraReportCsv(orgId, listQuerySchema.parse({}), timeZone);
  return { subject, text: text.join("\n"), html, csv };
}

/** Builds the report and emails it to every email alert address. */
export async function sendWeeklyReport(orgId: string): Promise<{ sentTo: string[]; failed: { to: string; error: string }[] }> {
  const settings = await getWeeklyReportSettings(orgId);
  if (!settings.recipients.length) throw badRequest("No email addresses to send to: add one under Email alerts on this page.");
  const report = await buildWeeklyReport(orgId, settings.timeZone);
  const date = zonedParts(Date.now(), settings.timeZone).text.slice(0, 10);
  const sentTo: string[] = [];
  const failed: { to: string; error: string }[] = [];
  for (const to of settings.recipients) {
    try {
      await sendMail({
        to,
        subject: report.subject,
        text: report.text,
        html: report.html,
        attachments: [{ filename: `cctv-cameras-${date}.csv`, content: report.csv, contentType: "text/csv; charset=utf-8" }],
      });
      sentTo.push(to);
    } catch (err) {
      failed.push({ to, error: (err as Error).message.slice(0, 300) });
    }
  }
  return { sentTo, failed };
}

/** Whether `now` falls on the chosen day, at or after the chosen hour, in the report's time zone. */
export function reportDue(s: Pick<WeeklyReportSettings, "day" | "hour" | "timeZone">, lastSent: string | null, now: Date): string | null {
  const local = zonedParts(now.getTime(), s.timeZone);
  const today = local.text.slice(0, 10);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const hour = Number(local.text.slice(11, 13));
  if (weekday !== s.day || hour < s.hour || lastSent === today) return null;
  return today;
}

/** Called by the worker every few minutes: sends each organization's report once on its day. */
export async function sendDueWeeklyReports(now = new Date()): Promise<void> {
  const { rows: orgs } = await pool.query<{ id: string }>("SELECT id FROM organizations WHERE is_active");
  for (const { id } of orgs) {
    try {
      const s = await getWeeklyReportSettings(id);
      if (!s.enabled || !s.recipients.length) continue;
      const today = reportDue(s, s.lastSent, now);
      if (!today) continue;
      // Claim this day first, so two workers never both send it.
      const claimed = await pool.query(
        `INSERT INTO organization_settings (organization_id, key, value) VALUES ($1, $2, jsonb_build_object('lastSent', $3::text))
         ON CONFLICT (organization_id, key) DO UPDATE SET value = organization_settings.value || jsonb_build_object('lastSent', $3::text)
         WHERE coalesce(organization_settings.value->>'lastSent', '') <> $3
         RETURNING 1`,
        [id, KEY, today],
      );
      if (!claimed.rowCount) continue;
      const r = await sendWeeklyReport(id);
      logger.info({ organization: id, sent: r.sentTo.length, failed: r.failed.length }, "Weekly report sent");
    } catch (err) {
      logger.warn({ organization: id, err: (err as Error).message }, "Weekly report could not be sent");
    }
  }
}

export const describeSchedule = (s: WeeklyReportSettings) => `every ${DAYS[s.day]} at ${String(s.hour).padStart(2, "0")}:00 (${s.timeZone})`;
