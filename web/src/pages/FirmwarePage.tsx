import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronDown, ChevronRight, Download } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, downloadFile, toQuery } from "../api/client";
import type { FirmwareCamera, FirmwareInventory, FirmwareModel } from "../api/types";
import { useToast } from "../components/toast";
import { Button, Card, EmptyState, ErrorMessage, PageHeader, Spinner } from "../components/ui";
import { absoluteTime, relativeTime } from "../lib/format";

/**
 * Every camera's model and firmware version, by model, with the cameras on an older version than
 * the newest one here: those are the ones to update (firmware updates fix security holes).
 */
export function FirmwarePage() {
  const toast = useToast();
  const inv = useQuery({ queryKey: ["firmware"], queryFn: () => api<FirmwareInventory>("/cameras/firmware") });
  const [open, setOpen] = useState<string | null>(null);
  const s = inv.data?.summary;
  const download = () => downloadFile("/cameras/firmware.csv", `firmware-inventory-${new Date().toISOString().slice(0, 10)}.csv`).catch((e: Error) => toast("error", e.message));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Firmware"
        description="Each camera's model and firmware version, as the camera reports it. A camera is marked when other cameras of the same model here already run a newer version. The manufacturer may have a newer one still: check its website."
        actions={<Button size="sm" icon={<Download className="h-4 w-4" />} onClick={() => void download()}>Download CSV</Button>}
      />
      {inv.isLoading && <Spinner />}
      {inv.error && <ErrorMessage error={inv.error as Error} />}
      {s && inv.data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Figure label="Cameras on older firmware" value={String(s.outdated)} hint="than others of their model" className={s.outdated ? "text-amber-700 dark:text-amber-400" : "text-green-700 dark:text-green-400"} />
            <Figure label="Models" value={String(s.models)} hint={`${s.cameras} cameras`} />
            <Figure label="Firmware versions" value={String(s.versions)} hint="different, over all models" />
            <Figure label="Not read yet" value={String(s.unknown)} hint="read at the next successful check" />
          </div>
          <Card title="By model">
            {inv.data.models.length === 0 ? (
              <EmptyState title="No cameras" description="Add cameras to see their firmware." />
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-ink-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2 font-medium">Model</th>
                    <th scope="col" className="px-2 py-2 font-medium">Cameras</th>
                    <th scope="col" className="px-2 py-2 font-medium">Newest firmware here</th>
                    <th scope="col" className="px-2 py-2 font-medium">Versions</th>
                    <th scope="col" className="px-4 py-2 text-right font-medium">On older firmware</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {inv.data.models.map((m) => {
                    const key = `${m.brand}|${m.model ?? ""}`;
                    const expanded = open === key;
                    return (
                      <ModelRows key={key} model={m} expanded={expanded} onToggle={() => setOpen(expanded ? null : key)} />
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function ModelRows({ model: m, expanded, onToggle }: { model: FirmwareModel; expanded: boolean; onToggle: () => void }) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <>
      <tr className="hover:bg-raised">
        <td className="px-4 py-2">
          <button type="button" className="flex items-center gap-1.5 text-left font-medium hover:underline" aria-expanded={expanded} onClick={onToggle}>
            <Chevron className="h-4 w-4 shrink-0 text-ink-muted" />
            <span>{m.brandName} {m.model ?? <span className="text-ink-muted">model not known yet</span>}</span>
          </button>
        </td>
        <td className="px-2 py-2 tabular">{m.cameras}</td>
        <td className="px-2 py-2 tabular">{m.newest ?? <span className="text-ink-muted">—</span>}</td>
        <td className="px-2 py-2 text-xs text-ink-secondary">
          {m.versions.map((v) => `${v.version} (${v.cameras})`).join(" · ") || "—"}
          {m.unknown > 0 && <span className="block text-ink-muted">{m.unknown} not read yet</span>}
        </td>
        <td className={clsx("px-4 py-2 text-right font-medium tabular", m.outdated ? "text-amber-700 dark:text-amber-400" : "text-ink-muted")}>{m.outdated || "—"}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5} className="bg-raised px-4 py-2">
            <ModelCameras brand={m.brand} model={m.model ?? ""} />
          </td>
        </tr>
      )}
    </>
  );
}

function ModelCameras({ brand, model }: { brand: string; model: string }) {
  const cams = useQuery({
    queryKey: ["firmware", brand, model],
    queryFn: () => api<FirmwareCamera[]>(`/cameras/firmware/cameras${toQuery({ brand, model })}`),
  });
  if (cams.isLoading) return <Spinner />;
  if (cams.error) return <ErrorMessage error={cams.error as Error} />;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-ink-muted">
        <tr>
          <th scope="col" className="py-1 pr-2 font-medium">Camera</th>
          <th scope="col" className="px-2 py-1 font-medium">Address</th>
          <th scope="col" className="px-2 py-1 font-medium">Location</th>
          <th scope="col" className="px-2 py-1 font-medium">Firmware</th>
          <th scope="col" className="px-2 py-1 font-medium">Serial number</th>
          <th scope="col" className="py-1 pl-2 text-right font-medium">Read</th>
        </tr>
      </thead>
      <tbody>
        {(cams.data ?? []).map((c) => (
          <tr key={c.id}>
            <td className="py-1 pr-2"><Link to={`/cameras/${c.id}`} className="hover:underline">{c.name}</Link></td>
            <td className="px-2 py-1 tabular text-ink-secondary">{c.host}</td>
            <td className="px-2 py-1 text-ink-secondary">{c.location ?? "—"}</td>
            <td className="px-2 py-1 tabular">
              {c.firmwareVersion ?? <span className="text-ink-muted">Not read yet</span>}
              {c.outdated && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">Older</span>}
            </td>
            <td className="px-2 py-1 tabular text-ink-secondary">{c.serialNumber ?? "—"}</td>
            <td className="py-1 pl-2 text-right text-xs text-ink-muted" title={c.readAt ? absoluteTime(c.readAt) : undefined}>{c.readAt ? relativeTime(c.readAt) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Figure({ label, value, hint, className }: { label: string; value: string; hint?: string; className?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <div className="text-xs text-ink-muted">{label}</div>
      <div className={clsx("mt-1 text-2xl font-semibold tabular", className)}>{value}</div>
      {hint && <div className="text-xs text-ink-muted">{hint}</div>}
    </div>
  );
}
