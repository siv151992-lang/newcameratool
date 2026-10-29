import { useQuery } from "@tanstack/react-query";
import { AlertOctagon, AlertTriangle, Camera, CheckCircle2, Download, HardDrive, MemoryStick, Plus, RefreshCw, Server, ShieldAlert, Video, WifiOff } from "lucide-react";
import clsx from "clsx";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Alert, Page, Summary } from "../api/types";
import { SeverityBadge } from "../components/status";
import { Button, Card, EmptyState, ErrorMessage, PageHeader } from "../components/ui";
import { useAuth } from "../hooks/auth";
import { useDownloadCameraReport } from "../hooks/cameras";
import { formatBytes, relativeTime } from "../lib/format";

function StatTile({ label, value, icon, hint, to }: { label: string; value: ReactNode; icon: ReactNode; hint?: ReactNode; to?: string }) {
  const body = (
    <div className="flex h-full flex-col rounded-lg border border-line bg-surface p-4 transition hover:border-line-strong">
      <div className="flex items-center justify-between gap-2 text-sm text-ink-secondary">
        <span>{label}</span>
        <span aria-hidden>{icon}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold text-ink">{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-muted">{hint}</div>}
    </div>
  );
  return to ? (
    <Link to={to} className="block rounded-lg">
      {body}
    </Link>
  ) : (
    body
  );
}

export function DashboardPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const summary = useQuery({ queryKey: ["summary"], queryFn: () => api<Summary>("/cameras/summary"), refetchInterval: 30_000 });
  const report = useDownloadCameraReport();
  const alerts = useQuery({
    queryKey: ["alerts", "dashboard"],
    queryFn: () => api<Page<Alert>>("/alerts?status=open&pageSize=5"),
    refetchInterval: 30_000,
  });
  // Refresh: reloads the figures (from the latest checks) now, instead of waiting for the next 30 s.
  const refreshing = summary.isFetching || alerts.isFetching;
  const refresh = () => void Promise.all([summary.refetch(), alerts.refetch()]);
  const updatedAt = Math.max(summary.dataUpdatedAt, alerts.dataUpdatedAt);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  const s = summary.data;
  const usedPct = s && s.totalBytes > 0 ? (s.usedBytes / s.totalBytes) * 100 : null;
  const icon = "h-4 w-4";

  return (
    <>
      {/* Adding, importing and listing cameras live on the Cameras page; each tile opens it filtered. */}
      <PageHeader
        title="Dashboard"
        description="Storage health across all registered cameras. Select a tile to see those cameras."
        actions={
          <>
            {updatedAt > 0 && (
              <span className="self-center text-xs text-ink-secondary" aria-live="polite">
                Updated {Date.now() - updatedAt < 10_000 ? "just now" : relativeTime(new Date(updatedAt).toISOString())}
              </span>
            )}
            <Button icon={<RefreshCw className={clsx("h-4 w-4", refreshing && "animate-spin")} />} onClick={refresh} disabled={refreshing} title="Reload the dashboard now (it also updates every 30 seconds)">
              Refresh
            </Button>
            <Button icon={<Download className="h-4 w-4" />} onClick={() => report.download()} loading={report.downloading}>
              Download status report
            </Button>
          </>
        }
      />
      <ErrorMessage error={summary.error} className="mb-4" />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatTile
          label="Critical areas"
          value={s?.criticalArea.total ?? "—"}
          icon={<ShieldAlert className={`${icon} ${s && (s.criticalArea.offline || s.criticalArea.withProblems) ? "text-bad" : "text-good"}`} />}
          hint={s ? (s.criticalArea.total === 0 ? "Mark cameras as critical area on the Cameras page" : s.criticalArea.withProblems ? `${s.criticalArea.offline} offline · ${s.criticalArea.withProblems} with open alerts` : "All fine") : undefined}
          to="/cameras?priority=critical"
        />
        <StatTile label="Registered cameras" value={s?.totalCameras ?? "—"} icon={<Camera className={icon} />} hint={s && s.disabled > 0 ? `${s.disabled} with monitoring disabled` : "All monitored"} to="/cameras" />
        <StatTile label="Online" value={s?.online ?? "—"} icon={<CheckCircle2 className={`${icon} text-good`} />} hint={s && s.unknown > 0 ? `${s.unknown} not yet checked` : undefined} to="/cameras?status=online" />
        <StatTile label="Offline" value={s?.offline ?? "—"} icon={<WifiOff className={`${icon} text-bad`} />} hint="After repeated failed checks" to="/cameras?status=offline" />
        <StatTile label="Storage warnings" value={s?.storageWarning ?? "—"} icon={<AlertTriangle className={`${icon} text-warn`} />} to="/cameras?status=warning" />
        <StatTile label="Critical storage" value={s?.storageCritical ?? "—"} icon={<AlertOctagon className={`${icon} text-bad`} />} to="/cameras?status=critical" />
        <StatTile
          label="SD cards"
          value={s?.sdCard.total ?? "—"}
          icon={<MemoryStick className={`${icon} ${s && s.sdCard.error + s.sdCard.camerasWithout > 0 ? "text-bad" : "text-good"}`} />}
          hint={s ? sdCardHint(s.sdCard) : undefined}
          to={s && s.sdCard.error + s.sdCard.camerasWithout > 0 ? "/cameras?type=camera&status=sdproblem" : "/cameras?type=camera&status=sdok"}
        />
        <StatTile
          label="Total capacity"
          value={s ? formatBytes(s.totalBytes) : "—"}
          icon={<HardDrive className={icon} />}
          hint={s ? capacityHint(s) : undefined}
        />
        <StatTile label="Used" value={s ? formatBytes(s.usedBytes) : "—"} icon={<HardDrive className={icon} />} hint={usedPct !== null ? `${usedPct.toFixed(1)}% of capacity` : undefined} />
        <StatTile label="Available" value={s ? formatBytes(s.freeBytes) : "—"} icon={<HardDrive className={icon} />} />
      </div>

      {/* NVRs: the recorders, their hard disks and their channels. */}
      <h2 className="mb-2 mt-6 flex items-center gap-2 text-sm font-semibold text-ink-secondary">
        <Server className="h-4 w-4" aria-hidden /> NVRs
      </h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatTile
          label="NVRs"
          value={s?.nvr.total ?? "—"}
          icon={<Server className={`${icon} ${s?.nvr.offline ? "text-bad" : ""}`} />}
          hint={s ? (s.nvr.total === 0 ? "Add one under Cameras → Add camera, and tick “This is an NVR”" : s.nvr.offline ? `${s.nvr.offline} offline` : "All online") : undefined}
          to={s?.nvr.offline ? "/cameras?type=nvr&status=offline" : "/cameras?type=nvr"}
        />
        <StatTile
          label="NVR hard disks"
          value={s?.nvr.disks ?? "—"}
          icon={<HardDrive className={`${icon} ${s?.nvr.diskError ? "text-bad" : s?.nvr.disks ? "text-good" : ""}`} />}
          hint={s && s.nvr.total > 0 ? (s.nvr.diskError ? `${s.nvr.diskError} reporting an error` : `${s.nvr.disks} OK`) : undefined}
          to={s?.nvr.diskError ? "/cameras?type=nvr&status=sdproblem" : "/cameras?type=nvr"}
        />
        <StatTile
          label="NVR channels"
          value={s?.nvr.channels ?? "—"}
          icon={<Video className={`${icon} ${s && s.nvr.channelsNoVideo ? "text-bad" : s?.nvr.channelsNotRecording ? "text-warn" : s?.nvr.channels ? "text-good" : ""}`} />}
          hint={s && s.nvr.total > 0 ? (s.nvr.channelsNoVideo + s.nvr.channelsNotRecording ? [s.nvr.channelsNoVideo && `${s.nvr.channelsNoVideo} without video`, s.nvr.channelsNotRecording && `${s.nvr.channelsNotRecording} not recording`].filter(Boolean).join(" · ") : "All with video and recording") : undefined}
          to={s && s.nvr.channelsNoVideo + s.nvr.channelsNotRecording ? "/cameras?type=nvr&status=channelproblem" : "/cameras?type=nvr"}
        />
      </div>

      {s && s.totalCameras === 0 && (
        <Card className="mt-5">
          <EmptyState
            icon={<Camera className="h-6 w-6" />}
            title="No cameras yet"
            description="Add your cameras to start monitoring their storage and recording."
            action={
              can("cameras:write") ? (
                <Button variant="primary" icon={<Plus className={icon} />} onClick={() => navigate("/cameras/new")}>
                  Add camera
                </Button>
              ) : undefined
            }
          />
        </Card>
      )}

      {/* Only shown when there is something to act on. */}
      {alerts.data && alerts.data.items.length > 0 && (
        <Card
          className="mt-5"
          title="Open alerts"
          actions={
            <Link to="/alerts" className="text-sm font-medium text-accent-ink hover:underline">
              View all
            </Link>
          }
        >
          <ul className="divide-y divide-line">
            {alerts.data.items.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-sm">
                <SeverityBadge severity={a.severity} />
                <span className="font-medium">{a.title}</span>
                <Link to={`/cameras/${a.cameraId}`} className="text-ink-secondary hover:underline">
                  {a.cameraName} ({a.cameraHost})
                </Link>
                <span className="ml-auto text-xs text-ink-muted">
                  {a.status === "acknowledged" ? "Acknowledged · " : ""}last seen {relativeTime(a.lastSeenAt)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function capacityHint(s: Summary): string {
  const notes = [
    s.offlineWithStorageData && `${s.offlineWithStorageData} offline not counted`,
    s.withoutLocalStorage && `${s.withoutLocalStorage} without local storage`,
  ].filter(Boolean);
  return `From ${s.camerasWithStorageData} of ${s.monitoredCameras} monitored cameras${notes.length ? ` (${notes.join(", ")})` : ""}`;
}

/** "71 OK · 1 card error · 1 camera without a card" */
function sdCardHint(sd: Summary["sdCard"]): string {
  const parts = [`${sd.ok} OK`];
  if (sd.error) parts.push(`${sd.error} card error${sd.error === 1 ? "" : "s"}`);
  if (sd.camerasWithout) parts.push(`${sd.camerasWithout} camera${sd.camerasWithout === 1 ? "" : "s"} without a card`);
  if (sd.offlineNotCounted) parts.push(`${sd.offlineNotCounted} offline not counted`);
  return parts.join(" · ");
}
