import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowDown, ArrowUp, Camera as CameraIcon, Download, Eye, HardDrive, HardDriveDownload, Pencil, RefreshCw, Search, ShieldAlert, Trash2, Video } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, toQuery } from "../api/client";
import type { Brand, Camera, Page } from "../api/types";
import { useAuth } from "../hooks/auth";
import { useCheckNow, useDownloadCameraReport, useRemoveCameras, useSetLocalStorage, useSetPriority } from "../hooks/cameras";
import { useColumnVisibility } from "../hooks/columns";
import { absoluteTime, ERROR_LABELS, errorCategory, formatBytes, formatDays, relativeTime } from "../lib/format";
import { ColumnsMenu } from "./ColumnsMenu";
import { LiveViewDialog } from "./LiveView";
import { RemoveCamerasDialog } from "./RemoveCamerasDialog";
import { ConnectionBadge, CriticalAreaBadge, HealthBadge, NoLocalStorageBadge, PasswordBadge, RecordingBadge, UsageMeter } from "./status";
import { Button, EmptyState, ErrorMessage, Input, Pagination, Select, Spinner } from "./ui";

type SortKey = "name" | "host" | "brand" | "location" | "connection" | "health" | "recording" | "usage" | "lastSuccess" | "recordingDays";

const USAGE_FILTERS: Record<string, { minUsage?: number; maxUsage?: number; label: string }> = {
  "": { label: "Any usage" },
  lt50: { maxUsage: 50, label: "Below 50%" },
  "50to80": { minUsage: 50, maxUsage: 80, label: "50–80%" },
  gte80: { minUsage: 80, label: "80% or more" },
  gte90: { minUsage: 90, label: "90% or more" },
};

/**
 * Optional columns, in display order. Camera (name), the selection checkbox and Actions are always
 * shown; these can be hidden from the Columns menu.
 */
interface ColumnDef {
  key: string;
  label: string;
  sortKey?: SortKey;
  align?: "right";
  cellClassName: string;
  render: (c: Camera) => ReactNode;
}

const COLUMNS: ColumnDef[] = [
  { key: "brand", label: "Brand", sortKey: "brand", cellClassName: "min-w-[90px] max-w-[130px] text-ink-secondary", render: (c) => c.brandName },
  { key: "location", label: "Location", sortKey: "location", cellClassName: "min-w-[80px] text-ink-secondary", render: (c) => c.location ?? "—" },
  {
    key: "connection",
    label: "Connection",
    sortKey: "connection",
    cellClassName: "",
    render: (c) => <ConnectionBadge status={c.status.connection} monitoringEnabled={c.monitoringEnabled} />,
  },
  {
    key: "recording",
    label: "Recording",
    sortKey: "recording",
    cellClassName: "whitespace-nowrap",
    render: (c) => {
      if (c.localStorage === false) return <span className="text-ink-muted">—</span>;
      const r = c.status.recording;
      return (
        <>
          <RecordingBadge state={r.state} detail={r.detail} />
          <div className="tabular mt-0.5 text-xs text-ink-secondary" title={r.oldest ? `Oldest recording ${r.oldest.replace("T", " ")} (camera time)` : (r.rangeError ?? undefined)}>
            {r.daysAvailable !== null ? `${r.daysAtLeast ? "≥ " : ""}${formatDays(r.daysAvailable)} stored` : r.rangeError ? "Days not read" : ""}
          </div>
        </>
      );
    },
  },
  {
    key: "password",
    label: "Password",
    cellClassName: "whitespace-nowrap",
    render: (c) => (c.password.status === "unknown" ? <span className="text-ink-muted">—</span> : <PasswordBadge status={c.password.status} title={c.password.changedAt ? `Changed ${relativeTime(c.password.changedAt)}` : undefined} />),
  },
  {
    key: "storage",
    label: "Storage",
    sortKey: "usage",
    cellClassName: "min-w-[170px]",
    render: (c) => {
      if (c.localStorage === false) return <NoLocalStorageBadge />;
      return (
        <>
          <div className="flex items-center gap-2">
            <HealthBadge health={c.status.storageHealth} />
            {c.status.usedPercentage !== null && <span className="tabular text-xs text-ink-secondary">{c.status.usedPercentage.toFixed(1)}%</span>}
          </div>
          {c.status.totalBytes !== null && (
            <>
              <div className="mt-1 max-w-[150px]">
                <UsageMeter percent={c.status.usedPercentage} warning={c.warningThreshold ?? undefined} critical={c.criticalThreshold ?? undefined} compact hideLabel />
              </div>
              <div className="tabular mt-0.5 whitespace-nowrap text-xs text-ink-secondary">
                {formatBytes(c.status.usedBytes)} of {formatBytes(c.status.totalBytes)} · {formatBytes(c.status.freeBytes)} free
              </div>
            </>
          )}
        </>
      );
    },
  },
  {
    key: "lastCheck",
    label: "Last check",
    sortKey: "lastSuccess",
    cellClassName: "max-w-[200px]",
    render: ({ status: s }) => (
      <>
        <div className="whitespace-nowrap text-ink-secondary" title={absoluteTime(s.lastSuccessAt)}>
          {s.lastSuccessAt ? `OK ${relativeTime(s.lastSuccessAt)}` : "Never succeeded"}
        </div>
        {s.lastErrorCode && (
          <div title={s.lastErrorMessage ?? undefined} className="truncate text-xs">
            <span className="font-medium text-ink">{errorCategory(s.lastErrorCode)}:</span>{" "}
            <span className="text-ink-secondary">{ERROR_LABELS[s.lastErrorCode] ?? s.lastErrorCode}</span>
          </div>
        )}
      </>
    ),
  },
];
const COLUMN_KEYS = COLUMNS.map((c) => c.key);

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
    <th scope="col" aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"} className={clsx("whitespace-nowrap px-2 py-2 font-medium", className)}>
      <button className="inline-flex items-center gap-1 hover:text-ink" onClick={() => onSort(k)}>
        {label}
        {active && (order === "asc" ? <ArrowUp className="h-3 w-3" aria-hidden /> : <ArrowDown className="h-3 w-3" aria-hidden />)}
      </button>
    </th>
  );
}

function IconAction({ label, onClick, children, disabled, to }: { label: string; onClick?: () => void; children: ReactNode; disabled?: boolean; to?: string }) {
  const cls = "inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-secondary hover:bg-line/60 hover:text-ink disabled:opacity-40";
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

export function CameraTable({ initialStatus = "", initialRecording = "", initialPassword = "", initialPriority = "", title }: { initialStatus?: string; initialRecording?: string; initialPassword?: string; initialPriority?: string; title?: ReactNode }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [brand, setBrand] = useState("");
  const [status, setStatus] = useState(initialStatus);
  const [location, setLocation] = useState("");
  const [usage, setUsage] = useState("");
  const [recording, setRecording] = useState(initialRecording);
  const [password, setPassword] = useState(initialPassword);
  const [priority, setPriority] = useState(initialPriority);
  const [sort, setSort] = useState<SortKey>("name");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<Camera[] | null>(null);
  const [live, setLive] = useState<Camera | null>(null);
  const setLocalStorage = useSetLocalStorage();
  const setCameraPriority = useSetPriority();
  const debouncedSearch = useDebounced(search);
  const columnVisibility = useColumnVisibility("cctv-camera-columns", COLUMN_KEYS);
  const visibleColumns = COLUMNS.filter((col) => columnVisibility.isVisible(col.key));
  const pageSize = 25;

  useEffect(() => setPage(1), [debouncedSearch, brand, status, location, usage, recording, password, priority]);

  const { minUsage, maxUsage } = USAGE_FILTERS[usage] ?? {};
  const params = { search: debouncedSearch, brand, status, location, minUsage, maxUsage, recording, password, priority, sort, order, page, pageSize };
  const cameras = useQuery({
    queryKey: ["cameras", params],
    queryFn: () => api<Page<Camera>>(`/cameras${toQuery(params)}`),
    refetchInterval: 30_000,
  });
  const brands = useQuery({ queryKey: ["brands"], queryFn: () => api<Brand[]>("/brands"), staleTime: 300_000 });
  const locations = useQuery({ queryKey: ["cameras", "locations"], queryFn: () => api<string[]>("/cameras/locations"), staleTime: 60_000 });

  const checkNow = useCheckNow();
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
  const filtered = !!(debouncedSearch || brand || status || location || usage || recording || password || priority);
  const clearFilters = () => {
    for (const reset of [setSearch, setBrand, setStatus, setLocation, setUsage, setRecording, setPassword, setPriority]) reset("");
  };
  const total = cameras.data?.total ?? 0;
  const [selectingAll, setSelectingAll] = useState(false);
  const report = useDownloadCameraReport();
  /** Selects every camera matching the current filters, across all pages. */
  const selectAllMatching = async () => {
    setSelectingAll(true);
    try {
      const { ids } = await api<{ ids: string[] }>(`/cameras/ids${toQuery({ ...params, page: undefined, pageSize: undefined })}`);
      setSelected(new Set(ids));
    } finally {
      setSelectingAll(false);
    }
  };
  const canWrite = can("cameras:write");

  return (
    <section className="rounded-lg border border-line bg-surface">
      <div className="space-y-2 border-b border-line p-3">
        <div className="flex flex-wrap items-center gap-2">
          {title && <h2 className="mr-2 text-sm font-semibold">{title}</h2>}
          <div className="relative min-w-[200px] flex-1 sm:max-w-md">
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
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {filtered && (
              <Button variant="ghost" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
            <Button
              icon={<Download className="h-4 w-4" />}
              onClick={() => report.download(params)}
              loading={report.downloading}
              disabled={cameras.isSuccess && total === 0}
              title={filtered ? "Status report (CSV) of the cameras matching these filters" : "Status report (CSV) of all cameras"}
            >
              {filtered ? `Download report (${total})` : "Download report"}
            </Button>
            <ColumnsMenu columns={COLUMNS} {...columnVisibility} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-7">
          <Select aria-label="Filter by brand" className="w-full" value={brand} onChange={(e) => setBrand(e.target.value)}>
            <option value="">All brands</option>
            {brands.data?.filter((b) => b.supportStatus !== "planned" || b.cameraCount > 0).map((b) => (
              <option key={b.key} value={b.key}>
                {b.displayName}
              </option>
            ))}
          </Select>
          <Select aria-label="Filter by status" className="w-full" value={status} onChange={(e) => setStatus(e.target.value)}>
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
              <option value="sdproblem">SD card problem</option>
              <option value="sdok">SD card OK</option>
              <option value="nostoragedevice">No SD card detected</option>
              <option value="nolocalstorage">No local storage (records elsewhere)</option>
            </optgroup>
          </Select>
          <Select aria-label="Filter by location" className="w-full" value={location} onChange={(e) => setLocation(e.target.value)}>
            <option value="">All locations</option>
            {locations.data?.map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </Select>
          <Select aria-label="Filter by recording status" className="w-full" value={recording} onChange={(e) => setRecording(e.target.value)}>
            <option value="">Any recording</option>
            <option value="recording">Recording</option>
            <option value="idle">Not recording</option>
            <option value="error">Recording error</option>
            <option value="unknown">Recording unknown</option>
          </Select>
          <Select aria-label="Filter by priority" className="w-full" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="">Any priority</option>
            <option value="critical">Critical areas</option>
            <option value="normal">Normal priority</option>
          </Select>
          <Select aria-label="Filter by camera password" className="w-full" value={password} onChange={(e) => setPassword(e.target.value)}>
            <option value="">Any password</option>
            <option value="ok">Password meets policy</option>
            <option value="weak">Weak password</option>
            <option value="expired">Password change due</option>
          </Select>
          <Select aria-label="Filter by storage usage" className="w-full" value={usage} onChange={(e) => setUsage(e.target.value)}>
            {Object.entries(USAGE_FILTERS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {canWrite && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft/30 px-4 py-2 text-sm">
          <span>{selected.size} selected</span>
          {allSelected && total > selected.size && (
            <Button size="sm" variant="ghost" loading={selectingAll} onClick={() => void selectAllMatching()}>
              Select all {total} matching cameras
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              icon={<ShieldAlert className="h-4 w-4" />}
              loading={setCameraPriority.isPending && setCameraPriority.variables?.priority === "critical"}
              onClick={() => setCameraPriority.mutate({ ids: [...selected], priority: "critical" }, { onSuccess: () => setSelected(new Set()) })}
              title="Cameras in critical areas: listed first, and every problem is raised as critical"
            >
              Critical area
            </Button>
            <Button
              size="sm"
              loading={setCameraPriority.isPending && setCameraPriority.variables?.priority === "normal"}
              onClick={() => setCameraPriority.mutate({ ids: [...selected], priority: "normal" }, { onSuccess: () => setSelected(new Set()) })}
            >
              Normal priority
            </Button>
            <Button
              size="sm"
              icon={<HardDriveDownload className="h-4 w-4" />}
              loading={setLocalStorage.isPending && setLocalStorage.variables?.localStorage === false}
              onClick={() => setLocalStorage.mutate({ ids: [...selected], localStorage: false }, { onSuccess: () => setSelected(new Set()) })}
              title="These cameras record elsewhere (e.g. an NVR) and have no SD card: stop storage and recording alerts"
            >
              No local storage
            </Button>
            <Button
              size="sm"
              icon={<HardDrive className="h-4 w-4" />}
              loading={setLocalStorage.isPending && setLocalStorage.variables?.localStorage === true}
              onClick={() => setLocalStorage.mutate({ ids: [...selected], localStorage: true }, { onSuccess: () => setSelected(new Set()) })}
              title="These cameras record to an SD card or local storage"
            >
              Uses local storage
            </Button>
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 className="h-4 w-4" />}
              onClick={() => setRemoving(items.filter((c) => selected.has(c.id)))}
            >
              Remove {items.filter((c) => selected.has(c.id)).length} on this page
            </Button>
          </div>
        </div>
      )}

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
                  <th scope="col" className="sticky left-0 z-[1] w-9 bg-surface px-2 py-2">
                    <input type="checkbox" aria-label="Select all cameras on this page" checked={allSelected} onChange={toggleAll} />
                  </th>
                )}
                <SortHeader label="Camera" k="name" sort={sort} order={order} onSort={onSort} className={clsx("sticky z-[1] bg-surface", canWrite ? "left-9" : "left-0")} />
                {visibleColumns.map((col) =>
                  col.sortKey ? (
                    <SortHeader key={col.key} label={col.label} k={col.sortKey} sort={sort} order={order} onSort={onSort} className={col.align === "right" ? "text-right" : undefined} />
                  ) : (
                    <th key={col.key} scope="col" className={clsx("whitespace-nowrap px-2 py-2 font-medium", col.align === "right" && "text-right")}>
                      {col.label}
                    </th>
                  ),
                )}
                <th scope="col" className="px-2 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((c) => {
                const s = c.status;
                return (
                  <tr key={c.id} className="border-b border-line last:border-0 hover:bg-page/60">
                    {canWrite && (
                      <td className="sticky left-0 z-[1] w-9 bg-surface px-2 py-2">
                        <input type="checkbox" aria-label={`Select ${c.name}`} checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                      </td>
                    )}
                    <td className={clsx("sticky z-[1] min-w-[190px] bg-surface px-2 py-2", canWrite ? "left-9" : "left-0")}>
                      <Link to={`/cameras/${c.id}`} className="font-medium text-ink hover:text-accent-ink hover:underline">
                        {c.name}
                      </Link>
                      <div className="tabular text-xs text-ink-muted">
                        {c.host}
                        {c.port !== (c.protocol === "https" ? 443 : 80) && `:${c.port}`} · {c.model ?? "Model unknown"}
                      </div>
                      {c.priority === "critical" && <div className="mt-1"><CriticalAreaBadge /></div>}
                    </td>
                    {visibleColumns.map((col) => (
                      <td key={col.key} className={clsx("px-2 py-2", col.align === "right" && "text-right", col.cellClassName)}>
                        {col.render(c)}
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-2 py-2 text-right">
                      <IconAction label={`View ${c.name}`} to={`/cameras/${c.id}`}>
                        <Eye className="h-4 w-4" />
                      </IconAction>
                      {can("cameras:live") && (
                        <IconAction label={`Live view of ${c.name}`} onClick={() => setLive(c)}>
                          <Video className="h-4 w-4" />
                        </IconAction>
                      )}
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

      <LiveViewDialog camera={live} onClose={() => setLive(null)} />
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
