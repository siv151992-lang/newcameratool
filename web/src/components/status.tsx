import clsx from "clsx";
import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDot, CircleHelp, CirclePause, CircleStop, FilePen, FlaskConical, HardDriveDownload, WifiOff } from "lucide-react";
import type { ConnectionStatus, IntegrationStatus, RecordingState, Severity, StorageHealth } from "../api/types";

/**
 * Status indicators always pair color with an icon and a text label, so meaning never
 * depends on color alone. Text stays in ink colors; only the icon carries the status hue.
 */
type Tone = "good" | "warn" | "bad" | "unknown";

const TONE_ICON_CLASS: Record<Tone, string> = {
  good: "text-good",
  warn: "text-warn",
  bad: "text-bad",
  unknown: "text-unknown",
};
const TONE_BG: Record<Tone, string> = {
  good: "bg-good/10 border-good/30",
  warn: "bg-warn/15 border-warn/40",
  bad: "bg-bad/10 border-bad/35",
  unknown: "bg-unknown/10 border-unknown/30",
};

function Pill({ tone, icon: Icon, label, title }: { tone: Tone; icon: typeof CheckCircle2; label: string; title?: string }) {
  return (
    <span
      title={title}
      className={clsx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium text-ink", TONE_BG[tone])}
    >
      <Icon className={clsx("h-3.5 w-3.5", TONE_ICON_CLASS[tone])} aria-hidden />
      {label}
    </span>
  );
}

export function ConnectionBadge({ status, monitoringEnabled = true }: { status: ConnectionStatus; monitoringEnabled?: boolean }) {
  if (!monitoringEnabled) return <Pill tone="unknown" icon={CirclePause} label="Monitoring off" />;
  if (status === "online") return <Pill tone="good" icon={CheckCircle2} label="Online" />;
  if (status === "offline") return <Pill tone="bad" icon={WifiOff} label="Offline" />;
  return <Pill tone="unknown" icon={CircleHelp} label="Unknown" title="Not checked yet, or not enough checks to decide" />;
}

export function HealthBadge({ health }: { health: StorageHealth }) {
  if (health === "healthy") return <Pill tone="good" icon={CheckCircle2} label="Healthy" />;
  if (health === "warning") return <Pill tone="warn" icon={AlertTriangle} label="Warning" />;
  if (health === "critical") return <Pill tone="bad" icon={AlertOctagon} label="Critical" />;
  return <Pill tone="unknown" icon={CircleHelp} label="Unknown" />;
}

export function RecordingBadge({ state, detail }: { state: RecordingState; detail?: string | null }) {
  const title = detail ?? undefined;
  if (state === "recording") return <Pill tone="good" icon={CircleDot} label="Recording" title={title} />;
  if (state === "idle") return <Pill tone="warn" icon={CircleStop} label="Not recording" title={title} />;
  if (state === "error") return <Pill tone="bad" icon={AlertOctagon} label="Recording error" title={title} />;
  return <Pill tone="unknown" icon={CircleHelp} label="Unknown" title={title ?? "Not checked yet, or not reported by this camera"} />;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  if (severity === "critical") return <Pill tone="bad" icon={AlertOctagon} label="Critical" />;
  if (severity === "warning") return <Pill tone="warn" icon={AlertTriangle} label="Warning" />;
  return <Pill tone="unknown" icon={CircleHelp} label="Info" />;
}

export function DeviceHealthBadge({ health, raw }: { health: string; raw: string | null }) {
  const label = raw ? `${raw}` : health;
  if (health === "healthy") return <Pill tone="good" icon={CheckCircle2} label={label} title="Reported by camera" />;
  if (health === "degraded") return <Pill tone="warn" icon={AlertTriangle} label={label} title="Reported by camera" />;
  if (health === "unhealthy") return <Pill tone="bad" icon={AlertOctagon} label={label} title="Reported by camera" />;
  return <Pill tone="unknown" icon={CircleHelp} label={label || "unknown"} title="Status not recognised" />;
}

/**
 * Usage meter: the fill carries severity, the track is a lighter step of the same ramp.
 * The numeric value is always shown as text beside it.
 */
export function UsageMeter({
  percent,
  warning = 80,
  critical = 90,
  compact,
}: {
  percent: number | null;
  warning?: number;
  critical?: number;
  compact?: boolean;
}) {
  if (percent === null || percent === undefined) return <span className="text-sm text-ink-muted">—</span>;
  const tone = percent >= critical ? "bg-bad" : percent >= warning ? "bg-warn" : "bg-accent";
  const track = percent >= critical ? "bg-bad/15" : percent >= warning ? "bg-warn/20" : "bg-accent/15";
  return (
    <div className={clsx("flex items-center gap-2", compact ? "min-w-[110px]" : "min-w-[160px]")}>
      <div
        className={clsx("h-2 flex-1 overflow-hidden rounded-full", track)}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-label="Storage used"
      >
        <div className={clsx("h-full rounded-full", tone)} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
      </div>
      <span className="tabular w-12 text-right text-sm text-ink">{percent.toFixed(1)}%</span>
    </div>
  );
}

/** Shown instead of storage and recording states for cameras that record elsewhere (e.g. an NVR). */
export function NoLocalStorageBadge() {
  return <Pill tone="unknown" icon={HardDriveDownload} label="No local storage" title="Records elsewhere (e.g. an NVR); storage and recording alerts are off" />;
}

/** Lifecycle of a brand integration: only "Enabled" integrations monitor cameras. */
export function IntegrationStatusBadge({ status }: { status: IntegrationStatus }) {
  if (status === "enabled") return <Pill tone="good" icon={CheckCircle2} label="Enabled" title="Used for monitoring and offered when adding cameras" />;
  if (status === "tested") return <Pill tone="warn" icon={FlaskConical} label="Tested" title="Test passed; not used for monitoring until enabled" />;
  if (status === "disabled") return <Pill tone="unknown" icon={CirclePause} label="Disabled" title="Not used for monitoring; cameras and history are kept" />;
  return <Pill tone="unknown" icon={FilePen} label="Draft" title="Saved but not successfully tested yet" />;
}
