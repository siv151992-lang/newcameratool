import { statfsSync } from "node:fs";
import { hostname, platform, release } from "node:os";
import { dirname, resolve } from "node:path";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { brandedEmail, COLORS, detailsTable, esc, pill } from "../notifications/emailLayout.js";
import { mailConfigured, publicLink, sendMail } from "../notifications/mailer.js";
import { appVersion, backupFolder, getBackupSettings, getBackupStatus, listBackupFiles } from "./backupService.js";
import { getEmailSettings } from "./emailSettings.js";
import { getSecuritySettings, purgeEndedSessions } from "./sessionService.js";
import { getMonitoringSettings } from "./settingsService.js";

/**
 * Settings → System health, for the super admin: whether each part of the installation works
 * (database, monitoring worker, disk space, backups, email, live video, dashboard address), each
 * rated ok, warning or problem with what to do. The worker checks it every 15 minutes and emails
 * the system administrators when a part turns into a problem (at most once a day per part).
 */

export type HealthStatus = "ok" | "warn" | "bad" | "info";
export interface HealthItem {
  key: string;
  group: "Server" | "Monitoring" | "Data" | "Delivery";
  label: string;
  status: HealthStatus;
  value: string;
  detail?: string;
}

const RANK: Record<HealthStatus, number> = { info: 0, ok: 0, warn: 1, bad: 2 };
const startedAt = Date.now();

export async function recordWorkerHeartbeat(instance: string) {
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('worker_heartbeat', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ at: new Date().toISOString(), instance })],
  );
}

const ago = (ms: number) => {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};
export const formatBytes = (n: number) => {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
};

function disk(path: string): { free: number; total: number } | null {
  try {
    const s = statfsSync(path);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

async function liveVideoReachable(): Promise<boolean | null> {
  if (!config.LIVE_VIDEO_URL) return null;
  try {
    const r = await fetch(new URL("/api", config.LIVE_VIDEO_URL), { signal: AbortSignal.timeout(3000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

export async function systemHealth(): Promise<{ status: HealthStatus; checkedAt: string; items: HealthItem[] }> {
  const items: HealthItem[] = [];
  const add = (i: HealthItem) => items.push(i);
  const now = Date.now();

  // ---- server and database
  const version = appVersion();
  add({ key: "server", group: "Server", label: "App server", status: "ok", value: `version ${version}`, detail: `${hostname()} · ${platform()} ${release()} · Node ${process.versions.node} · up ${ago(now - startedAt).replace(" ago", "")}` });
  const t0 = Date.now();
  try {
    const db = (await pool.query<{ size: string; version: string; migrations: number }>(
      "SELECT pg_database_size(current_database())::text AS size, current_setting('server_version') AS version, (SELECT count(*)::int FROM schema_migrations) AS migrations",
    )).rows[0]!;
    const ms = Date.now() - t0;
    add({ key: "database", group: "Server", label: "Database", status: ms > 1000 ? "warn" : "ok", value: `PostgreSQL ${db.version} · ${formatBytes(Number(db.size))}`, detail: `Answered in ${ms} ms · ${db.migrations} migrations applied${ms > 1000 ? " · slow: check the server's load and disk" : ""}` });
  } catch (err) {
    add({ key: "database", group: "Server", label: "Database", status: "bad", value: "Not reachable", detail: (err as Error).message.slice(0, 200) });
    return { status: "bad", checkedAt: new Date().toISOString(), items };
  }

  // ---- monitoring worker and checks
  const beat = (await pool.query<{ value: { at: string; instance: string } }>("SELECT value FROM app_settings WHERE key = 'worker_heartbeat'")).rows[0]?.value;
  const beatAge = beat ? now - new Date(beat.at).getTime() : Infinity;
  add({
    key: "worker", group: "Monitoring", label: "Monitoring worker",
    status: beatAge < 3 * 60_000 ? "ok" : beatAge < 15 * 60_000 ? "warn" : "bad",
    value: beat ? `Last seen ${ago(beatAge)}` : "Never seen",
    detail: beatAge < 3 * 60_000 ? `Instance ${beat!.instance}` : "Cameras are not being checked. Restart the app (START.bat, or docker compose up -d worker) and look at the worker log.",
  });
  const m = await getMonitoringSettings();
  const checks = (await pool.query<{ monitored: number; checked_hour: number; overdue: number; last: Date | null }>(
    `SELECT count(*) FILTER (WHERE c.monitoring_enabled)::int AS monitored,
            count(*) FILTER (WHERE c.monitoring_enabled AND s.last_attempt_at > now() - interval '1 hour')::int AS checked_hour,
            count(*) FILTER (WHERE c.monitoring_enabled AND (s.last_attempt_at IS NULL OR s.last_attempt_at < now() - make_interval(secs => $1 * 3)))::int AS overdue,
            max(s.last_attempt_at) AS last
     FROM cameras c LEFT JOIN camera_status s ON s.camera_id = c.id WHERE c.deleted_at IS NULL`,
    [m.pollIntervalSeconds],
  )).rows[0]!;
  const overdueShare = checks.monitored ? checks.overdue / checks.monitored : 0;
  add({
    key: "checks", group: "Monitoring", label: "Camera checks",
    status: !checks.monitored ? "info" : overdueShare > 0.2 ? "bad" : overdueShare > 0 ? "warn" : "ok",
    value: checks.monitored ? `${checks.monitored} cameras monitored · ${checks.overdue} overdue` : "No cameras monitored yet",
    detail: checks.monitored ? `Every ${Math.round(m.pollIntervalSeconds / 60)} min · ${checks.checked_hour} checked in the last hour${checks.last ? ` · last check ${ago(now - new Date(checks.last).getTime())}` : ""}${checks.overdue ? " · overdue: not checked for 3 intervals (worker busy or stopped)" : ""}` : undefined,
  });

  // ---- disk space and backups
  const dataDir = dirname(resolve(config.CREDENTIAL_KEY_FILE));
  const d = disk(dataDir);
  if (d) {
    const freePct = (d.free / d.total) * 100;
    add({ key: "disk", group: "Data", label: "Disk space (data folder)", status: freePct < 5 ? "bad" : freePct < 15 ? "warn" : "ok", value: `${formatBytes(d.free)} free of ${formatBytes(d.total)} (${freePct.toFixed(0)}%)`, detail: `${dataDir}${freePct < 15 ? " · free space soon: delete old files or shorten retention (Settings → Retention)" : ""}` });
  }
  const [bs, bstat] = await Promise.all([getBackupSettings(), getBackupStatus()]);
  const folder = backupFolder(bs);
  const files = listBackupFiles(folder);
  const lastAge = bstat.lastSuccessAt ? now - new Date(bstat.lastSuccessAt).getTime() : Infinity;
  const failedLast = bstat.lastErrorAt && (!bstat.lastSuccessAt || bstat.lastErrorAt > bstat.lastSuccessAt);
  add({
    key: "backup", group: "Data", label: "Backups",
    status: !bs.enabled ? "warn" : failedLast ? "bad" : lastAge > 36 * 3_600_000 ? (lastAge === Infinity ? "warn" : "bad") : "ok",
    value: !bs.enabled ? "Daily backup is off" : bstat.lastSuccessAt ? `Last ${ago(lastAge)} · ${files.length} kept` : "No backup yet",
    detail: failedLast ? `Last attempt failed: ${bstat.lastError}` : `${folder} · ${formatBytes(files.reduce((a, f) => a + f.size, 0))} in total · daily at ${String(bs.hour).padStart(2, "0")}:00 (${bs.timeZone}), kept ${bs.keepDays} days`,
  });
  if (folder !== dataDir && !folder.startsWith(`${dataDir}/`) && !folder.startsWith(`${dataDir}\\`)) {
    const bd = disk(folder);
    if (bd) {
      const pct = (bd.free / bd.total) * 100;
      add({ key: "backup_disk", group: "Data", label: "Disk space (backup folder)", status: pct < 5 ? "bad" : pct < 15 ? "warn" : "ok", value: `${formatBytes(bd.free)} free (${pct.toFixed(0)}%)`, detail: folder });
    }
  }

  // ---- delivery: email, live video, dashboard address, sign-in
  const e = await getEmailSettings();
  add({
    key: "email", group: "Delivery", label: "Email",
    status: e.smtpHost ? "ok" : "warn",
    value: e.smtpHost ? `${e.smtpHost}:${e.smtpPort} as ${e.smtpFrom}` : "Not set up",
    detail: e.smtpHost ? "Send a test from Settings → Email & sign-in to confirm it works." : "Alerts, reports and password resets cannot be emailed. Set it up in Settings → Email & sign-in.",
  });
  const live = await liveVideoReachable();
  add({
    key: "live", group: "Delivery", label: "Live video service",
    status: live === null ? "info" : live ? "ok" : "bad",
    value: live === null ? "Not configured" : live ? "Running" : "Not reachable",
    detail: live === false ? "Live view and playback do not work. Restart the app; in Docker: docker compose up -d go2rtc." : undefined,
  });
  add({
    key: "address", group: "Delivery", label: "Dashboard address",
    status: !e.publicUrl ? "warn" : e.publicUrl.startsWith("https://") ? "ok" : "warn",
    value: e.publicUrl ?? "Not set",
    detail: !e.publicUrl ? "Links in emails cannot be made. It is filled in when an administrator signs in at the dashboard's address." : e.publicUrl.startsWith("https://") ? undefined : "Use https so passwords are not sent in the clear.",
  });
  const sec = await getSecuritySettings();
  await purgeEndedSessions();
  const sessions = (await pool.query<{ n: number; users: number }>("SELECT count(*)::int AS n, count(DISTINCT user_id)::int AS users FROM sessions WHERE expires_at > now()")).rows[0]!;
  add({
    key: "signin", group: "Delivery", label: "Sign-in security",
    status: sec.idleTimeoutMinutes ? "ok" : "warn",
    value: `${sessions.n} active sessions (${sessions.users} people)`,
    detail: sec.idleTimeoutMinutes ? `Signed out after ${sec.idleTimeoutMinutes} min without use` : "Idle sign-out is off: turn it on in Settings → Email & sign-in.",
  });

  const worst = items.reduce<HealthStatus>((w, i) => (RANK[i.status] > RANK[w] ? i.status : w), "ok");
  return { status: worst, checkedAt: new Date().toISOString(), items };
}

/** Worker: emails the system administrators about parts that became a problem (once a day each). */
export async function notifyHealthProblems() {
  const h = await systemHealth();
  const bad = h.items.filter((i) => i.status === "bad");
  if (!bad.length || !(await mailConfigured())) return;
  const { rows } = await pool.query<{ value: Record<string, string> }>("SELECT value FROM app_settings WHERE key = 'health_notified'");
  const sent = rows[0]?.value ?? {};
  const due = bad.filter((i) => !sent[i.key] || Date.now() - new Date(sent[i.key]!).getTime() > 86_400_000);
  if (!due.length) return;
  const admins = (await pool.query<{ email: string }>("SELECT email FROM users WHERE is_system_admin AND is_active AND email IS NOT NULL")).rows.map((r) => r.email);
  if (!admins.length) return;
  const link = await publicLink("/settings/health");
  const html = brandedEmail({
    title: "System health: action needed",
    preheader: due.map((i) => i.label).join(", "),
    body: `<p style="margin:0 0 10px">${pill("PROBLEM", COLORS.bad)}</p>
${due.map((i) => `<p style="margin:12px 0 4px;font-weight:600">${esc(i.label)}: ${esc(i.value)}</p>${i.detail ? `<p style="margin:0;color:${COLORS.muted}">${esc(i.detail)}</p>` : ""}`).join("")}
${detailsTable([["Server", hostname()], ["Checked", new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC"]])}
${link ? `<p><a href="${esc(link)}" style="color:${COLORS.accent}">Open System health</a></p>` : ""}`,
    footer: "Sent by Zoho IBMS CCTV Monitoring to its system administrators.",
  });
  const text = ["System health: action needed", "", ...due.map((i) => `- ${i.label}: ${i.value}${i.detail ? ` (${i.detail})` : ""}`), "", link ? `System health: ${link}` : ""].join("\n");
  for (const to of admins) {
    await sendMail({ to, subject: `[CCTV] System health: ${due.map((i) => i.label).join(", ")}`, text, html }).catch((err) => logger.warn({ err: (err as Error).message }, "Health email failed"));
  }
  for (const i of due) sent[i.key] = new Date().toISOString();
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('health_notified', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(sent)],
  );
}
