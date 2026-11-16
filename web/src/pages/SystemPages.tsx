import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertOctagon, AlertTriangle, CheckCircle2, Info, RefreshCw, Save } from "lucide-react";
import { useState } from "react";
import { api } from "../api/client";
import { useToast } from "../components/toast";
import { Button, Card, Checkbox, ErrorMessage, Field, Input, Select, Spinner } from "../components/ui";
import { absoluteTime, formatBytes, relativeTime } from "../lib/format";

// ------------------------------------------------------------------ System health

export interface HealthItem {
  key: string;
  group: string;
  label: string;
  status: "ok" | "warn" | "bad" | "info";
  value: string;
  detail?: string;
}
export interface Health {
  status: HealthItem["status"];
  checkedAt: string;
  items: HealthItem[];
}

const STATUS = {
  ok: { icon: CheckCircle2, cls: "text-good", label: "OK" },
  info: { icon: Info, cls: "text-ink-muted", label: "Info" },
  warn: { icon: AlertTriangle, cls: "text-warn", label: "Warning" },
  bad: { icon: AlertOctagon, cls: "text-bad", label: "Problem" },
} as const;

export const useSystemHealth = (enabled = true) =>
  useQuery({ queryKey: ["settings", "health"], queryFn: () => api<Health>("/settings/health"), enabled, refetchInterval: 60_000 });

export function HealthTab() {
  const q = useSystemHealth();
  const groups = [...new Set(q.data?.items.map((i) => i.group))];
  const counts = { bad: q.data?.items.filter((i) => i.status === "bad").length ?? 0, warn: q.data?.items.filter((i) => i.status === "warn").length ?? 0 };
  const overall = q.data ? STATUS[q.data.status] : null;
  return (
    <div className="space-y-4">
      <Card
        title="System health"
        actions={
          <Button size="sm" icon={<RefreshCw className={clsx("h-4 w-4", q.isFetching && "animate-spin")} />} onClick={() => q.refetch()} disabled={q.isFetching}>
            Check again
          </Button>
        }
      >
        {q.isLoading ? <Spinner /> : q.error ? <ErrorMessage error={q.error} className="m-4" /> : (
          <div className="flex flex-wrap items-center gap-3 px-4 py-4">
            {overall && <overall.icon className={clsx("h-8 w-8", overall.cls)} aria-hidden />}
            <div>
              <div className="text-lg font-semibold">
                {counts.bad ? `${counts.bad} problem${counts.bad === 1 ? "" : "s"} need attention` : counts.warn ? `Working, ${counts.warn} warning${counts.warn === 1 ? "" : "s"}` : "Everything is working"}
              </div>
              <div className="text-sm text-ink-secondary">Checked {relativeTime(q.data!.checkedAt)} · updates every minute · system administrators are emailed when a part turns into a problem</div>
            </div>
          </div>
        )}
      </Card>
      {groups.map((g) => (
        <Card key={g} title={g}>
          <ul className="divide-y divide-line">
            {q.data!.items.filter((i) => i.group === g).map((i) => {
              const st = STATUS[i.status];
              return (
                <li key={i.key} className="flex gap-3 px-4 py-3">
                  <st.icon className={clsx("mt-0.5 h-5 w-5 shrink-0", st.cls)} aria-label={st.label} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                      <span className="font-medium">{i.label}</span>
                      <span className={clsx("text-sm", i.status === "bad" ? "font-medium text-bad" : "text-ink")}>{i.value}</span>
                    </div>
                    {i.detail && <p className="mt-0.5 break-words text-xs text-ink-secondary">{i.detail}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Backups

interface BackupView {
  settings: { enabled: boolean; hour: number; timeZone: string; keepDays: number; folder: string | null };
  status: { lastSuccessAt: string | null; lastFile: string | null; lastSize: number | null; lastRows: number | null; lastDurationMs: number | null; lastError: string | null; lastErrorAt: string | null };
  folder: string;
  defaultFolder: string;
  files: { name: string; size: number; createdAt: string }[];
}

export function BackupsTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings", "backup"], queryFn: () => api<BackupView>("/settings/backup") });
  const [draft, setDraft] = useState<{ enabled: boolean; hour: string; keepDays: string; folder: string } | null>(null);
  const s = q.data?.settings;
  const d = draft ?? (s ? { enabled: s.enabled, hour: String(s.hour), keepDays: String(s.keepDays), folder: s.folder ?? "" } : null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["settings"] });
  const save = useMutation({
    mutationFn: () =>
      api("/settings/backup", {
        method: "PATCH",
        body: { enabled: d!.enabled, hour: Number(d!.hour), keepDays: Number(d!.keepDays), folder: d!.folder.trim() || null, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" },
      }),
    onSuccess: () => { toast("success", "Backup settings saved"); setDraft(null); void refresh(); },
    onError: (e: Error) => toast("error", e.message),
  });
  const run = useMutation({
    mutationFn: () => api<{ file: string; size: number; rows: number }>("/settings/backup/run", { method: "POST" }),
    onSuccess: (r) => { toast("success", `Backup made: ${r.file} (${formatBytes(r.size)})`); void refresh(); },
    onError: (e: Error) => toast("error", e.message),
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorMessage error={q.error} />;
  const v = q.data!;
  const failed = v.status.lastErrorAt && (!v.status.lastSuccessAt || v.status.lastErrorAt > v.status.lastSuccessAt);
  const set = (patch: Partial<NonNullable<typeof d>>) => setDraft({ ...d!, ...patch });
  const validKeep = /^\d+$/.test(d!.keepDays) && Number(d!.keepDays) >= 1 && Number(d!.keepDays) <= 365;
  return (
    <div className="space-y-4">
      <div className={clsx("rounded-md border px-4 py-3 text-sm", failed ? "border-bad/40 bg-bad/10" : v.status.lastSuccessAt ? "border-good/40 bg-good/10" : "border-warn/40 bg-warn/15")}>
        {failed
          ? `The last backup failed ${relativeTime(v.status.lastErrorAt)}: ${v.status.lastError}`
          : v.status.lastSuccessAt
            ? `Last backup ${relativeTime(v.status.lastSuccessAt)} (${absoluteTime(v.status.lastSuccessAt)}): ${v.status.lastFile}, ${formatBytes(v.status.lastSize ?? 0)}, ${v.status.lastRows?.toLocaleString()} records.`
            : "No backup has been made yet. Make one now, then the daily backup takes over."}
      </div>
      <Card
        title="Daily backup"
        actions={<Button size="sm" variant="primary" icon={<Save className="h-4 w-4" />} loading={run.isPending} onClick={() => run.mutate()}>Back up now</Button>}
      >
        <div className="space-y-4 p-4">
          <Checkbox label="Back up every day" description="The whole database: cameras, users, settings, alerts and history. Sign-in sessions are not included." checked={d!.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="At (your time zone)">
              {(id) => (
                <Select id={id} value={d!.hour} onChange={(e) => set({ hour: e.target.value })}>
                  {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{`${String(h).padStart(2, "0")}:00`}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Keep backups for (days)" hint="Older ones are deleted; the newest is always kept.">
              {(id, hint) => <Input id={id} aria-describedby={hint} inputMode="numeric" value={d!.keepDays} invalid={!validKeep} onChange={(e) => set({ keepDays: e.target.value.trim() })} />}
            </Field>
          </div>
          <Field label="Folder" hint={`Empty: ${v.defaultFolder}. A full path, e.g. a network share mounted on the server (D:\\Backups\\cctv or /mnt/backups).`}>
            {(id, hint) => <Input id={id} aria-describedby={hint} value={d!.folder} placeholder={v.defaultFolder} onChange={(e) => set({ folder: e.target.value })} />}
          </Field>
          <p className="rounded-md border border-line bg-raised px-3 py-2 text-xs text-ink-secondary">
            Camera and mail passwords are stored encrypted with this server's <code>credential.key</code> (in the data folder). Keep a copy of that key somewhere safe and separate from the backups:
            a backup restored on another server needs it to read the camera passwords.
          </p>
          <Button variant="primary" disabled={!draft || !validKeep} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
        </div>
      </Card>
      <Card title={`Backups kept (${v.files.length})`}>
        {v.files.length === 0 ? <p className="px-4 py-4 text-sm text-ink-secondary">None yet in {v.folder}.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-ink-secondary">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">File</th>
                  <th scope="col" className="px-4 py-2 font-medium">Made</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Size</th>
                </tr>
              </thead>
              <tbody>
                {v.files.map((f) => (
                  <tr key={f.name} className="border-t border-line">
                    <td className="px-4 py-2 font-mono text-xs">{f.name}</td>
                    <td className="px-4 py-2 text-ink-secondary" title={absoluteTime(f.createdAt)}>{absoluteTime(f.createdAt)} · {relativeTime(f.createdAt)}</td>
                    <td className="tabular px-4 py-2 text-right">{formatBytes(f.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t border-line px-4 py-3 text-xs text-ink-secondary">
          <strong>To restore</strong> (replaces all data with the backup): on Windows, run <code>RESTORE.bat</code> as administrator and choose the backup.
          With Docker: <code>docker compose stop api worker</code>, then <code>docker compose run --rm api node dist/cli/restoreBackup.js data/backups/&lt;file&gt; --yes</code>, then <code>docker compose start api worker</code>. See the Update guide.
        </div>
      </Card>
    </div>
  );
}
