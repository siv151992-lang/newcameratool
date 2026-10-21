import { useQuery } from "@tanstack/react-query";
import { AlertOctagon, AlertTriangle, Camera, CheckCircle2, CircleStop, HardDrive, Plus, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import type { Alert, Page, Summary } from "../api/types";
import { SeverityBadge } from "../components/status";
import { Button, Card, EmptyState, ErrorMessage, PageHeader } from "../components/ui";
import { useAuth } from "../hooks/auth";
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
  const alerts = useQuery({
    queryKey: ["alerts", "dashboard"],
    queryFn: () => api<Page<Alert>>("/alerts?status=open&pageSize=5"),
    refetchInterval: 30_000,
  });
  const s = summary.data;
  const usedPct = s && s.totalBytes > 0 ? (s.usedBytes / s.totalBytes) * 100 : null;
  const icon = "h-4 w-4";

  return (
    <>
      {/* Adding, importing and listing cameras live on the Cameras page; each tile opens it filtered. */}
      <PageHeader title="Dashboard" description="Storage health across all registered cameras. Select a tile to see those cameras." />
      <ErrorMessage error={summary.error} className="mb-4" />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatTile label="Registered cameras" value={s?.totalCameras ?? "—"} icon={<Camera className={icon} />} hint={s && s.disabled > 0 ? `${s.disabled} with monitoring disabled` : "All monitored"} to="/cameras" />
        <StatTile label="Online" value={s?.online ?? "—"} icon={<CheckCircle2 className={`${icon} text-good`} />} hint={s && s.unknown > 0 ? `${s.unknown} not yet checked` : undefined} to="/cameras?status=online" />
        <StatTile label="Offline" value={s?.offline ?? "—"} icon={<WifiOff className={`${icon} text-bad`} />} hint="After repeated failed checks" to="/cameras?status=offline" />
        <StatTile label="Storage warnings" value={s?.storageWarning ?? "—"} icon={<AlertTriangle className={`${icon} text-warn`} />} to="/cameras?status=warning" />
        <StatTile label="Critical storage" value={s?.storageCritical ?? "—"} icon={<AlertOctagon className={`${icon} text-bad`} />} to="/cameras?status=critical" />
        <StatTile
          label="Not recording"
          value={s?.notRecording ?? "—"}
          icon={<CircleStop className={`${icon} text-warn`} />}
          hint={s ? `${s.recording} recording now` : undefined}
          to="/cameras?recording=idle"
        />
        <StatTile
          label="Total capacity"
          value={s ? formatBytes(s.totalBytes) : "—"}
          icon={<HardDrive className={icon} />}
          hint={s ? `From ${s.camerasWithStorageData} of ${s.monitoredCameras} monitored cameras${s.withoutLocalStorage ? ` (${s.withoutLocalStorage} without local storage)` : ""}` : undefined}
        />
        <StatTile label="Used" value={s ? formatBytes(s.usedBytes) : "—"} icon={<HardDrive className={icon} />} hint={usedPct !== null ? `${usedPct.toFixed(1)}% of capacity` : undefined} />
        <StatTile label="Available" value={s ? formatBytes(s.freeBytes) : "—"} icon={<HardDrive className={icon} />} />
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
