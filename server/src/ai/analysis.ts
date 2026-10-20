import { currentSegment, type Forecast, type UsagePoint } from "./forecast.js";

/**
 * Rule-based anomaly detection, camera health scoring and recommended actions. Every finding
 * carries the measurements it was based on, so the UI (and the assistant) can explain why a
 * camera was flagged instead of asserting it.
 */

export type FindingSeverity = "info" | "warning" | "critical";

export interface CameraSnapshot {
  id: string;
  name: string;
  host: string;
  location: string | null;
  brand: string;
  monitoringEnabled: boolean;
  connection: "online" | "offline" | "unknown";
  storageHealth: "healthy" | "warning" | "critical" | "unknown";
  recordingState: "recording" | "idle" | "error" | "unknown";
  recordingDetail: string | null;
  usedPercentage: number | null;
  lastSuccessAt: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  warningThreshold: number;
  criticalThreshold: number;
  openAlerts: { id: number; type: string; severity: FindingSeverity; title: string }[];
  /** Transitions to offline in the last 24 hours / 7 days. */
  disconnects24h: number;
  disconnects7d: number;
}

export interface Anomaly {
  type: "usage_spike" | "usage_drop" | "capacity_changed" | "stagnant_usage" | "repeated_disconnects" | "stale_data";
  severity: FindingSeverity;
  title: string;
  explanation: string;
  evidence: Record<string, unknown>;
}

const DAY = 86_400_000;
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export function detectAnomalies(cam: CameraSnapshot, points: UsagePoint[], forecast: Forecast, now = Date.now()): Anomaly[] {
  const out: Anomaly[] = [];
  const sorted = [...points].sort((a, b) => a.t - b.t);

  // Sudden change in consumption: the last 24h rate is far above the long-run trend.
  const longRun = forecast.growthPercentPerDay;
  const recent = forecast.recentPercentPerDay;
  if (recent !== null && recent >= 2 && (longRun === null || longRun <= 0 || recent >= 3 * longRun) && forecast.period && forecast.period.days >= 2) {
    out.push({
      type: "usage_spike",
      severity: recent >= 10 ? "critical" : "warning",
      title: "Unusual storage consumption",
      explanation:
        `Usage grew ${round(recent, 1)} percentage points per day over the last 24 hours, versus a trend of ` +
        `${longRun === null ? "unknown" : round(longRun, 2)} points per day over ${forecast.period.days} days. ` +
        "Possible causes: higher bitrate or resolution, continuous recording replacing motion recording, or more activity.",
      evidence: { recentPercentPerDay: recent, trendPercentPerDay: longRun, periodDays: forecast.period.days },
    });
  }

  // A large drop: card formatted, recordings deleted, or the camera began overwriting.
  const segment = currentSegment(sorted);
  if (segment.length < sorted.length && segment.length > 0) {
    const before = sorted[sorted.length - segment.length - 1]!;
    const after = segment[0]!;
    if (now - after.t <= 7 * DAY) {
      const resized = !!before.totalBytes && !!after.totalBytes && Math.abs(after.totalBytes - before.totalBytes) / before.totalBytes > 0.05;
      out.push(
        resized
          ? {
              type: "capacity_changed",
              severity: "info",
              title: "Storage capacity changed",
              explanation: `Total capacity changed from ${before.totalBytes} to ${after.totalBytes} bytes (card replaced or repartitioned).`,
              evidence: { at: new Date(after.t).toISOString(), fromBytes: before.totalBytes, toBytes: after.totalBytes },
            }
          : {
              type: "usage_drop",
              severity: "warning",
              title: "Storage usage dropped sharply",
              explanation:
                `Usage fell from ${round(before.usedPercentage, 1)}% to ${round(after.usedPercentage, 1)}%. ` +
                "If nobody formatted the card or deleted recordings, footage may have been lost.",
              evidence: { at: new Date(after.t).toISOString(), fromPercent: round(before.usedPercentage, 1), toPercent: round(after.usedPercentage, 1) },
            },
      );
    }
  }

  // No change in a day while the camera says it records and is not full: footage may not be written.
  const lastDay = sorted.filter((p) => p.t >= now - DAY);
  if (lastDay.length >= 6 && (lastDay.at(-1)!.t - lastDay[0]!.t) >= 18 * 3_600_000) {
    const min = Math.min(...lastDay.map((p) => p.usedPercentage));
    const max = Math.max(...lastDay.map((p) => p.usedPercentage));
    const bytes = lastDay.map((p) => p.usedBytes).filter((b): b is number => typeof b === "number");
    const unchangedBytes = bytes.length === lastDay.length && Math.max(...bytes) === Math.min(...bytes);
    if (max - min < 0.01 && unchangedBytes && (cam.usedPercentage ?? 0) < 97) {
      out.push({
        type: "stagnant_usage",
        severity: cam.recordingState === "recording" ? "warning" : "info",
        title: "Storage usage has not changed in 24 hours",
        explanation:
          cam.recordingState === "recording"
            ? "The camera reports it is recording, but used storage has not changed at all in 24 hours. Recordings may not be reaching the card."
            : "Used storage has not changed in 24 hours, so nothing has been recorded locally in that time.",
        evidence: { usedPercentage: round(max, 2), measurements: lastDay.length, recordingState: cam.recordingState },
      });
    }
  }

  if (cam.disconnects24h >= 2 || cam.disconnects7d >= 3) {
    out.push({
      type: "repeated_disconnects",
      severity: cam.disconnects24h >= 3 ? "critical" : "warning",
      title: "Repeated disconnections",
      explanation:
        `The camera went offline ${cam.disconnects24h} time(s) in the last 24 hours and ${cam.disconnects7d} time(s) in 7 days. ` +
        "Check the network cable, switch port and PoE power.",
      evidence: { disconnects24h: cam.disconnects24h, disconnects7d: cam.disconnects7d },
    });
  }

  if (cam.monitoringEnabled && cam.connection !== "offline" && cam.lastSuccessAt !== null && now - cam.lastSuccessAt > 6 * 3_600_000) {
    out.push({
      type: "stale_data",
      severity: "warning",
      title: "Storage data is out of date",
      explanation: `The last successful storage reading was ${round((now - cam.lastSuccessAt) / 3_600_000, 1)} hours ago.`,
      evidence: { lastSuccessAt: new Date(cam.lastSuccessAt).toISOString(), lastError: cam.lastErrorCode },
    });
  }
  return out;
}

export interface HealthAssessment {
  score: number;
  grade: "good" | "fair" | "poor" | "unknown";
  /** Each deduction, largest first, so the score is explainable. */
  factors: { label: string; impact: number }[];
}

export function assessHealth(cam: CameraSnapshot, forecast: Forecast, anomalies: Anomaly[]): HealthAssessment {
  if (!cam.monitoringEnabled) return { score: 0, grade: "unknown", factors: [{ label: "Monitoring is disabled", impact: 0 }] };
  const factors: { label: string; impact: number }[] = [];
  const add = (label: string, impact: number) => factors.push({ label, impact });

  if (cam.connection === "offline") add("Camera is offline", 50);
  else if (cam.connection === "unknown") add("Connection not confirmed yet", 10);
  if (cam.storageHealth === "critical") add("Storage health is critical", 30);
  else if (cam.storageHealth === "warning") add("Storage health warning", 15);
  if (cam.recordingState === "error") add("Recording error reported", 30);
  else if (cam.recordingState === "idle") add("Not recording", 20);
  if (forecast.daysToCritical !== null && forecast.daysToCritical > 0) {
    if (forecast.daysToCritical <= 3) add(`Projected to reach ${cam.criticalThreshold}% in ${forecast.daysToCritical} days`, 20);
    else if (forecast.daysToCritical <= 7) add(`Projected to reach ${cam.criticalThreshold}% in ${forecast.daysToCritical} days`, 10);
  }
  for (const a of anomalies) {
    if (a.severity === "critical") add(a.title, 20);
    else if (a.severity === "warning") add(a.title, 10);
  }
  const criticalAlerts = cam.openAlerts.filter((a) => a.severity === "critical").length;
  if (criticalAlerts > 0) add(`${criticalAlerts} open critical alert(s)`, 10);

  factors.sort((a, b) => b.impact - a.impact);
  const score = Math.max(0, 100 - factors.reduce((s, f) => s + f.impact, 0));
  const noData = cam.connection === "unknown" && cam.usedPercentage === null;
  return { score, grade: noData ? "unknown" : score >= 80 ? "good" : score >= 50 ? "fair" : "poor", factors };
}

export interface RecommendedAction {
  priority: "critical" | "high" | "medium" | "low";
  cameraId: string;
  cameraName: string;
  action: string;
  reason: string;
}

const PRIORITY_RANK = { critical: 0, high: 1, medium: 2, low: 3 } as const;

export function recommendActions(cam: CameraSnapshot, forecast: Forecast, anomalies: Anomaly[]): RecommendedAction[] {
  if (!cam.monitoringEnabled) return [];
  const out: RecommendedAction[] = [];
  const add = (priority: RecommendedAction["priority"], action: string, reason: string) =>
    out.push({ priority, cameraId: cam.id, cameraName: cam.name, action, reason });
  const authFailing = cam.lastErrorCode === "AUTH_FAILED" || cam.openAlerts.some((a) => a.type === "auth_failure");

  if (cam.connection === "offline") {
    add("critical", `Check power and the network connection of ${cam.name} (${cam.host}).`, cam.lastErrorMessage ?? "The camera does not respond to checks.");
  } else if (authFailing) {
    add("high", `Update the stored credentials for ${cam.name}, or unlock the camera account.`, cam.lastErrorMessage ?? "The camera rejects the username or password.");
  }
  if (cam.openAlerts.some((a) => a.type === "disk_unhealthy")) {
    add("critical", `Replace or reformat the storage card in ${cam.name}.`, "The camera reports a storage device fault.");
  }
  if (cam.openAlerts.some((a) => a.type === "no_storage_device")) {
    add("critical", `Insert or reseat the SD card in ${cam.name}.`, "The camera reports no storage device.");
  }
  if (cam.recordingState === "error") {
    add("critical", `Check the recording configuration and storage of ${cam.name}.`, cam.recordingDetail ?? "The camera reports a recording error.");
  } else if (cam.recordingState === "idle") {
    add("high", `Check the recording schedule of ${cam.name}; it is not recording now.`, cam.recordingDetail ?? "The camera reports it is not recording.");
  }
  if (forecast.status !== "full_overwriting" && forecast.daysToCritical !== null && forecast.daysToCritical > 0 && forecast.daysToCritical <= 7) {
    add(
      forecast.daysToCritical <= 3 ? "high" : "medium",
      `Free space on ${cam.name}, enable overwrite, or fit a larger card before ${forecast.criticalAt?.slice(0, 10)}.`,
      `Projected to reach ${cam.criticalThreshold}% in about ${forecast.daysToCritical} days (${forecast.confidence} confidence).`,
    );
  } else if (forecast.daysToCritical === 0 && forecast.status !== "full_overwriting") {
    add("high", `Free space on ${cam.name} or enable overwrite.`, `Usage is already at or above ${cam.criticalThreshold}%.`);
  }
  for (const a of anomalies) {
    if (a.type === "repeated_disconnects") add(a.severity === "critical" ? "high" : "medium", `Inspect the cabling, switch port and PoE power of ${cam.name}.`, a.explanation);
    if (a.type === "stagnant_usage" && a.severity === "warning") add("high", `Verify that ${cam.name} is actually writing recordings to its card.`, a.explanation);
    if (a.type === "usage_drop") add("medium", `Confirm whether someone formatted or cleared the card in ${cam.name}.`, a.explanation);
    if (a.type === "usage_spike") add("medium", `Review the recording settings (bitrate, schedule) of ${cam.name}.`, a.explanation);
  }
  return out.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
}

export function sortActions(actions: RecommendedAction[]): RecommendedAction[] {
  return [...actions].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.cameraName.localeCompare(b.cameraName));
}
