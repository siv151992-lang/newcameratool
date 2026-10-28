import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Download } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, downloadFile } from "../api/client";
import { Button, Card, ErrorMessage, PageHeader, Spinner } from "../components/ui";
import { useToast } from "../components/toast";

interface UptimeRow { id: string; name: string; location: string | null; uptime: number | null; onlineSeconds: number; observedSeconds: number; outages: number; longestOutageSeconds: number }
interface UptimeReport {
  from: string; to: string; days: number;
  overall: { uptime: number | null; cameras: number; below99: number; outages: number; downtimeSeconds: number };
  locations: { location: string | null; cameras: number; uptime: number | null; outages: number; downtimeSeconds: number }[];
  cameras: UptimeRow[];
  camerasShown: number;
}

const PERIODS = [{ days: 1, label: "24 hours" }, { days: 7, label: "7 days" }, { days: 30, label: "30 days" }, { days: 90, label: "90 days" }];

/** "99.95%", or "—" when not observed. */
export const formatUptime = (u: number | null) => (u === null ? "—" : `${u >= 99.995 ? "100" : u.toFixed(u >= 99 ? 2 : 1)}%`);

/** "2 h 5 min", "45 min", "0 min". */
export function formatDuration(seconds: number): string {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

const tone = (u: number | null) => (u === null ? "text-ink-muted" : u >= 99.5 ? "text-green-700 dark:text-green-400" : u >= 98 ? "text-amber-700 dark:text-amber-400" : "text-red-700 dark:text-red-400");

/**
 * How much of the time cameras were online over a period: overall, per location and per camera
 * (lowest first), from the status changes the checks record. For service reviews and agreements.
 */
export function UptimePage() {
  const [days, setDays] = useState(30);
  const toast = useToast();
  const report = useQuery({ queryKey: ["uptime", days], queryFn: () => api<UptimeReport>(`/cameras/uptime?days=${days}`) });
  const r = report.data;
  const download = () => downloadFile(`/cameras/uptime.csv?days=${days}`, `uptime-${days}-days.csv`).catch((e: Error) => toast("error", e.message));

  return (
    <div className="space-y-4">
      <PageHeader
        title="Uptime"
        description="How much of the time cameras were online, from the status changes the checks record. Cameras with monitoring off are left out."
        actions={
          <>
            <div className="flex items-center gap-1 rounded-md border border-line p-0.5" role="group" aria-label="Period">
              {PERIODS.map((p) => (
                <Button key={p.days} size="sm" variant={days === p.days ? "primary" : "ghost"} aria-pressed={days === p.days} onClick={() => setDays(p.days)}>{p.label}</Button>
              ))}
            </div>
            <Button size="sm" icon={<Download className="h-4 w-4" />} onClick={() => void download()}>Download CSV</Button>
          </>
        }
      />
      {report.isLoading && <Spinner />}
      {report.error && <ErrorMessage error={report.error as Error} />}
      {r && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Figure label="Uptime, all cameras" value={formatUptime(r.overall.uptime)} className={tone(r.overall.uptime)} />
            <Figure label="Cameras below 99%" value={String(r.overall.below99)} hint={`of ${r.overall.cameras}`} />
            <Figure label="Outages" value={String(r.overall.outages)} hint="times a camera went offline" />
            <Figure label="Total downtime" value={formatDuration(r.overall.downtimeSeconds)} hint="added over all cameras" />
          </div>
          <Card title="By location">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-muted">
                <tr><th className="px-4 py-2 font-medium">Location</th><th className="px-2 py-2 font-medium">Cameras</th><th className="px-2 py-2 text-right font-medium">Uptime</th><th className="px-2 py-2 text-right font-medium">Outages</th><th className="px-4 py-2 text-right font-medium">Downtime</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {r.locations.map((l) => (
                  <tr key={l.location ?? ""}>
                    <td className="px-4 py-2">{l.location ?? <span className="text-ink-muted">No location</span>}</td>
                    <td className="px-2 py-2 tabular">{l.cameras}</td>
                    <td className={clsx("px-2 py-2 text-right font-medium tabular", tone(l.uptime))}>{formatUptime(l.uptime)}</td>
                    <td className="px-2 py-2 text-right tabular">{l.outages}</td>
                    <td className="px-4 py-2 text-right tabular">{formatDuration(l.downtimeSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title={r.camerasShown < r.overall.cameras ? `Cameras (the ${r.camerasShown} lowest; all ${r.overall.cameras} in the CSV)` : "Cameras"}>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ink-muted">
                <tr><th className="px-4 py-2 font-medium">Camera</th><th className="px-2 py-2 font-medium">Location</th><th className="px-2 py-2 text-right font-medium">Uptime</th><th className="px-2 py-2 text-right font-medium">Outages</th><th className="px-2 py-2 text-right font-medium">Downtime</th><th className="px-4 py-2 text-right font-medium">Longest outage</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {r.cameras.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-2"><Link to={`/cameras/${c.id}`} className="font-medium hover:underline">{c.name}</Link></td>
                    <td className="px-2 py-2 text-ink-secondary">{c.location ?? "—"}</td>
                    <td className={clsx("px-2 py-2 text-right font-medium tabular", tone(c.uptime))} title={c.uptime === null ? "Not checked in this period" : undefined}>{formatUptime(c.uptime)}</td>
                    <td className="px-2 py-2 text-right tabular">{c.outages}</td>
                    <td className="px-2 py-2 text-right tabular">{formatDuration(c.observedSeconds - c.onlineSeconds)}</td>
                    <td className="px-4 py-2 text-right tabular">{c.longestOutageSeconds ? formatDuration(c.longestOutageSeconds) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <p className="text-xs text-ink-muted">
            {new Date(r.from).toLocaleString()} – {new Date(r.to).toLocaleString()}. A camera counts as offline from the check that marked it offline
            (after the failed checks set in Problem detection) until it answered again; time before a camera was first checked is not counted.
          </p>
        </>
      )}
    </div>
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
