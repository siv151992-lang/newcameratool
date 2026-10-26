import { formatBytes } from "../lib/format.js";
import {
  AUTH_ERROR_CODES,
  NETWORK_ERROR_CODES,
  type CameraErrorCode,
  type NvrChannel,
  type RecordingReading,
  type StorageHealth,
  type StorageReading,
} from "../integrations/types.js";
import type { MonitoringSettings } from "../services/settingsService.js";

export const ALERT_TYPES = [
  "offline",
  "auth_failure",
  "storage_unavailable",
  "storage_usage",
  "disk_unhealthy",
  "disk_readonly",
  "no_storage_device",
  "not_recording",
  "password_change_due",
  "nvr_channel",
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
export type Severity = "info" | "warning" | "critical";

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export interface Thresholds {
  warning: number;
  critical: number;
  full: number;
  hysteresis: number;
  usageAlertsEnabled: boolean;
}

export function thresholdsFor(
  settings: MonitoringSettings,
  camera: { warning_threshold: number | null; critical_threshold: number | null },
): Thresholds {
  const warning = camera.warning_threshold ?? settings.warningThresholdPercent;
  const critical = camera.critical_threshold ?? settings.criticalThresholdPercent;
  return {
    warning,
    critical: Math.max(critical, warning),
    full: Math.max(settings.fullThresholdPercent, critical),
    hysteresis: settings.recoveryHysteresisPercent,
    usageAlertsEnabled: settings.storageUsageAlertsEnabled,
  };
}

const isFull = (r: StorageReading, t: Thresholds) =>
  r.usedPercentage !== undefined && (r.usedPercentage >= t.full || (r.totalBytes! > 0 && r.freeBytes === 0));

/** Overall storage health for a successful reading. */
export function storageHealth(r: StorageReading, t: Thresholds): StorageHealth {
  if (r.devices.length === 0) return "critical";
  if (r.devices.some((d) => d.healthStatus === "unhealthy")) return "critical";
  const usage = t.usageAlertsEnabled ? r.usedPercentage : undefined;
  if (usage !== undefined && (usage >= t.critical || isFull(r, t))) return "critical";
  if (r.devices.some((d) => d.healthStatus === "degraded" || d.writable === false)) return "warning";
  if (usage !== undefined && usage >= t.warning) return "warning";
  if (r.usedPercentage === undefined && r.devices.every((d) => d.healthStatus === "unknown")) return "unknown";
  return "healthy";
}

export interface AlertCondition {
  type: AlertType;
  severity: Severity;
  title: string;
  description: string;
  context: Record<string, unknown>;
}

export type CheckResult =
  | { ok: true; reading: StorageReading }
  | { ok: false; errorCode: CameraErrorCode; errorMessage: string };

export interface EvaluationInput {
  result: CheckResult;
  connectionStatus: "online" | "offline" | "unknown";
  consecutiveFailures: number;
  consecutiveAuthFailures: number;
  /** Recording status read in this check; absent when it was not read (storage failed). */
  recording?: RecordingReading;
  /** Minutes since storage was last read successfully (or since the camera was added). */
  minutesWithoutStorage: number;
  thresholds: Thresholds;
  settings: MonitoringSettings;
  openTypes: ReadonlySet<AlertType>;
  /** False for cameras that record elsewhere: storage and recording alerts do not apply (and are resolved). */
  localStorage?: boolean;
  /** An NVR's channels as read in this check; absent when not an NVR or not read. */
  channels?: NvrChannel[];
}

export interface Evaluation {
  active: AlertCondition[];
  /** Types whose state is known this cycle; open alerts of these types that are not active get resolved. */
  evaluated: AlertType[];
}

/**
 * Decides which alert conditions hold after a check. Pure function: all state comes in as input.
 * Storage conditions are only evaluated after a successful read, so a timeout never resolves
 * (or raises) a disk alert. Disk failure is never inferred from a network error.
 */
export function evaluateConditions(input: EvaluationInput): Evaluation {
  const { result, thresholds: t, settings } = input;
  const active: AlertCondition[] = [];
  const evaluated: AlertType[] = ["offline", "auth_failure"];

  if (input.connectionStatus === "offline") {
    const msg = !result.ok ? result.errorMessage : "Camera unreachable";
    active.push({
      type: "offline",
      severity: "critical",
      title: "Camera offline",
      description: `No response after ${input.consecutiveFailures} consecutive checks. Last error: ${msg}`,
      context: { consecutiveFailures: input.consecutiveFailures, errorCode: !result.ok ? result.errorCode : undefined },
    });
  }

  if (!result.ok && AUTH_ERROR_CODES.has(result.errorCode) && input.consecutiveAuthFailures >= settings.authFailureThreshold) {
    active.push({
      type: "auth_failure",
      severity: "critical",
      title: "Authentication failing",
      description: `${result.errorMessage} (${input.consecutiveAuthFailures} consecutive attempts). Update the camera credentials.`,
      context: { errorCode: result.errorCode, consecutiveAuthFailures: input.consecutiveAuthFailures },
    });
  }

  // NVR channels: cameras the NVR has no video from, or channels not recording. One alert per NVR.
  if (input.channels) {
    evaluated.push("nvr_channel");
    const label = (c: NvrChannel) => `channel ${c.channel}${c.name ? ` (${c.name})` : ""}`;
    const lost = input.channels.filter((c) => c.online === false);
    const notRecording = settings.recordingAlertsEnabled
      ? input.channels.filter((c) => c.online !== false && (c.recording === "idle" || c.recording === "error"))
      : [];
    if (lost.length || notRecording.length) {
      const parts = [
        lost.length ? `No video from ${lost.map(label).join(", ")}.` : "",
        notRecording.length ? `Not recording: ${notRecording.map(label).join(", ")}.` : "",
      ].filter(Boolean);
      active.push({
        type: "nvr_channel",
        severity: lost.length ? "critical" : "warning",
        title: lost.length ? `NVR: ${lost.length} channel${lost.length === 1 ? "" : "s"} without video` : `NVR: ${notRecording.length} channel${notRecording.length === 1 ? "" : "s"} not recording`,
        description: parts.join(" "),
        context: { videoLoss: lost.map((c) => c.channel), notRecording: notRecording.map((c) => c.channel) },
      });
    }
  }

  if (input.localStorage === false) {
    evaluated.push("storage_unavailable", "storage_usage", "disk_unhealthy", "disk_readonly", "no_storage_device", "not_recording");
    return { active, evaluated };
  }

  if (result.ok) {
    evaluated.push("storage_unavailable");
  } else if (!NETWORK_ERROR_CODES.has(result.errorCode) && !AUTH_ERROR_CODES.has(result.errorCode)) {
    evaluated.push("storage_unavailable");
    if (input.minutesWithoutStorage >= settings.storageUnavailableMinutes) {
      active.push({
        type: "storage_unavailable",
        severity: "warning",
        title: "Storage information unavailable",
        description: `Storage status could not be retrieved for ${Math.round(input.minutesWithoutStorage)} minutes: ${result.errorMessage}`,
        context: { errorCode: result.errorCode },
      });
    }
  }

  if (!result.ok) return { active, evaluated };

  const r = result.reading;
  evaluated.push("storage_usage", "disk_unhealthy", "disk_readonly", "no_storage_device");

  if (r.devices.length === 0) {
    active.push({
      type: "no_storage_device",
      severity: "critical",
      title: "No storage device",
      description: "The device reports no SD card, hard disk or other storage device. Recording to local storage is not possible.",
      context: {},
    });
  }

  const unhealthy = r.devices.filter((d) => d.healthStatus === "unhealthy");
  if (unhealthy.length) {
    active.push({
      type: "disk_unhealthy",
      severity: "critical",
      title: "Storage device unhealthy",
      description: unhealthy.map((d) => `${d.name ?? d.id}: camera reports status "${d.rawStatus ?? "unknown"}"`).join("; "),
      context: { devices: unhealthy.map((d) => ({ id: d.id, rawStatus: d.rawStatus })) },
    });
  }

  const readonly = r.devices.filter((d) => d.writable === false);
  if (readonly.length) {
    active.push({
      type: "disk_readonly",
      severity: "warning",
      title: "Storage is read-only",
      description: `${readonly.map((d) => d.name ?? d.id).join(", ")} is mounted read-only; new recordings cannot be written.`,
      context: { devices: readonly.map((d) => d.id) },
    });
  }

  if (t.usageAlertsEnabled && r.usedPercentage !== undefined) {
    const usage = r.usedPercentage;
    const open = input.openTypes.has("storage_usage");
    const full = isFull(r, t);
    const detail = `${usage}% used (${formatBytes(r.usedBytes)} of ${formatBytes(r.totalBytes)}, ${formatBytes(r.freeBytes)} free)`;
    if (full) {
      active.push({ type: "storage_usage", severity: "critical", title: "Storage full", description: `Storage is full: ${detail}`, context: { usage, level: "full" } });
    } else if (usage >= t.critical) {
      active.push({ type: "storage_usage", severity: "critical", title: "Storage critical", description: `Usage above ${t.critical}%: ${detail}`, context: { usage, level: "critical" } });
    } else if (usage >= t.warning || (open && usage >= t.warning - t.hysteresis)) {
      // Hysteresis: an open alert stays open until usage drops clearly below the warning level.
      active.push({ type: "storage_usage", severity: "warning", title: "Storage usage high", description: `Usage above ${t.warning}%: ${detail}`, context: { usage, level: "warning" } });
    }
  }

  // An unknown recording state (unsupported brand, failed read) neither raises nor resolves the alert.
  const rec = input.recording;
  if (rec && rec.state !== "unknown") {
    evaluated.push("not_recording");
    const reported = rec.detail ? ` Camera reports ${rec.detail}.` : "";
    if (settings.recordingAlertsEnabled && rec.state === "error") {
      active.push({ type: "not_recording", severity: "critical", title: "Recording error", description: `The camera reports a recording error.${reported}`, context: { state: rec.state } });
    } else if (settings.recordingAlertsEnabled && rec.state === "idle") {
      active.push({ type: "not_recording", severity: "warning", title: "Camera not recording", description: `The camera is not recording right now.${reported}`, context: { state: rec.state } });
    }
  }

  return { active, evaluated };
}

const DAY_MS = 86_400_000;

/**
 * The camera password's age against the policy: a reminder (info) `reminderDays` before it is due,
 * a warning once it is due. Null when no change is due soon or the policy asks for none.
 */
export function passwordAgeCondition(input: { changedAt: Date | null; maxAgeDays: number; reminderDays: number; alertsEnabled: boolean; now?: number }): AlertCondition | null {
  const { changedAt, maxAgeDays, reminderDays, alertsEnabled } = input;
  if (!alertsEnabled || !changedAt || maxAgeDays <= 0) return null;
  const age = Math.floor(((input.now ?? Date.now()) - changedAt.getTime()) / DAY_MS);
  const left = maxAgeDays - age;
  const how = "Change it on the camera, then enter the new password in the app under Edit.";
  if (left <= 0) {
    return {
      type: "password_change_due", severity: "warning", title: "Camera password change due",
      description: `The camera password was last changed ${age} days ago; the policy asks for a new one every ${maxAgeDays} days. ${how}`,
      context: { ageDays: age, maxAgeDays },
    };
  }
  if (left <= reminderDays) {
    return {
      type: "password_change_due", severity: "info", title: "Camera password change due soon",
      description: `The camera password must be changed within ${left} day${left === 1 ? "" : "s"} (every ${maxAgeDays} days by policy). ${how}`,
      context: { ageDays: age, maxAgeDays, daysLeft: left },
    };
  }
  return null;
}

/** A problem on a camera in a critical area is critical, whatever its usual severity. */
export function raiseForCriticalArea(c: AlertCondition): AlertCondition {
  if (c.severity === "critical") return c;
  return { ...c, severity: "critical", context: { ...c.context, criticalArea: true } };
}
