import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertOctagon, ArrowLeft, KeyRound, Pause, Pencil, Play, PlugZap, RefreshCw, ServerCrash, Table2, Trash2, Video, WifiOff } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, toQuery } from "../api/client";
import type { Alert, CameraDetail, CameraHistory, ConnectionResult, MonitoringSettings, Page } from "../api/types";
import { Diagnostics } from "../components/Diagnostics";
import { LiveViewDialog } from "../components/LiveView";
import { RemoveCamerasDialog } from "../components/RemoveCamerasDialog";
import { ConnectionBadge, DeviceHealthBadge, HealthBadge, NoLocalStorageBadge, RecordingBadge, SeverityBadge, UsageMeter } from "../components/status";
import { UsageHistoryChart } from "../components/UsageHistoryChart";
import { useAiStatus } from "../hooks/ai";
import { CameraForecastPanel } from "./AiPage";
import { Button, Card, Dialog, EmptyState, ErrorMessage, Spinner } from "../components/ui";
import { useAuth } from "../hooks/auth";
import { useCheckNow, useRemoveCameras, useSetMonitoring, useTestSavedCamera } from "../hooks/cameras";
import { absoluteTime, ALERT_TYPE_LABELS, ERROR_LABELS, errorCategory, formatBytes, formatDays, formatPercent, relativeTime } from "../lib/format";

const RANGES = [
  { hours: 24, label: "24 hours" },
  { hours: 168, label: "7 days" },
  { hours: 720, label: "30 days" },
];

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-ink">{children ?? "—"}</dd>
    </div>
  );
}

/** Explains the current problem so an unreachable camera, bad credentials, an API problem and a disk failure read differently. */
function ProblemPanel({ camera }: { camera: CameraDetail }) {
  const s = camera.status;
  const failingDisks = camera.devices.filter((d) => d.healthStatus === "unhealthy");
  if (!camera.monitoringEnabled) {
    return <Banner icon={<Pause className="h-5 w-5 text-unknown" />} title="Monitoring is disabled" body="No checks or alerts run for this camera until monitoring is enabled again." />;
  }
  if (s.lastErrorCode) {
    const category = errorCategory(s.lastErrorCode);
    const icon =
      category === "Network" ? <WifiOff className="h-5 w-5 text-bad" /> : category === "Authentication" ? <KeyRound className="h-5 w-5 text-bad" /> : <ServerCrash className="h-5 w-5 text-warn" />;
    const advice =
      category === "Network"
        ? s.connection === "offline"
          ? "The camera has not responded to several consecutive checks. Check power, cabling and the network path."
          : "The last check could not reach the camera. It is marked offline only after repeated failures."
        : category === "Authentication"
          ? "The camera answered but rejected the credentials. Update the username or password."
          : category === "Camera API"
            ? "The camera answered but its storage API failed. This is not a disk failure."
            : "This is a configuration problem on the monitoring side.";
    return (
      <Banner
        icon={icon}
        title={`${category} problem: ${ERROR_LABELS[s.lastErrorCode] ?? s.lastErrorCode}`}
        body={
          <>
            <span className="block">{s.lastErrorMessage}</span>
            <span className="mt-1 block text-ink-secondary">{advice}</span>
          </>
        }
      />
    );
  }
  if (failingDisks.length) {
    return (
      <Banner
        icon={<AlertOctagon className="h-5 w-5 text-bad" />}
        title="Disk failure reported by the camera"
        body={failingDisks.map((d) => `${d.name ?? d.id}: status "${d.rawStatus}"`).join("; ")}
      />
    );
  }
  return null;
}

function Banner({ icon, title, body }: { icon: ReactNode; title: string; body: ReactNode }) {
  return (
    <div className="mb-5 flex gap-3 rounded-lg border border-line bg-surface p-4" role="status">
      <span aria-hidden className="mt-0.5">{icon}</span>
      <div className="text-sm">
        <div className="font-semibold">{title}</div>
        <div className="mt-0.5">{body}</div>
      </div>
    </div>
  );
}

export function CameraDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const ai = useAiStatus();
  const [hours, setHours] = useState(168);
  const [showTable, setShowTable] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [live, setLive] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionResult | null>(null);

  const camera = useQuery({ queryKey: ["camera", id], queryFn: () => api<CameraDetail>(`/cameras/${id}`), refetchInterval: 30_000 });
  const history = useQuery({
    queryKey: ["camera", id, "history", hours],
    queryFn: () => api<CameraHistory>(`/cameras/${id}/history${toQuery({ hours, limit: 5000 })}`),
    refetchInterval: 60_000,
  });
  const alerts = useQuery({
    queryKey: ["alerts", "camera", id],
    queryFn: () => api<Page<Alert>>(`/alerts${toQuery({ cameraId: id, status: "all", pageSize: 20 })}`),
  });
  const settings = useQuery({ queryKey: ["settings", "monitoring"], queryFn: () => api<MonitoringSettings>("/settings/monitoring"), enabled: can("settings:read") });

  const checkNow = useCheckNow();
  const setMonitoring = useSetMonitoring();
  const remove = useRemoveCameras();
  const testConn = useTestSavedCamera();

  if (camera.isLoading) return <Spinner label="Loading camera" />;
  if (camera.error || !camera.data) return <ErrorMessage error={camera.error ?? new Error("Camera not found")} />;
  const c = camera.data;
  const s = c.status;
  const warning = c.warningThreshold ?? settings.data?.warningThresholdPercent ?? 80;
  const critical = c.criticalThreshold ?? settings.data?.criticalThresholdPercent ?? 90;
  const checks = history.data?.checks ?? [];
  const lastResponse = checks.find((k) => k.outcome === "success")?.checkedAt ?? s.lastSuccessAt;

  return (
    <>
      <Link to="/cameras" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-secondary hover:text-ink">
        <ArrowLeft className="h-4 w-4" /> Cameras
      </Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{c.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-secondary">
            <span className="tabular">{c.host}:{c.port}</span>·<span>{c.brandName}</span>
            {c.location && <>·<span>{c.location}</span></>}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <ConnectionBadge status={s.connection} monitoringEnabled={c.monitoringEnabled} />
            {c.localStorage === false ? (
              <NoLocalStorageBadge />
            ) : (
              <>
                <RecordingBadge state={s.recording.state} detail={s.recording.detail} />
                <HealthBadge health={s.storageHealth} />
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {can("cameras:live") && (
            <Button icon={<Video className="h-4 w-4" />} onClick={() => setLive(true)}>
              Live view
            </Button>
          )}
          {can("cameras:check") && (
            <>
              <Button
                variant="primary"
                icon={<RefreshCw className={clsx("h-4 w-4", checkNow.isPending && "animate-spin")} />}
                disabled={checkNow.isPending || s.checkInProgress}
                onClick={() => checkNow.mutate(c.id)}
              >
                {checkNow.isPending ? "Checking…" : "Refresh now"}
              </Button>
              <Button icon={<PlugZap className="h-4 w-4" />} loading={testConn.isPending} onClick={() => testConn.mutate({ id: c.id }, { onSuccess: setTestResult })}>
                Test connection
              </Button>
            </>
          )}
          {can("cameras:write") && (
            <>
              <Button icon={<Pencil className="h-4 w-4" />} onClick={() => navigate(`/cameras/${c.id}/edit`)}>
                Edit
              </Button>
              <Button
                icon={c.monitoringEnabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                onClick={() => setMonitoring.mutate({ id: c.id, enabled: !c.monitoringEnabled })}
              >
                {c.monitoringEnabled ? "Disable monitoring" : "Enable monitoring"}
              </Button>
              <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setRemoving(true)}>
                Remove
              </Button>
            </>
          )}
        </div>
      </div>

      <ProblemPanel camera={c} />

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Storage" className="lg:col-span-2">
          <div className="p-4">
            {c.localStorage === false ? (
              <EmptyState
                title="No local storage"
                description="This camera records elsewhere (e.g. to an NVR), so its storage and recording are not monitored here. It is still checked for being online. Change this under Edit."
              />
            ) : s.totalBytes === null && s.lastSuccessAt && c.devices.length === 0 ? (
              <EmptyState
                title="No SD card detected"
                description="The camera answered but reports no SD card or storage device. If it records to an NVR instead, untick “Records to an SD card or local storage” under Edit (or use No local storage in the camera list)."
              />
            ) : s.totalBytes === null ? (
              <EmptyState
                title={s.lastAttemptAt ? "No storage data yet" : "Not checked yet"}
                description={s.lastAttemptAt ? "Storage has not been read successfully yet. See the problem described above." : "The first check runs shortly after the camera is added, or use Refresh now."}
              />
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                  <Info label="Total capacity"><span className="tabular text-lg font-semibold">{formatBytes(s.totalBytes)}</span></Info>
                  <Info label="Used"><span className="tabular text-lg font-semibold">{formatBytes(s.usedBytes)}</span></Info>
                  <Info label="Available"><span className="tabular text-lg font-semibold">{formatBytes(s.freeBytes)}</span></Info>
                  <Info label="Used %"><span className="tabular text-lg font-semibold">{formatPercent(s.usedPercentage)}</span></Info>
                </div>
                <div className="mt-4">
                  <UsageMeter percent={s.usedPercentage} warning={warning} critical={critical} />
                  <p className="mt-1 text-xs text-ink-muted">
                    Warning at {warning}%, critical at {critical}%. Figures as of {absoluteTime(s.lastSuccessAt)}.
                  </p>
                </div>
              </>
            )}
          </div>
          {c.devices.length > 0 && (
            <div className="overflow-x-auto border-t border-line">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Storage devices</caption>
                <thead className="text-xs text-ink-secondary">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">Device</th>
                    <th scope="col" className="px-4 py-2 font-medium">Status (from camera)</th>
                    <th scope="col" className="px-4 py-2 font-medium">Usage</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">Free / Total</th>
                    <th scope="col" className="px-4 py-2 font-medium">Access</th>
                  </tr>
                </thead>
                <tbody>
                  {c.devices.map((d) => (
                    <tr key={d.id} className="border-t border-line">
                      <td className="px-4 py-2">
                        <div className="font-medium">{d.name ?? d.id}</div>
                        <div className="text-xs text-ink-muted">{[d.type, d.formatType].filter(Boolean).join(" · ") || "—"}</div>
                      </td>
                      <td className="px-4 py-2"><DeviceHealthBadge health={d.healthStatus} raw={d.rawStatus} /></td>
                      <td className="px-4 py-2"><UsageMeter percent={d.usedPercentage} warning={warning} critical={critical} compact /></td>
                      <td className="tabular whitespace-nowrap px-4 py-2 text-right">{formatBytes(d.freeBytes)} / {formatBytes(d.totalBytes)}</td>
                      <td className="px-4 py-2 text-ink-secondary">{d.writable === false ? "Read-only" : d.writable ? "Read/write" : (d.property ?? "—")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="Monitoring">
          <dl className="grid grid-cols-2 gap-4 p-4">
            <Info label="Last successful check"><span title={absoluteTime(s.lastSuccessAt)}>{relativeTime(s.lastSuccessAt)}</span></Info>
            <Info label="Last attempt"><span title={absoluteTime(s.lastAttemptAt)}>{relativeTime(s.lastAttemptAt)}</span></Info>
            <Info label="Last API response">{lastResponse ? absoluteTime(lastResponse) : "Never"}</Info>
            <Info label="Next scheduled check">{c.monitoringEnabled ? relativeTime(s.nextCheckAt) : "Paused"}</Info>
            <Info label="Consecutive failures">{s.consecutiveFailures}</Info>
            <Info label="Open alerts">{s.openAlerts}</Info>
            <div className="col-span-2">
              <Info label="Recording">
                <RecordingBadge state={s.recording.state} detail={s.recording.detail} />
                {s.recording.detail && <span className="mt-1 block text-ink-secondary">{s.recording.detail}</span>}
                {s.recording.checkedAt && (
                  <span className="block text-xs text-ink-muted" title={absoluteTime(s.recording.checkedAt)}>Checked {relativeTime(s.recording.checkedAt)}</span>
                )}
              </Info>
            </div>
            {c.localStorage !== false && (
              <div className="col-span-2">
                <Info label="Recordings available">
                  {s.recording.daysAvailable !== null ? (
                    <>
                      <span className="font-medium">
                        {s.recording.daysAtLeast && "At least "}
                        {formatDays(s.recording.daysAvailable)}
                      </span>
                      {s.recording.oldest && (
                        <span className="block text-ink-secondary">Oldest recording {s.recording.oldest.replace("T", " ").slice(0, 16)} (camera time)</span>
                      )}
                    </>
                  ) : s.recording.rangeError ? (
                    <span className="text-ink-secondary">Could not be read: {s.recording.rangeError}</span>
                  ) : s.recording.rangeCheckedAt ? (
                    <span className="text-ink-secondary">No recordings found on the camera's storage, or this brand does not report them yet</span>
                  ) : (
                    <span className="text-ink-secondary">Not read yet</span>
                  )}
                  {s.recording.rangeCheckedAt && (
                    <span className="block text-xs text-ink-muted" title={absoluteTime(s.recording.rangeCheckedAt)}>Checked {relativeTime(s.recording.rangeCheckedAt)}</span>
                  )}
                </Info>
              </div>
            )}
            <div className="col-span-2">
              <Info label="Most recent error">
                {s.lastErrorCode ? (
                  <>
                    <span className="font-medium">{ERROR_LABELS[s.lastErrorCode] ?? s.lastErrorCode}</span>
                    <span className="block text-ink-secondary">{s.lastErrorMessage}</span>
                  </>
                ) : (
                  "None"
                )}
              </Info>
            </div>
          </dl>
        </Card>

        <Card
          title="Storage utilisation history"
          className="lg:col-span-2"
          actions={
            <>
              <div role="group" aria-label="Time range" className="flex rounded-md border border-line-strong p-0.5">
                {RANGES.map((r) => (
                  <button
                    key={r.hours}
                    onClick={() => setHours(r.hours)}
                    aria-pressed={hours === r.hours}
                    className={clsx("rounded px-2 py-1 text-xs font-medium", hours === r.hours ? "bg-accent-soft/70 text-ink" : "text-ink-secondary hover:text-ink")}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <Button size="sm" variant="ghost" icon={<Table2 className="h-4 w-4" />} aria-pressed={showTable} onClick={() => setShowTable(!showTable)}>
                {showTable ? "Chart" : "Table"}
              </Button>
            </>
          }
        >
          <div className={clsx("p-4 transition-opacity", history.isFetching && "opacity-70")}>
            {history.error ? (
              <ErrorMessage error={history.error} />
            ) : checks.length === 0 ? (
              <EmptyState title="No checks in this period" />
            ) : showTable ? (
              <div className="max-h-72 overflow-auto">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-surface text-xs text-ink-secondary">
                    <tr>
                      <th scope="col" className="py-1.5 pr-3 font-medium">Time</th>
                      <th scope="col" className="py-1.5 pr-3 font-medium">Result</th>
                      <th scope="col" className="py-1.5 pr-3 text-right font-medium">Used %</th>
                      <th scope="col" className="py-1.5 pr-3 text-right font-medium">Used</th>
                      <th scope="col" className="py-1.5 text-right font-medium">Total</th>
                    </tr>
                  </thead>
                  <tbody className="tabular">
                    {checks.map((k) => (
                      <tr key={k.checkedAt} className="border-t border-line">
                        <td className="py-1.5 pr-3">{absoluteTime(k.checkedAt)}</td>
                        <td className="py-1.5 pr-3">{k.outcome === "success" ? "OK" : (ERROR_LABELS[k.outcome] ?? k.outcome)}</td>
                        <td className="py-1.5 pr-3 text-right">{formatPercent(k.usedPercentage)}</td>
                        <td className="py-1.5 pr-3 text-right">{formatBytes(k.usedBytes)}</td>
                        <td className="py-1.5 text-right">{formatBytes(k.totalBytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <UsageHistoryChart checks={checks} warning={warning} critical={critical} hours={hours} />
            )}
          </div>
        </Card>

        {ai.data?.enabled && (
          <Card title="Storage forecast" className="lg:col-span-2">
            <CameraForecastPanel cameraId={id} />
          </Card>
        )}

        <Card title="Configuration">
          <dl className="grid grid-cols-2 gap-4 p-4">
            <Info label="Address">{c.protocol.toUpperCase()} · {c.host}:{c.port}</Info>
            <Info label="Brand">{c.brandName}</Info>
            <Info label="Model">{c.model}</Info>
            <Info label="Location">{c.location}</Info>
            <Info label="Username">{c.username}</Info>
            <Info label="Credentials updated">{absoluteTime(c.credentialsUpdatedAt)}</Info>
            <Info label="Serial number">{c.device.serialNumber}</Info>
            <Info label="Firmware">{c.device.firmwareVersion}</Info>
            <Info label="Thresholds">{warning}% / {critical}%{c.warningThreshold === null && c.criticalThreshold === null ? " (global)" : ""}</Info>
            <Info label="TLS CA certificate">{c.protocol === "https" ? (c.hasCaCertificate ? "Custom CA stored" : "System trust store") : "Not applicable"}</Info>
          </dl>
        </Card>

        <Card title="Connection and monitoring history" className="lg:col-span-2">
          <ul className="max-h-80 divide-y divide-line overflow-auto text-sm">
            {[
              ...(history.data?.connectionEvents ?? []).map((e) => ({
                at: e.occurredAt,
                node: (
                  <>
                    <span className="font-medium">Connection {e.fromStatus} → {e.toStatus}</span>
                    {e.reason && <span className="text-ink-secondary"> — {e.reason}</span>}
                  </>
                ),
              })),
              ...checks.slice(0, 50).map((k) => ({
                at: k.checkedAt,
                node: (
                  <>
                    <span>{k.trigger === "manual" ? "Manual check" : "Scheduled check"}: </span>
                    <span className="font-medium">{k.outcome === "success" ? `OK (${formatPercent(k.usedPercentage)} used)` : (ERROR_LABELS[k.outcome] ?? k.outcome)}</span>
                    <span className="text-ink-muted"> · {k.durationMs} ms{k.attempts > 1 ? ` · ${k.attempts} attempts` : ""}</span>
                    {k.errorMessage && <span className="block text-xs text-ink-secondary">{k.errorMessage}</span>}
                  </>
                ),
              })),
            ]
              .sort((a, b) => b.at.localeCompare(a.at))
              .map((item, i) => (
                <li key={i} className="flex gap-3 px-4 py-2">
                  <span className="tabular w-36 shrink-0 text-xs text-ink-muted">{absoluteTime(item.at)}</span>
                  <span className="min-w-0">{item.node}</span>
                </li>
              ))}
            {checks.length === 0 && <li className="px-4 py-6 text-center text-ink-muted">No history yet</li>}
          </ul>
        </Card>

        <Card title="Alert history">
          {alerts.data?.items.length ? (
            <ul className="divide-y divide-line text-sm">
              {alerts.data.items.map((a) => (
                <li key={a.id} className="px-4 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <SeverityBadge severity={a.severity} />
                    <span className="font-medium">{ALERT_TYPE_LABELS[a.type] ?? a.title}</span>
                    <span className="ml-auto text-xs capitalize text-ink-muted">{a.status}</span>
                  </div>
                  <div className="mt-1 text-xs text-ink-secondary">
                    {absoluteTime(a.firstDetectedAt)}
                    {a.resolvedAt && ` → resolved ${absoluteTime(a.resolvedAt)}`}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No alerts for this camera" />
          )}
        </Card>
      </div>

      <Dialog open={!!testResult} onClose={() => setTestResult(null)} title={`Connection test: ${c.name}`}>
        {testResult && <Diagnostics result={testResult} />}
      </Dialog>
      <LiveViewDialog camera={live ? c : null} onClose={() => setLive(false)} />
      <RemoveCamerasDialog
        open={removing}
        names={[c.name]}
        loading={remove.isPending}
        onCancel={() => setRemoving(false)}
        onConfirm={() => remove.mutate([c.id], { onSuccess: () => navigate("/cameras") })}
      />
    </>
  );
}
