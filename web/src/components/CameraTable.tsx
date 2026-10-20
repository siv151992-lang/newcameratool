import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Camera as CameraIcon, Eye, Pause, Pencil, Play, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, toQuery } from "../api/client";
import type { Brand, Camera, Page } from "../api/types";
import { useAuth } from "../hooks/auth";
import { useCheckNow, useRemoveCameras, useSetMonitoring } from "../hooks/cameras";
import { absoluteTime, ERROR_LABELS, errorCategory, formatBytes, relativeTime } from "../lib/format";
import { RemoveCamerasDialog } from "./RemoveCamerasDialog";
import { ConnectionBadge, HealthBadge, RecordingBadge, UsageMeter } from "./status";
import { Button, EmptyState, ErrorMessage, Input, Pagination, Select, Spinner } from "./ui";

type SortKey = "name" | "host" | "brand" | "location" | "connection" | "health" | "recording" | "usage" | "lastSuccess";

const USAGE_FILTERS: Record<string, { minUsage?: number; maxUsage?: number; label: string }> = {
  "": { label: "Any usage" },
  lt50: { maxUsage: 50, label: "Below 50%" },
  "50to80": { minUsage: 50, maxUsage: 80, label: "50–80%" },
  gte80: { minUsage: 80, label: "80% or more" },
  gte90: { minUsage: 90, label: "90% or more" },
};

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function SortHeader({ label, k, sort, order, onSort, className }: { label: string; k: SortKey; sort: SortKey; order: "asc" | "desc"; onSort: (k: SortKey) => void; className?: string }) {
  const active = sort === k;
  return (
    <th scope="col" aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"} className={clsx("whitespace-nowrap px-3 py-2 font-medium", className)}>
      <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => onSort(k)}>
        {label}
        {active && (order === "asc" ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
      </button>
    </th>
  );
}

function IconAction({ label, onClick, children, disabled, to }: { label: string; onClick?: () => void; children: ReactNode; disabled?: boolean; to?: string }) {
  const cls = "inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-secondary hover:bg-line/60 hover:text-ink disabled:opacity-40";
  if (to) {
    return (
      <Link to={to} className={cls} aria-label={label} title={label}>
        {children}
      </Link>
    );
  }
  return (
    <button className={cls} onClick={onClick} disabled={disabled} aria-label={label} title={label}>
      {children}
    </button>
  );
}

export function CameraTable({ initialStatus = "", initialRecording = "", title }: { initialStatus?: string; initialRecording?: string; title?: ReactNode }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [brand, setBrand] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [location, setLocation] = useState("");
  const [usage, setUsage] = useState("");
  const [recording, setRecording] = useState(initialRecording);
  const [sort, setSort] = useState<SortKey>("name");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<Camera[] | null>(null);
  const debouncedSearch = useDebounced(search);
  const pageSize = 25;

  useEffect(() => setPage(1), [debouncedSearch, brand, status, location, usage, recording]);

  const { minUsage, maxUsage } = USAGE_FILTERS[usage] ?? {};
  const params = { search: debouncedSearch, brand, status, location, minUsage, maxUsage, recording, sort, order, page, pageSize };
  const cameras = useQuery({
    queryKey: ["cameras", params],
    queryFn: () => api<Page<Camera>>(`/cameras${toQuery(params)}`),
    refetchInterval: 30_000,
  });
  const brands = useQuery({ queryKey: ["brands"], queryFn: () => api<Brand[]>("/brands"), staleTime: 300_000 });
  const locations = useQuery({ queryKey: ["cameras", "locations"], queryFn: () => api<string[]>("/cameras/locations"), staleTime: 60_000 });

  const checkNow = useCheckNow();
  const setMonitoring = useSetMonitoring();
  const remove = useRemoveCameras();

  const onSort = (k: SortKey) => {
    if (sort === k) setOrder(order === "asc" ? "desc" : "asc");
    else {
      setSort(k);
      setOrder(k === "usage" || k === "health" || k === "recording" ? "desc" : "asc");
    }
  };

  const items = cameras.data?.items ?? [];
  const allSelected = items.length > 0 && items.every((c) => selected.has(c.id));
  const toggleAll = () => {
    const next = new Set(selected);
    if (allSelected) items.forEach((c) => next.delete(c.id));
    else items.forEach((c) => next.add(c.id));
    setSelected(next);
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const filtered = !!(debouncedSearch || brand || status || location || usage || recording);
  const canWrite = can("cameras:write");

  return (
    <section className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
        {title && <h2 className="mr-2 text-sm font-semibold">{title}</h2>}
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-muted" aria-hidden />
          <Input
            type="search"
            placeholder="Search name, IP, location…"
            aria-label="Search cameras"
            className="pl-8"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select aria-label="Filter by brand" className="w-auto" value={brand} onChange={(e) => setBrand(e.target.value)}>
          <option value="">All brands</option>
          {brands.data?.filter((b) => b.supportStatus !== "planned" || b.cameraCount > 0).map((b) => (
            <option key={b.key} value={b.key}>
              {b.displayName}
            </option>
          ))}
        </Select>
        <Select aria-label="Filter by status" className="w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <optgroup label="Connection">
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="unknown">Unknown</option>
            <option value="disabled">Monitoring disabled</option>
          </optgroup>
          <optgroup label="Storage health">
            <option value="healthy">Healthy</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </optgroup>
        </Select>
        <Select aria-label="Filter by location" className="w-auto" value={location} onChange={(e) => setLocation(e.target.value)}>
          <option value="">All locations</option>
          {locations.data?.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </Select>
        <Select aria-label="Filter by recording status" className="w-auto" value={recording} onChange={(e) => setRecording(e.target.value)}>
          <option value="">Any recording status</option>
          <option value="recording">Recording</option>
          <option value="idle">Not recording</option>
          <option value="error">Recording error</option>
          <option value="unknown">Recording unknown</option>
        </Select>
        <Select aria-label="Filter by storage usage" className="w-auto" value={usage} onChange={(e) => setUsage(e.target.value)}>
          {Object.entries(USAGE_FILTERS).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
        {canWrite && selected.size > 0 && (
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 className="h-4 w-4" />}
            onClick={() => setRemoving(items.filter((c) => selected.has(c.id)))}
          >
            Remove {selected.size} selected
          </Button>
        )}
      </div>

      {cameras.isLoading ? (
        <Spinner label="Loading cameras" />
      ) : cameras.error ? (
        <div className="p-4">
          <ErrorMessage error={cameras.error} />
        </div>
      ) : items.length === 0 ? (
        filtered ? (
          <EmptyState title="No cameras match these filters" description="Try clearing the search or filters." />
        ) : (
          <EmptyState
            icon={<CameraIcon className="h-8 w-8" />}
            title="No cameras registered yet"
            description="Add a camera with its IP address and credentials, or import several from a CSV file."
            action={
              canWrite && (
                <div className="flex gap-2">
                  <Button variant="primary" onClick={() => navigate("/cameras/new")}>
                    Add camera
                  </Button>
                  <Button onClick={() => navigate("/cameras/import")}>Import CSV</Button>
                </div>
              )
            }
          />
        )
      ) : (
        <div className={clsx("overflow-x-auto transition-opacity", cameras.isFetching && !cameras.isLoading && "opacity-80")}>
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-ink-secondary">
              <tr>
                {canWrite && (
                  <th scope="col" className="w-10 px-3 py-2">
                    <input type="checkbox" aria-label="Select all cameras on this page" checked={allSelected} onChange={toggleAll} />
                  </th>
                )}
                <SortHeader label="Camera" k="name" sort={sort} order={order} onSort={onSort} />
                <SortHeader label="IP address" k="host" sort={sort} order={order} onSort={onSort} />
                <SortHeader label="Brand" k="brand" sort={sort} order={order} onSort={onSort} />
                <SortHeader label="Location" k="location" sort={sort} order={order} onSort={onSort} />
                <SortHeader label="Connection" k="connection" sort={sort} order={order} onSort={onSort} />
                <SortHeader label="Recording" k="recording" sort={sort} order={order} onSort={onSort} />
                <SortHeader label="Storage health" k="health" sort={sort} order={order} onSort={onSort} />
                <SortHeader label="Usage" k="usage" sort={sort} order={order} onSort={onSort} />
                <th scope="col" className="px-3 py-2 text-right font-medium">Total</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Used</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Available</th>
                <SortHeader label="Last success" k="lastSuccess" sort={sort} order={order} onSort={onSort} />
                <th scope="col" className="px-3 py-2 font-medium">Last error</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => {
                const s = c.status;
                return (
                  <tr key={c.id} className="border-b border-line last:border-0 hover:bg-page/60">
                    {canWrite && (
                      <td className="px-3 py-2">
                        <input type="checkbox" aria-label={`Select ${c.name}`} checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                      </td>
                    )}
                    <td className="min-w-[180px] px-3 py-2">
                      <Link to={`/cameras/${c.id}`} className="font-medium text-ink hover:text-accent-ink hover:underline">
                        {c.name}
                      </Link>
                      <div className="text-xs text-ink-muted">{c.model ?? "Model unknown"}</div>
                    </td>
                    <td className="tabular whitespace-nowrap px-3 py-2 text-ink-secondary">
                      {c.host}
                      {c.port !== (c.protocol === "https" ? 443 : 80) && `:${c.port}`}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-secondary">{c.brandName}</td>
                    <td className="min-w-[110px] px-3 py-2 text-ink-secondary">{c.location ?? "—"}</td>
                    <td className="px-3 py-2">
                      <ConnectionBadge status={s.connection} monitoringEnabled={c.monitoringEnabled} />
                    </td>
                    <td className="px-3 py-2">
                      <RecordingBadge state={s.recording.state} detail={s.recording.detail} />
                    </td>
                    <td className="px-3 py-2">
                      <HealthBadge health={s.storageHealth} />
                    </td>
                    <td className="px-3 py-2">
                      <UsageMeter percent={s.usedPercentage} warning={c.warningThreshold ?? undefined} critical={c.criticalThreshold ?? undefined} compact />
                    </td>
                    <td className="tabular whitespace-nowrap px-3 py-2 text-right">{formatBytes(s.totalBytes)}</td>
                    <td className="tabular whitespace-nowrap px-3 py-2 text-right">{formatBytes(s.usedBytes)}</td>
                    <td className="tabular whitespace-nowrap px-3 py-2 text-right">{formatBytes(s.freeBytes)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-ink-secondary" title={absoluteTime(s.lastSuccessAt)}>
                      {relativeTime(s.lastSuccessAt)}
                    </td>
                    <td className="max-w-[220px] px-3 py-2">
                      {s.lastErrorCode ? (
                        <span title={s.lastErrorMessage ?? undefined} className="block truncate text-xs">
                          <span className="font-medium text-ink">{errorCategory(s.lastErrorCode)}:</span>{" "}
                          <span className="text-ink-secondary">{ERROR_LABELS[s.lastErrorCode] ?? s.lastErrorCode}</span>
                        </span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-right">
                      <IconAction label={`View ${c.name}`} to={`/cameras/${c.id}`}>
                        <Eye className="h-4 w-4" />
                      </IconAction>
                      {can("cameras:check") && (
                        <IconAction
                          label={`Check storage now for ${c.name}`}
                          disabled={s.checkInProgress || (checkNow.isPending && checkNow.variables === c.id)}
                          onClick={() => checkNow.mutate(c.id)}
                        >
                          <RefreshCw className={clsx("h-4 w-4", checkNow.isPending && checkNow.variables === c.id && "animate-spin")} />
                        </IconAction>
                      )}
                      {canWrite && (
                        <>
                          <IconAction label={`Edit ${c.name}`} to={`/cameras/${c.id}/edit`}>
                            <Pencil className="h-4 w-4" />
                          </IconAction>
                          <IconAction
                            label={c.monitoringEnabled ? `Disable monitoring for ${c.name}` : `Enable monitoring for ${c.name}`}
                            onClick={() => setMonitoring.mutate({ id: c.id, enabled: !c.monitoringEnabled })}
                          >
                            {c.monitoringEnabled ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                          </IconAction>
                          <IconAction label={`Remove ${c.name}`} onClick={() => setRemoving([c])}>
                            <Trash2 className="h-4 w-4" />
                          </IconAction>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {cameras.data && cameras.data.total > 0 && (
        <div className="border-t border-line">
          <Pagination page={page} pageSize={pageSize} total={cameras.data.total} onPage={setPage} />
        </div>
      )}

      <RemoveCamerasDialog
        open={!!removing}
        names={removing?.map((c) => c.name) ?? []}
        loading={remove.isPending}
        onCancel={() => setRemoving(null)}
        onConfirm={() =>
          remove.mutate(removing!.map((c) => c.id), {
            onSuccess: () => {
              setSelected(new Set());
              setRemoving(null);
            },
          })
        }
      />
    </section>
  );
}
