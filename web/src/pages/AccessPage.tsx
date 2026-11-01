import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertTriangle, ArrowLeft, CheckCircle2, CircleHelp, DoorClosed, DoorOpen, Lock, LockOpen, Pencil, Plus, PlugZap, RefreshCw, ShieldAlert, Trash2, WifiOff } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, toQuery } from "../api/client";
import type { AccessEventCategory, AccessEventRow, AccessOverview, AccessPointRow, Alert, CameraDetail, ConnectionResult, Page } from "../api/types";
import { Diagnostics } from "../components/Diagnostics";
import { RemoveCamerasDialog } from "../components/RemoveCamerasDialog";
import { ConnectionBadge, Pill, SeverityBadge } from "../components/status";
import { Button, Card, Dialog, EmptyState, ErrorMessage, Input, PageHeader, Select, Spinner } from "../components/ui";
import { useAuth } from "../hooks/auth";
import { useCheckNow, useRemoveCameras, useTestSavedCamera } from "../hooks/cameras";
import { absoluteTime, relativeTime } from "../lib/format";

const CATEGORY: Record<AccessEventCategory, { label: string; tone: string }> = {
  granted: { label: "Granted", tone: "text-good" },
  denied: { label: "Denied", tone: "text-bad" },
  door: { label: "Door", tone: "text-ink" },
  alarm: { label: "Alarm", tone: "text-bad" },
  tamper: { label: "Tamper", tone: "text-bad" },
  fault: { label: "Fault", tone: "text-warn" },
  other: { label: "Other", tone: "text-ink-muted" },
};

/** Door events that are problems (forced, held open). */
const DOOR_ALARM = /forced|held|too long|abnormal/i;

/**
 * Access control: the access systems (controllers, terminals, BioStar 2 and Command Centre servers)
 * with their readers and doors, and the access events, apart from the cameras.
 */
export function AccessPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const overview = useQuery({ queryKey: ["access"], queryFn: () => api<AccessOverview>("/access"), refetchInterval: 30_000 });
  const s = overview.data?.summary;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Access control"
        description="Access readers and doors: whether readers are online, doors open, forced or held open, tamper, and who was let in or refused. Read at each check from the controllers, or from the BioStar 2 or Command Centre server they report to."
        actions={can("cameras:write") && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => navigate("/access/new")}>Add access system</Button>}
      />
      {overview.isLoading && <Spinner />}
      {overview.error && <ErrorMessage error={overview.error as Error} />}
      {s && overview.data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Figure label="Readers offline" value={s.readersOffline} hint={`of ${s.readers} readers and controllers`} bad={s.readersOffline > 0} good={s.readers > 0} />
            <Figure label="Doors forced or held open" value={s.doorAlarms} hint={`${s.doorsOpen} of ${s.doors} doors open`} bad={s.doorAlarms > 0} good={s.doors > 0} />
            <Figure label="Tamper" value={s.tamper} hint="readers or controllers reporting it" bad={s.tamper > 0} good={s.readers > 0} />
            <Figure label="Refused in the last 24 hours" value={s.deniedLastDay} hint="cards, faces or fingers not accepted" />
          </div>
          <Card title="Access systems">
            {overview.data.systems.length === 0 ? (
              <EmptyState
                title="No access systems yet"
                description="Add a Hikvision access controller or terminal, or the Suprema BioStar 2 or Gallagher Command Centre server your readers report to."
                action={can("cameras:write") ? <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => navigate("/access/new")}>Add access system</Button> : undefined}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-ink-muted">
                    <tr>
                      <th scope="col" className="px-4 py-2 font-medium">System</th>
                      <th scope="col" className="px-2 py-2 font-medium">Connection</th>
                      <th scope="col" className="px-2 py-2 font-medium">Readers</th>
                      <th scope="col" className="px-2 py-2 font-medium">Doors</th>
                      <th scope="col" className="px-2 py-2 font-medium">Last 24 hours</th>
                      <th scope="col" className="px-4 py-2 text-right font-medium">Read</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {overview.data.systems.map((a) => (
                      <tr key={a.id}>
                        <td className="px-4 py-2">
                          <Link to={`/access/${a.id}`} className="font-medium hover:underline">{a.name}</Link>
                          <span className="block text-xs text-ink-muted">{a.brandName} · {a.host}{a.location ? ` · ${a.location}` : ""}</span>
                        </td>
                        <td className="px-2 py-2"><ConnectionBadge status={a.connection} monitoringEnabled={a.monitoringEnabled} /></td>
                        <td className="px-2 py-2 tabular">
                          {a.points.readers}
                          {a.points.readersOffline > 0 && <span className="ml-2 font-medium text-warn">{a.points.readersOffline} offline</span>}
                          {a.points.tamper > 0 && <span className="ml-2 font-medium text-bad">{a.points.tamper} tamper</span>}
                        </td>
                        <td className="px-2 py-2 tabular">
                          {a.points.doors}
                          {a.points.doorAlarms > 0 && <span className="ml-2 font-medium text-bad">{a.points.doorAlarms} forced / held</span>}
                        </td>
                        <td className="px-2 py-2 tabular text-ink-secondary">
                          {a.lastDay.total} events{a.lastDay.denied > 0 && <span className="text-bad"> · {a.lastDay.denied} refused</span>}
                        </td>
                        <td className="px-4 py-2 text-right text-xs text-ink-muted" title={a.accessError ?? (a.readAt ? absoluteTime(a.readAt) : undefined)}>
                          {a.accessError ? <span className="text-warn">Not read</span> : a.readAt ? relativeTime(a.readAt) : "Not yet"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          {overview.data.systems.length > 0 && <AccessEvents />}
        </>
      )}
    </div>
  );
}

/** Access events, newest first, with filters; of one system when `systemId` is given. */
function AccessEvents({ systemId }: { systemId?: string }) {
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const query = { systemId, category: category === "problems" ? undefined : category, problems: category === "problems" ? "true" : undefined, search: search.trim() || undefined, limit: 200 };
  const events = useQuery({
    queryKey: ["access-events", query],
    queryFn: () => api<AccessEventRow[]>(`/access/events${toQuery(query)}`),
    refetchInterval: 30_000,
  });
  return (
    <Card
      title="Access events"
      actions={
        <div className="flex flex-wrap gap-2">
          <Select aria-label="Filter events" className="w-40" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All events</option>
            <option value="problems">Problems only</option>
            <option value="granted">Granted</option>
            <option value="denied">Denied</option>
            <option value="door">Doors</option>
            <option value="tamper">Tamper</option>
            <option value="alarm">Alarms</option>
            <option value="fault">Faults</option>
          </Select>
          <Input aria-label="Search events" placeholder="Person, door or reader" value={search} onChange={(e) => setSearch(e.target.value)} className="w-48" />
        </div>
      }
    >
      {events.isLoading ? (
        <div className="p-4"><Spinner /></div>
      ) : events.error ? (
        <div className="p-4"><ErrorMessage error={events.error as Error} /></div>
      ) : !events.data?.length ? (
        <EmptyState title="No events" description={category || search ? "Nothing matches these filters." : "Events appear after the next check."} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-ink-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">Time</th>
                <th scope="col" className="px-2 py-2 font-medium">Type</th>
                <th scope="col" className="px-2 py-2 font-medium">Event</th>
                <th scope="col" className="px-2 py-2 font-medium">Person</th>
                <th scope="col" className="px-2 py-2 font-medium">Door or reader</th>
                {!systemId && <th scope="col" className="px-4 py-2 font-medium">System</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {events.data.map((e) => (
                <tr key={e.id}>
                  <td className="whitespace-nowrap px-4 py-1.5 tabular text-ink-secondary" title={absoluteTime(e.occurredAt)}>{new Date(e.occurredAt).toLocaleString()}</td>
                  <td className={clsx("px-2 py-1.5 font-medium", e.category === "door" && DOOR_ALARM.test(e.description) ? "text-bad" : CATEGORY[e.category].tone)}>{CATEGORY[e.category].label}</td>
                  <td className="px-2 py-1.5">{e.description}</td>
                  <td className="px-2 py-1.5 text-ink-secondary">{e.person ?? "—"}</td>
                  <td className="px-2 py-1.5 text-ink-secondary">{e.point ?? "—"}</td>
                  {!systemId && <td className="px-4 py-1.5"><Link to={`/access/${e.systemId}`} className="text-ink-secondary hover:underline">{e.systemName}</Link></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** One access system: its state, readers and doors, alerts and events. */
export function AccessDetailPage() {
  const { id = "" } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const system = useQuery({ queryKey: ["camera", id], queryFn: () => api<CameraDetail>(`/cameras/${id}`), refetchInterval: 30_000 });
  const points = useQuery({ queryKey: ["access-points", id], queryFn: () => api<AccessPointRow[]>(`/access/${id}/points`), refetchInterval: 30_000 });
  const alerts = useQuery({ queryKey: ["alerts", "camera", id], queryFn: () => api<Page<Alert>>(`/alerts?cameraId=${id}&status=open&pageSize=50`) });
  const checkNow = useCheckNow();
  const testConn = useTestSavedCamera();
  const remove = useRemoveCameras();
  const [testResult, setTestResult] = useState<ConnectionResult | null>(null);
  const [removing, setRemoving] = useState(false);

  if (system.isLoading) return <Spinner label="Loading access system" />;
  if (system.error) return <ErrorMessage error={system.error as Error} />;
  const c = system.data!;
  const s = c.status;
  const readers = points.data?.filter((p) => p.kind !== "door") ?? [];
  const doors = points.data?.filter((p) => p.kind === "door") ?? [];

  return (
    <div className="space-y-4">
      <Link to="/access" className="inline-flex items-center gap-1 text-sm text-ink-secondary hover:text-ink"><ArrowLeft className="h-4 w-4" /> Access control</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{c.name}</h1>
          <p className="text-sm text-ink-secondary">{c.host}:{c.port} · {c.brandName}{c.location ? ` · ${c.location}` : ""}</p>
          <div className="mt-2"><ConnectionBadge status={s.connection} monitoringEnabled={c.monitoringEnabled} /></div>
        </div>
        <div className="flex flex-wrap gap-2">
          {can("cameras:check") && (
            <>
              <Button variant="primary" icon={<RefreshCw className={clsx("h-4 w-4", checkNow.isPending && "animate-spin")} />} disabled={checkNow.isPending} onClick={() => checkNow.mutate(c.id, { onSuccess: () => void points.refetch() })}>
                {checkNow.isPending ? "Reading…" : "Refresh now"}
              </Button>
              <Button icon={<PlugZap className="h-4 w-4" />} loading={testConn.isPending} onClick={() => testConn.mutate({ id: c.id }, { onSuccess: setTestResult })}>Test connection</Button>
            </>
          )}
          {can("cameras:write") && (
            <>
              <Button icon={<Pencil className="h-4 w-4" />} onClick={() => navigate(`/access/${c.id}/edit`)}>Edit</Button>
              <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => setRemoving(true)}>Remove</Button>
            </>
          )}
        </div>
      </div>

      {(s.lastErrorMessage || s.access.error) && (
        <div className="rounded-md border border-line bg-surface px-4 py-3 text-sm">
          {s.lastErrorMessage && <p><span className="font-medium">Last check:</span> <span className="text-ink-secondary">{s.lastErrorMessage}</span></p>}
          {s.access.error && <p><span className="font-medium">Readers and doors:</span> <span className="text-ink-secondary">{s.access.error}</span></p>}
        </div>
      )}

      {(alerts.data?.items.length ?? 0) > 0 && (
        <Card title="Open alerts">
          <ul className="divide-y divide-line">
            {alerts.data!.items.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                <SeverityBadge severity={a.severity} />
                <Link to="/alerts" className="font-medium hover:underline">{a.title}</Link>
                <span className="text-ink-secondary">{a.description}</span>
                <span className="ml-auto text-xs text-ink-muted" title={absoluteTime(a.firstDetectedAt)}>{relativeTime(a.firstDetectedAt)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={`Readers and controllers (${readers.length})`} actions={s.access.readAt && <span className="text-xs text-ink-muted" title={absoluteTime(s.access.readAt)}>Read {relativeTime(s.access.readAt)}</span>}>
          {points.isLoading ? <div className="p-4"><Spinner /></div> : readers.length === 0 ? (
            <EmptyState title="No readers read yet" description="They are read at each check: press Refresh now." />
          ) : (
            <ul className="divide-y divide-line">
              {readers.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{p.name}</span>
                    <span className="block text-xs text-ink-muted">{[p.kind === "controller" ? "Controller" : "Reader", p.model, p.statusText].filter(Boolean).join(" · ")}</span>
                  </span>
                  {p.tamper && <Pill tone="bad" icon={ShieldAlert} label="Tamper" />}
                  {p.online === true ? <Pill tone="good" icon={CheckCircle2} label="Online" /> : p.online === false ? <Pill tone="bad" icon={WifiOff} label="Offline" /> : <Pill tone="unknown" icon={CircleHelp} label="Not reported" />}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={`Doors (${doors.length})`}>
          {points.isLoading ? <div className="p-4"><Spinner /></div> : doors.length === 0 ? (
            <EmptyState title="No doors" description="This system reports no doors (or none read yet)." />
          ) : (
            <ul className="divide-y divide-line">
              {doors.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{p.name}</span>
                    {p.statusText && <span className="block text-xs text-ink-muted">{p.statusText}</span>}
                  </span>
                  {p.tamper && <Pill tone="bad" icon={ShieldAlert} label="Tamper" />}
                  {p.lockState && <Pill tone={p.lockState === "locked" ? "good" : "warn"} icon={p.lockState === "locked" ? Lock : LockOpen} label={p.lockState === "locked" ? "Locked" : "Unlocked"} />}
                  <DoorPill state={p.doorState} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <AccessEvents systemId={c.id} />

      <Dialog open={!!testResult} onClose={() => setTestResult(null)} title={`Connection test: ${c.name}`}>
        {testResult && <Diagnostics result={testResult} />}
      </Dialog>
      <RemoveCamerasDialog
        open={removing}
        names={[c.name]}
        loading={remove.isPending}
        onCancel={() => setRemoving(false)}
        onConfirm={() => remove.mutate([c.id], { onSuccess: () => navigate("/access") })}
      />
    </div>
  );
}

function DoorPill({ state }: { state: AccessPointRow["doorState"] }) {
  if (state === "forced") return <Pill tone="bad" icon={AlertTriangle} label="Forced open" />;
  if (state === "held_open") return <Pill tone="warn" icon={AlertTriangle} label="Held open" />;
  if (state === "open") return <Pill tone="warn" icon={DoorOpen} label="Open" />;
  if (state === "closed") return <Pill tone="good" icon={DoorClosed} label="Closed" />;
  return <Pill tone="unknown" icon={CircleHelp} label="Not reported" />;
}

function Figure({ label, value, hint, bad, good }: { label: string; value: number; hint?: string; bad?: boolean; good?: boolean }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={clsx("mt-1 text-2xl font-semibold tabular", bad ? "text-red-700 dark:text-red-400" : good ? "text-green-700 dark:text-green-400" : "")}>{value}</div>
      {hint && <div className="text-xs text-ink-muted">{hint}</div>}
    </div>
  );
}
