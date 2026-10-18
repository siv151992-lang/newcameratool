import { formatBytes } from "../lib/format.js";
import {
  AUTH_ERROR_CODES,
  NETWORK_ERROR_CODES,
  type CameraErrorCode,
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
  /** Minutes since storage was last read successfully (or since the camera was added). */
  minutesWithoutStorage: number;
  thresholds: Thresholds;
  settings: MonitoringSettings;
  openTypes: ReadonlySet<AlertType>;
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
      description: "The camera reports no SD card or storage device. Recording to local storage is not possible.",
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

  return { active, evaluated };
}
