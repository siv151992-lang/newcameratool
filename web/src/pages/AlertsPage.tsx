import { useMutation, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { BellOff, Check, CheckCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, toQuery } from "../api/client";
import type { Alert, AlertDetail, Page } from "../api/types";
import { SeverityBadge, CriticalAreaBadge } from "../components/status";
import { Button, Dialog, EmptyState, ErrorMessage, Field, Input, PageHeader, Pagination, Select, Spinner } from "../components/ui";
import { useToast } from "../components/toast";
import { useAuth } from "../hooks/auth";
import { useInvalidateCameras } from "../hooks/cameras";
import { ALERT_TYPE_LABELS, formatDateTime, relativeTime } from "../lib/format";

/** A colored edge per severity, so the list can be scanned at a glance. */
const SEVERITY_EDGE: Record<string, string> = { critical: "border-l-bad", warning: "border-l-warn", info: "border-l-accent" };
const STATUS_LABEL: Record<string, string> = { active: "Active", acknowledged: "Acknowledged", resolved: "Resolved" };
const STATUS_STYLE: Record<string, string> = {
  active: "bg-bad/15 text-ink",
  acknowledged: "bg-warn/20 text-ink",
  resolved: "bg-good/15 text-ink",
};

const TABS = [
  { key: "open", label: "Open" },
  { key: "active", label: "Active" },
  { key: "acknowledged", label: "Acknowledged" },
  { key: "resolved", label: "Resolved" },
  { key: "all", label: "All" },
];

export function AlertsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const invalidate = useInvalidateCameras();
  const [status, setStatus] = useState("open");
  const [severity, setSeverity] = useState("");
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<{ alert: Alert; kind: "acknowledge" | "resolve" } | null>(null);
  // Bulk: the alerts ticked on this page, or every alert matching the filters.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [bulk, setBulk] = useState<"acknowledge" | "resolve" | null>(null);
  const [note, setNote] = useState("");
  const [detailId, setDetailId] = useState<number | null>(null);

  const alerts = useQuery({
    queryKey: ["alerts", status, severity, type, page],
    queryFn: () => api<Page<Alert>>(`/alerts${toQuery({ status, severity, type, page, pageSize: 25 })}`),
    refetchInterval: 30_000,
  });
  // Another page or other filters: start the selection over.
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, [status, severity, type, page]);
  const manage = can("alerts:manage");
  const selectable = (alerts.data?.items ?? []).filter((a) => a.status !== "resolved");
  const pageAllSelected = selectable.length > 0 && selectable.every((a) => selected.has(a.id));
  const toggle = (id: number) => {
    setAllMatching(false);
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const togglePage = () => {
    setAllMatching(false);
    setSelected(pageAllSelected ? new Set() : new Set(selectable.map((a) => a.id)));
  };
  const chosen = alerts.data?.items.filter((a) => selected.has(a.id)) ?? [];
  const count = allMatching ? (alerts.data?.total ?? 0) : chosen.length;
  // "Acknowledge" applies to active alerts only; "Resolve" to every open one.
  const canAcknowledge = allMatching ? status !== "acknowledged" : chosen.some((a) => a.status === "active");

  const bulkMutation = useMutation({
    mutationFn: (kind: "acknowledge" | "resolve") =>
      api<{ done: number; skipped: number }>("/alerts/bulk", {
        method: "POST",
        body: {
          action: kind,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(allMatching
            ? { filter: { status: status === "resolved" || status === "all" ? "open" : status, ...(severity ? { severity } : {}), ...(type ? { type } : {}) } }
            : { ids: [...selected].map(String) }),
        },
      }),
    onSuccess: (r, kind) => {
      toast("success", `${r.done} alert${r.done === 1 ? "" : "s"} ${kind === "acknowledge" ? "acknowledged" : "resolved"}${r.skipped ? ` (${r.skipped} already ${kind === "acknowledge" ? "acknowledged" : "closed"})` : ""}`);
      setBulk(null);
      setNote("");
      setSelected(new Set());
      setAllMatching(false);
      invalidate();
    },
    onError: (e: Error) => toast("error", e.message),
  });

  const detail = useQuery({ queryKey: ["alerts", "detail", detailId], queryFn: () => api<AlertDetail>(`/alerts/${detailId}`), enabled: detailId !== null });

  const mutate = useMutation({
    mutationFn: () => api<AlertDetail>(`/alerts/${action!.alert.id}/${action!.kind}`, { method: "POST", body: note.trim() ? { note: note.trim() } : {} }),
    onSuccess: () => {
      toast("success", action!.kind === "acknowledge" ? "Alert acknowledged" : "Alert resolved");
      setAction(null);
      setNote("");
      invalidate();
    },
    onError: (e: Error) => toast("error", e.message),
  });

  return (
    <>
      <PageHeader title="Alert center" description="Recurring problems are grouped into one alert per camera and type, and resolve automatically when the condition clears." />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Alert status" className="flex flex-wrap rounded-md border border-line-strong bg-surface p-0.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={status === t.key}
              onClick={() => {
                setStatus(t.key);
                setPage(1);
              }}
              className={clsx("rounded px-3 py-1.5 text-sm font-medium", status === t.key ? "bg-accent-soft/70 text-ink" : "text-ink-secondary hover:text-ink")}
            >
              {t.label}
            </button>
          ))}
        </div>
        <Select aria-label="Filter by severity" className="w-auto" value={severity} onChange={(e) => { setSeverity(e.target.value); setPage(1); }}>
          <option value="">All severities</option>
          <option value="critical">Critical</option>
          <option value="warning">Warning</option>
        </Select>
        <Select aria-label="Filter by type" className="w-auto" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
          <option value="">All types</option>
          {Object.entries(ALERT_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </div>

      {manage && count > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-accent/40 bg-accent-soft/40 px-4 py-2 text-sm" role="region" aria-label="Selected alerts">
          <span className="font-medium">{count} alert{count === 1 ? "" : "s"} selected</span>
          {pageAllSelected && !allMatching && (alerts.data?.total ?? 0) > selectable.length && status !== "resolved" && (
            <Button size="sm" variant="ghost" onClick={() => setAllMatching(true)}>Select all {alerts.data!.total} matching alerts</Button>
          )}
          {allMatching && <span className="text-ink-secondary">(every alert matching these filters, on all pages)</span>}
          <span className="ml-auto flex flex-wrap gap-2">
            <Button size="sm" variant="primary" icon={<Check className="h-4 w-4" />} disabled={!canAcknowledge} title={canAcknowledge ? undefined : "Only active alerts can be acknowledged"} onClick={() => setBulk("acknowledge")}>
              Acknowledge
            </Button>
            <Button size="sm" icon={<CheckCheck className="h-4 w-4" />} onClick={() => setBulk("resolve")}>Resolve</Button>
            <Button size="sm" variant="ghost" icon={<X className="h-4 w-4" />} onClick={() => { setSelected(new Set()); setAllMatching(false); }}>Clear</Button>
          </span>
        </div>
      )}

      <section className="rounded-lg border border-line bg-surface">
        {alerts.isLoading ? (
          <Spinner label="Loading alerts" />
        ) : alerts.error ? (
          <div className="p-4"><ErrorMessage error={alerts.error} /></div>
        ) : !alerts.data?.items.length ? (
          <EmptyState icon={<BellOff className="h-8 w-8" />} title={status === "open" ? "No open alerts" : "No alerts match"} description={status === "open" ? "All monitored cameras are within their thresholds." : undefined} />
        ) : (
          <div className={clsx("overflow-x-auto", alerts.isFetching && "opacity-80")}>
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line bg-raised/60 text-xs uppercase tracking-wide text-ink-secondary">
                <tr>
                  {manage && (
                    <th scope="col" className="w-10 py-2.5 pl-4 pr-1">
                      <input type="checkbox" className="h-4 w-4 align-middle" aria-label="Select all alerts on this page" checked={pageAllSelected || allMatching} disabled={!selectable.length} onChange={togglePage} />
                    </th>
                  )}
                  <th scope="col" className={clsx("py-2.5 pr-2 font-medium", manage ? "pl-2" : "pl-4")}>Severity</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">Camera</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">Problem</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">Detected</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">Last seen</th>
                  <th scope="col" className="px-2 py-2.5 font-medium">Status</th>
                  {manage && <th scope="col" className="py-2.5 pl-2 pr-4 text-right font-medium">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {alerts.data.items.map((a) => (
                  <tr key={a.id} className={clsx("border-b border-line align-top last:border-0 hover:bg-page/50", (allMatching || selected.has(a.id)) && "bg-accent-soft/30")}>
                    {manage && (
                      <td className={clsx("border-l-4 py-2.5 pl-3 pr-1", SEVERITY_EDGE[a.severity] ?? "border-l-line")}>
                        {a.status !== "resolved" && (
                          <input type="checkbox" className="mt-1 h-4 w-4" aria-label={`Select alert: ${a.title} on ${a.cameraName}`} checked={allMatching || selected.has(a.id)} onChange={() => toggle(a.id)} />
                        )}
                      </td>
                    )}
                    <td className={clsx("py-2.5 pr-2", manage ? "pl-2" : clsx("border-l-4 pl-3", SEVERITY_EDGE[a.severity] ?? "border-l-line"))}>
                      <SeverityBadge severity={a.severity} />
                    </td>
                    <td className="min-w-[170px] px-2 py-2.5">
                      {a.cameraRemoved ? (
                        <span>{a.cameraName} <span className="text-xs text-ink-muted">(removed)</span></span>
                      ) : (
                        <Link to={`/cameras/${a.cameraId}`} className="font-semibold hover:underline">{a.cameraName}</Link>
                      )}
                      <div className="tabular text-xs text-ink-muted">{a.cameraHost}</div>
                      {a.cameraPriority === "critical" && <div className="mt-1"><CriticalAreaBadge /></div>}
                    </td>
                    <td className="min-w-[260px] max-w-lg px-2 py-2.5">
                      <button className="group block text-left" onClick={() => setDetailId(a.id)}>
                        <span className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">{ALERT_TYPE_LABELS[a.type] ?? a.type}</span>
                        <span className="block font-semibold group-hover:underline">{a.title}</span>
                        <span className="line-clamp-1 text-xs text-ink-secondary" title={a.description}>{a.description}</span>
                      </button>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5">
                      <div className="tabular">{formatDateTime(a.firstDetectedAt)}</div>
                      <div className="text-xs text-ink-muted">{relativeTime(a.firstDetectedAt)}</div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5">
                      <div className="tabular">{formatDateTime(a.lastSeenAt)}</div>
                      <div className="text-xs text-ink-muted">
                        {relativeTime(a.lastSeenAt)}
                        {a.occurrenceCount > 1 && ` · seen ${a.occurrenceCount}×`}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-2 py-2.5">
                      <span className={clsx("inline-flex rounded-full px-2 py-0.5 text-xs font-medium", STATUS_STYLE[a.status])}>{STATUS_LABEL[a.status] ?? a.status}</span>
                      {a.acknowledgedBy && a.status === "acknowledged" && <div className="mt-0.5 text-xs text-ink-muted">by {a.acknowledgedBy}</div>}
                      {a.status === "resolved" && (
                        <div className="mt-0.5 text-xs text-ink-muted">
                          {a.resolvedBy ? `by ${a.resolvedBy}` : "automatically"}
                          {a.resolvedAt && <span className="tabular block">{formatDateTime(a.resolvedAt)}</span>}
                        </div>
                      )}
                    </td>
                    {can("alerts:manage") && (
                      <td className="whitespace-nowrap py-2.5 pl-2 pr-4 text-right">
                        <div className="inline-flex gap-1">
                          {a.status === "active" && (
                            <Button size="sm" icon={<Check className="h-4 w-4" />} onClick={() => setAction({ alert: a, kind: "acknowledge" })} title="Seen and being handled: stays open until the problem clears">
                              Acknowledge
                            </Button>
                          )}
                          {a.status !== "resolved" && (
                            <Button size="sm" variant="ghost" icon={<CheckCheck className="h-4 w-4" />} onClick={() => setAction({ alert: a, kind: "resolve" })} title="Close the alert now">
                              Resolve
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {alerts.data && alerts.data.total > 0 && (
          <div className="border-t border-line"><Pagination page={page} pageSize={25} total={alerts.data.total} onPage={setPage} /></div>
        )}
      </section>

      <Dialog
        open={!!action}
        onClose={() => setAction(null)}
        title={action?.kind === "acknowledge" ? "Acknowledge alert" : "Resolve alert"}
        footer={
          <>
            <Button onClick={() => setAction(null)}>Cancel</Button>
            <Button variant="primary" loading={mutate.isPending} onClick={() => mutate.mutate()}>
              {action?.kind === "acknowledge" ? "Acknowledge" : "Resolve"}
            </Button>
          </>
        }
      >
        <p className="mb-3">
          <strong>{action?.alert.title}</strong> — {action?.alert.cameraName}
        </p>
        <p className="mb-3 text-ink-secondary">
          {action?.kind === "acknowledge"
            ? "Acknowledging marks the alert as seen. It stays open until the condition clears, and becomes active again if it gets worse."
            : "Resolving closes the alert now. If the condition is still present at the next check, a new alert is opened."}
        </p>
        <Field label="Note (optional)">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}</Field>
      </Dialog>

      <Dialog
        open={!!bulk}
        onClose={() => setBulk(null)}
        title={bulk === "acknowledge" ? `Acknowledge ${count} alert${count === 1 ? "" : "s"}` : `Resolve ${count} alert${count === 1 ? "" : "s"}`}
        footer={
          <>
            <Button onClick={() => setBulk(null)}>Cancel</Button>
            <Button variant="primary" loading={bulkMutation.isPending} onClick={() => bulk && bulkMutation.mutate(bulk)}>
              {bulk === "acknowledge" ? "Acknowledge" : "Resolve"} {count}
            </Button>
          </>
        }
      >
        <p className="mb-3 text-ink-secondary">
          {bulk === "acknowledge"
            ? "Acknowledging marks them as seen. Each stays open until its condition clears, and becomes active again if it gets worse. Alerts already acknowledged are left as they are."
            : "Resolving closes them now. A condition still present at the next check opens a new alert."}
          {allMatching && " This applies to every alert matching the current filters, on all pages."}
        </p>
        <Field label="Note (optional)">{(id) => <Input id={id} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}</Field>
      </Dialog>

      <Dialog open={detailId !== null} onClose={() => setDetailId(null)} title="Alert details" size="lg">
        {detail.isLoading ? (
          <Spinner />
        ) : detail.data ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={detail.data.severity} />
              <span className="font-semibold">{detail.data.title}</span>
              <span className="capitalize text-ink-muted">· {detail.data.status}</span>
            </div>
            <p>{detail.data.description}</p>
            <p className="text-ink-secondary">{detail.data.cameraName} ({detail.data.cameraHost})</p>
            <h3 className="pt-2 font-semibold">History</h3>
            <ol className="space-y-1.5">
              {detail.data.events.map((e, i) => (
                <li key={i} className="flex gap-3">
                  <span className="tabular w-40 shrink-0 text-xs text-ink-muted">{formatDateTime(e.createdAt)}</span>
                  <span>
                    <span className="font-medium capitalize">{e.eventType.replace("_", " ")}</span>
                    {e.actor && <span className="text-ink-secondary"> by {e.actor}</span>}
                    {e.message && <span className="block text-xs text-ink-secondary">{e.message}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <ErrorMessage error={detail.error} />
        )}
      </Dialog>
    </>
  );
}
