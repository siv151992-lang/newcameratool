import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertOctagon, AlertTriangle, CheckCircle2, Download, ExternalLink, Info, Loader2, RefreshCw, Save, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { api, uploadFile } from "../api/client";
import { useToast } from "../components/toast";
import { Button, Card, Checkbox, ConfirmDialog, ErrorMessage, Field, Input, Select, Spinner } from "../components/ui";
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

// ------------------------------------------------------------------ Updates

interface UpdateView {
  currentVersion: string;
  package: "windows" | "docker" | null;
  canInstall: boolean;
  settings: { repository: string | null; hasToken: boolean; autoCheck: boolean };
  lastCheck: { at: string; ok: boolean; error: string | null } | null;
  latest: { version: string; tag: string; name: string; notes: string; publishedAt: string | null; pageUrl: string; windows: { size: number } | null; hasDocker: boolean; newer: boolean } | null;
  download: { state: "downloading" | "checking" | "failed"; version: string; received: number; total: number; error?: string } | null;
  ready: { version: string; size: number; source: "download" | "upload"; checkedAt: string }[];
  install: { state: "requested" | "installing" | "installed" | "failed" | "rolled_back"; version: string; fromVersion?: string; message?: string; at: string } | null;
}

function Progress({ value }: { value: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-raised" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.max(2, Math.round(value * 100))}%` }} />
    </div>
  );
}

/** Settings > Updates: new versions of the app, from GitHub or a file, installed with backup and automatic rollback. */
export function UpdatesTab() {
  const toast = useToast();
  const qc = useQueryClient();
  const busy = (v?: UpdateView) => Boolean(v?.download && v.download.state !== "failed") || v?.install?.state === "requested" || v?.install?.state === "installing";
  const q = useQuery({
    queryKey: ["settings", "updates"],
    queryFn: () => api<UpdateView>("/settings/updates"),
    // While downloading or installing (the app restarts: requests fail for a minute or two).
    // Keeps polling through errors: the last good answer stays in query.state.data.
    refetchInterval: (query) => (busy(query.state.data) ? 2000 : false),
    retry: 1,
  });
  const set = (v: UpdateView) => qc.setQueryData(["settings", "updates"], v);
  const onError = (e: Error) => toast("error", e.message);
  const [draft, setDraft] = useState<{ repository: string; token: string; autoCheck: boolean } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [upload, setUpload] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const check = useMutation({ mutationFn: () => api<UpdateView>("/settings/updates/check", { method: "POST" }), onSuccess: set, onError });
  const download = useMutation({ mutationFn: () => api<UpdateView>("/settings/updates/download", { method: "POST" }), onSuccess: set, onError });
  const install = useMutation({
    mutationFn: (version: string) => api<UpdateView>("/settings/updates/install", { method: "POST", body: { version } }),
    onSuccess: (v) => { set(v); setConfirm(null); toast("success", "Installation requested: it starts within a minute."); },
    onError,
  });
  const cancel = useMutation({ mutationFn: () => api<UpdateView>("/settings/updates/install", { method: "DELETE" }), onSuccess: set, onError });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<UpdateView>("/settings/updates", { method: "PATCH", body }),
    onSuccess: (v) => { set(v); setDraft(null); toast("success", "Update settings saved"); },
    onError,
  });
  const sendFile = useMutation({
    mutationFn: (f: File) => {
      setUpload(0);
      return uploadFile<UpdateView>("/settings/updates/upload", f, "application/zip", setUpload);
    },
    onSuccess: (v) => { set(v); toast("success", `Version ${v.ready[0]?.version ?? ""} is checked and ready to install.`); },
    onError,
    onSettled: () => setUpload(null),
  });

  if (q.isLoading) return <Spinner />;
  const v = q.data;
  if (!v) return <ErrorMessage error={q.error} />;
  const s = v.settings;
  const d = draft ?? { repository: s.repository ?? "", token: "", autoCheck: s.autoCheck };
  const latest = v.latest;
  const readyLatest = latest && v.ready.find((r) => r.version === latest.version);
  const inst = v.install;
  const restarting = q.isError && (inst?.state === "requested" || inst?.state === "installing");

  const banner = (() => {
    if (restarting) return { cls: "border-accent/40 bg-accent/10", text: `Installing version ${inst!.version}: the app is restarting. This page comes back by itself in a minute or two.` };
    if (inst?.state === "requested") return { cls: "border-accent/40 bg-accent/10", text: `Version ${inst.version} will be installed within a minute. The app then restarts (about 1 to 2 minutes; cameras are not checked meanwhile).` };
    if (inst?.state === "installing") return { cls: "border-accent/40 bg-accent/10", text: `Installing version ${inst.version}${inst.message ? `: ${inst.message}` : ""}` };
    if (inst?.state === "installed" && inst.version === v.currentVersion) return { cls: "border-good/40 bg-good/10", text: `Updated to version ${inst.version} ${relativeTime(inst.at)}.` };
    if (inst?.state === "rolled_back" || inst?.state === "failed") return { cls: "border-bad/40 bg-bad/10", text: `Version ${inst.version} was not installed${inst.state === "rolled_back" ? ` (version ${inst.fromVersion} was put back)` : ""}: ${inst.message ?? "see data\\logs\\updater.log"}` };
    if (latest?.newer) return { cls: "border-accent/40 bg-accent/10", text: `Version ${latest.version} is available (version ${v.currentVersion} is installed).` };
    if (v.lastCheck && !v.lastCheck.ok) return { cls: "border-warn/40 bg-warn/15", text: `The last check failed ${relativeTime(v.lastCheck.at)}: ${v.lastCheck.error}` };
    if (v.lastCheck) return { cls: "border-good/40 bg-good/10", text: `Version ${v.currentVersion} is the latest (checked ${relativeTime(v.lastCheck.at)}).` };
    return { cls: "border-line bg-raised", text: `Version ${v.currentVersion} is installed. ${s.repository ? "Check for updates to see if there is a newer one." : "Set where releases are published (below) to check for updates."}` };
  })();

  const installButton = (version: string) =>
    v.canInstall ? (
      <Button variant="primary" icon={<Download className="h-4 w-4" />} disabled={busy(v)} onClick={() => setConfirm(version)}>
        Install version {version}
      </Button>
    ) : null;

  return (
    <div className="space-y-4">
      <div className={clsx("flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 text-sm", banner.cls)}>
        <span className="flex items-center gap-2">
          {(restarting || inst?.state === "installing") && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {banner.text}
        </span>
        {inst?.state === "requested" && !restarting && (
          <Button size="sm" loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel</Button>
        )}
      </div>

      <Card
        title="New version"
        actions={
          <Button size="sm" icon={<RefreshCw className="h-4 w-4" />} loading={check.isPending} disabled={!s.repository} onClick={() => check.mutate()}>
            Check for updates
          </Button>
        }
      >
        <div className="space-y-3 p-4 text-sm">
          {!latest ? (
            <p className="text-ink-secondary">{s.repository ? "Not checked yet." : "No update source is set: enter the GitHub repository below, or install a package from a file."}</p>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="font-medium text-ink">{latest.name}</p>
                  <p className="text-xs text-ink-muted">
                    {latest.publishedAt ? `Published ${absoluteTime(latest.publishedAt)}` : ""}{latest.windows ? ` · Windows package ${formatBytes(latest.windows.size)}` : ""}
                  </p>
                </div>
                <a href={latest.pageUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-xs text-accent hover:underline">
                  Release page <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              </div>
              {latest.notes && <div className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-line bg-raised px-3 py-2 text-xs text-ink-secondary">{latest.notes}</div>}
              {latest.newer && v.package === "docker" && (
                <p className="rounded-md border border-line bg-raised px-3 py-2 text-xs text-ink-secondary">
                  This server runs in Docker: download <strong>cctv-monitor.zip</strong> from the release page, extract it over the old folder (keep <code>.env</code>), then run{" "}
                  <code>docker compose up -d --build</code>. Your data is kept.
                </p>
              )}
              {latest.newer && v.package !== "docker" && (
                <div className="flex flex-wrap items-center gap-3">
                  {readyLatest ? (
                    <>
                      <span className="inline-flex items-center gap-1 text-good"><CheckCircle2 className="h-4 w-4" aria-hidden /> Downloaded and checked</span>
                      {installButton(latest.version)}
                    </>
                  ) : v.download && v.download.version === latest.version && v.download.state !== "failed" ? (
                    <div className="w-full max-w-md space-y-1">
                      <Progress value={v.download.total ? v.download.received / v.download.total : 0} />
                      <p className="text-xs text-ink-muted">
                        {v.download.state === "checking" ? "Checking the signature and every file..." : `Downloading: ${formatBytes(v.download.received)} of ${formatBytes(v.download.total)}`}
                      </p>
                    </div>
                  ) : latest.windows ? (
                    <Button variant="primary" icon={<Download className="h-4 w-4" />} loading={download.isPending} onClick={() => download.mutate()}>
                      Download version {latest.version}
                    </Button>
                  ) : (
                    <p className="text-xs text-ink-muted">This release has no Windows package.</p>
                  )}
                </div>
              )}
              {v.download?.state === "failed" && <p className="text-xs text-bad">The download failed: {v.download.error}</p>}
            </>
          )}
        </div>
      </Card>

      {v.package !== "docker" && (
        <Card title="Install from a file">
          <div className="space-y-3 p-4 text-sm">
            <p className="text-ink-secondary">
              For a server without internet: download <strong>cctv-monitor-windows.zip</strong> from the release page on another PC and upload it here. Only packages signed by the
              CCTV Monitor release key are accepted, and every file is checked.
            </p>
            <input
              ref={fileInput}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              aria-label="Update package"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) sendFile.mutate(f);
              }}
            />
            {upload !== null ? (
              <div className="max-w-md space-y-1">
                <Progress value={upload} />
                <p className="text-xs text-ink-muted">{upload < 1 ? `Uploading: ${Math.round(upload * 100)}%` : "Checking the signature and every file..."}</p>
              </div>
            ) : (
              <Button icon={<Upload className="h-4 w-4" />} disabled={busy(v)} onClick={() => fileInput.current?.click()}>
                Choose package...
              </Button>
            )}
            {v.ready.filter((r) => r.version !== latest?.version).map((r) => (
              <div key={r.version} className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2">
                <span className="inline-flex items-center gap-1 text-good"><CheckCircle2 className="h-4 w-4" aria-hidden /> Version {r.version} checked ({formatBytes(r.size)}, {r.source === "upload" ? "uploaded" : "downloaded"} {relativeTime(r.checkedAt)})</span>
                {installButton(r.version)}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card title="Where releases are published">
        <div className="space-y-4 p-4">
          <Field label="GitHub repository" hint="owner/name of the repository whose Releases hold the app's packages, e.g. my-company/cctv-monitor.">
            {(id, hint) => <Input id={id} aria-describedby={hint} value={d.repository} placeholder="owner/name" onChange={(e) => setDraft({ ...d, repository: e.target.value })} />}
          </Field>
          <Field
            label="Access token (private repository)"
            hint={s.hasToken ? "A token is saved. Enter a new one to replace it." : "A GitHub fine-grained token with read-only access to this repository's contents. Not needed for a public repository."}
          >
            {(id, hint) => (
              <Input id={id} aria-describedby={hint} type="password" autoComplete="off" value={d.token} placeholder={s.hasToken ? "Saved (hidden)" : "github_pat_..."} onChange={(e) => setDraft({ ...d, token: e.target.value })} />
            )}
          </Field>
          <Checkbox
            label="Check for a new version every day"
            description="Only looks: nothing is downloaded or installed without you."
            checked={d.autoCheck}
            onChange={(e) => setDraft({ ...d, autoCheck: e.target.checked })}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              disabled={!draft}
              loading={save.isPending}
              onClick={() => save.mutate({ repository: d.repository.trim(), autoCheck: d.autoCheck, ...(d.token.trim() ? { token: d.token.trim() } : {}) })}
            >
              Save
            </Button>
            {s.hasToken && <Button onClick={() => save.mutate({ token: "" })}>Remove token</Button>}
          </div>
        </div>
      </Card>

      <ConfirmDialog
        open={confirm !== null}
        title={`Install version ${confirm}?`}
        confirmLabel="Install now"
        loading={install.isPending}
        onConfirm={() => confirm && install.mutate(confirm)}
        onCancel={() => setConfirm(null)}
      >
        <ul className="list-disc space-y-1 pl-5 text-sm text-ink-secondary">
          <li>The app stops for about 1 to 2 minutes: the dashboard is unavailable and cameras are not checked meanwhile.</li>
          <li>The current version is kept: if the new one does not start, it is put back automatically.</li>
          <li>Your data, settings and cameras are kept. A backup is a good idea first (Settings &gt; Backups).</li>
        </ul>
      </ConfirmDialog>
    </div>
  );
}
