import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Activity, Archive, ChevronRight, Clock, Gauge, Mail, Palette, Plus, ScrollText, Send, Sparkles, Trash2, Users as UsersIcon } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { api, ApiError, toQuery } from "../api/client";
import type { AiStatus, AuditEntry, ManagedUser, MonitoringSettings, NotificationChannel, Page } from "../api/types";
import { Button, Card, Checkbox, ConfirmDialog, Dialog, EmptyState, ErrorMessage, Field, Input, PageHeader, Pagination, Select, Spinner } from "../components/ui";
import { useToast } from "../components/toast";
import { useAiStatus } from "../hooks/ai";
import { useAuth } from "../hooks/auth";
import { useTheme } from "../hooks/theme";
import { absoluteTime, relativeTime } from "../lib/format";

interface Section {
  path: string;
  label: string;
  description: string;
  icon: ReactNode;
  element: ReactNode;
}

function useSections(): Section[] {
  const { can } = useAuth();
  const icon = "h-5 w-5";
  const all: (Section | false)[] = [
    can("settings:read") && { path: "schedule", label: "Schedule", description: "How often cameras are checked, timeouts and retries.", icon: <Clock className={icon} />, element: <MonitoringSettingsTab groupKey="schedule" /> },
    can("settings:read") && { path: "thresholds", label: "Thresholds", description: "Default warning, critical and full storage levels. Each camera can override them on its edit page.", icon: <Gauge className={icon} />, element: <MonitoringSettingsTab groupKey="thresholds" /> },
    can("settings:read") && { path: "detection", label: "Problem detection", description: "When a camera counts as offline and when alerts are raised.", icon: <Activity className={icon} />, element: <MonitoringSettingsTab groupKey="detection" /> },
    can("settings:read") && { path: "retention", label: "Retention", description: "How long history and audit records are kept.", icon: <Archive className={icon} />, element: <MonitoringSettingsTab groupKey="retention" /> },
    can("settings:read") && { path: "notifications", label: "Notifications", description: "Email alerts, cooldowns and recovery notices.", icon: <Mail className={icon} />, element: <NotificationsTab /> },
    can("settings:read") && { path: "ai", label: "AI Mode", description: "Turn on forecasts, anomaly detection, the assistant and AI reports.", icon: <Sparkles className={icon} />, element: <AiSettingsTab /> },
    can("users:manage") && { path: "users", label: "Users", description: "Add users, set roles and reset passwords.", icon: <UsersIcon className={icon} />, element: <UsersTab /> },
    { path: "account", label: "Account & theme", description: "Change your password and the light or dark theme.", icon: <Palette className={icon} />, element: <AccountTab /> },
    can("audit:read") && { path: "audit", label: "Audit log", description: "Who changed what, and when.", icon: <ScrollText className={icon} />, element: <AuditTab /> },
  ];
  return all.filter(Boolean) as Section[];
}

export function SettingsPage() {
  const sections = useSections();
  return (
    <Routes>
      <Route index element={<SettingsOverview sections={sections} />} />
      {sections.map((s) => (
        <Route key={s.path} path={s.path} element={<SectionLayout sections={sections} current={s} />} />
      ))}
      <Route path="*" element={<Navigate to="/settings" replace />} />
    </Routes>
  );
}

/** Settings home: one card per section; nothing is shown until a section is opened. */
function SettingsOverview({ sections }: { sections: Section[] }) {
  return (
    <>
      <PageHeader title="Settings" description="Choose a section to view or change its settings." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {sections.map((s) => (
          <Link
            key={s.path}
            to={s.path}
            className="group flex items-start gap-3 rounded-lg border border-line bg-surface p-4 transition hover:border-line-strong"
          >
            <span className="mt-0.5 text-accent" aria-hidden>{s.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-ink">{s.label}</span>
              <span className="mt-0.5 block text-sm text-ink-secondary">{s.description}</span>
            </span>
            <ChevronRight className="mt-0.5 h-4 w-4 text-ink-muted group-hover:text-ink" aria-hidden />
          </Link>
        ))}
      </div>
    </>
  );
}

/** A single section: breadcrumb bar on top, section headings on the side, that section's content. */
function SectionLayout({ sections, current }: { sections: Section[]; current: Section }) {
  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-4">
        <ol className="flex flex-wrap items-center gap-1.5 text-sm">
          <li>
            <Link to="/settings" className="text-ink-secondary hover:text-ink hover:underline">Settings</Link>
          </li>
          <li aria-hidden className="text-ink-muted"><ChevronRight className="h-4 w-4" /></li>
          <li aria-current="page" className="font-medium text-ink">{current.label}</li>
        </ol>
      </nav>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="min-w-0 lg:sticky lg:top-20 lg:self-start">
          <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
            {sections.map((s) => (
              <li key={s.path} className="shrink-0">
                <NavLink
                  to={`/settings/${s.path}`}
                  className={({ isActive }) =>
                    clsx(
                      "flex items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium",
                      isActive ? "bg-accent-soft/70 text-ink" : "text-ink-secondary hover:bg-line/60 hover:text-ink",
                    )
                  }
                >
                  <span aria-hidden className="[&>svg]:h-4 [&>svg]:w-4">{s.icon}</span>
                  {s.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0">
          <h1 className="mb-1 text-xl font-semibold">{current.label}</h1>
          <p className="mb-5 text-sm text-ink-secondary">{current.description}</p>
          {current.element}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Monitoring

type NumKey = { [K in keyof MonitoringSettings]: MonitoringSettings[K] extends number ? K : never }[keyof MonitoringSettings];

const GROUPS: { key: string; title: string; fields: { key: NumKey; label: string; unit?: string; hint?: string; scale?: number }[] }[] = [
  {
    key: "schedule",
    title: "Schedule",
    fields: [
      { key: "pollIntervalSeconds", label: "Polling interval", unit: "minutes", scale: 60, hint: "How often each camera is checked (1 minute – 24 hours)" },
      { key: "concurrency", label: "Concurrent checks", hint: "Maximum cameras contacted at the same time" },
      { key: "requestTimeoutMs", label: "Request timeout", unit: "seconds", scale: 1000 },
      { key: "maxRetries", label: "Retries for transient errors", hint: "With exponential backoff; authentication errors are never retried" },
      { key: "retryBaseDelayMs", label: "Initial retry delay", unit: "seconds", scale: 1000 },
    ],
  },
  {
    key: "thresholds",
    title: "Thresholds (global defaults)",
    fields: [
      { key: "warningThresholdPercent", label: "Warning", unit: "% used" },
      { key: "criticalThresholdPercent", label: "Critical", unit: "% used" },
      { key: "fullThresholdPercent", label: "Full", unit: "% used" },
      { key: "recoveryHysteresisPercent", label: "Recovery margin", unit: "%", hint: "Usage must drop this far below the warning level before the alert clears" },
    ],
  },
  {
    key: "detection",
    title: "Problem detection",
    fields: [
      { key: "offlineFailureThreshold", label: "Failures before offline", hint: "Consecutive failed checks before a camera is marked offline" },
      { key: "authFailureThreshold", label: "Auth failures before alert" },
      { key: "storageUnavailableMinutes", label: "Storage unavailable alert after", unit: "minutes" },
      { key: "deviceInfoRefreshHours", label: "Refresh device info every", unit: "hours" },
    ],
  },
  {
    key: "retention",
    title: "Retention",
    fields: [
      { key: "historyRetentionDays", label: "Monitoring history", unit: "days" },
      { key: "auditRetentionDays", label: "Audit log and resolved alerts", unit: "days" },
    ],
  },
];

function MonitoringSettingsTab({ groupKey }: { groupKey: string }) {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const editable = can("settings:write");
  const settings = useQuery({ queryKey: ["settings", "monitoring"], queryFn: () => api<MonitoringSettings>("/settings/monitoring") });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [usageAlerts, setUsageAlerts] = useState(true);
  const [recordingAlerts, setRecordingAlerts] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const group = GROUPS.find((g) => g.key === groupKey)!;
  const isThresholds = groupKey === "thresholds";

  useEffect(() => {
    if (!settings.data) return;
    const d: Record<string, string> = {};
    for (const g of GROUPS) for (const f of g.fields) d[f.key] = String(settings.data[f.key] / (f.scale ?? 1));
    setDraft(d);
    setUsageAlerts(settings.data.storageUsageAlertsEnabled);
    setRecordingAlerts(settings.data.recordingAlertsEnabled);
  }, [settings.data]);

  const save = useMutation({
    mutationFn: () => {
      // Only this section's fields are sent; the server keeps the rest unchanged.
      const body: Record<string, unknown> = isThresholds
        ? { storageUsageAlertsEnabled: usageAlerts, recordingAlertsEnabled: recordingAlerts }
        : {};
      for (const f of group.fields) body[f.key] = Math.round(Number(draft[f.key]) * (f.scale ?? 1) * 100) / 100;
      return api<MonitoringSettings>("/settings/monitoring", { method: "PATCH", body });
    },
    onSuccess: (s) => {
      qc.setQueryData(["settings", "monitoring"], s);
      setErrors({});
      toast("success", `${group.title.replace(/ \(.*\)$/, "")} settings saved`);
    },
    onError: (e) => {
      if (e instanceof ApiError) setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.field, f.message])));
      toast("error", (e as Error).message);
    },
  });

  if (settings.isLoading) return <Spinner />;
  if (settings.error) return <ErrorMessage error={settings.error} />;

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        save.mutate();
      }}
      className="space-y-5"
    >
      {!editable && <p className="text-sm text-ink-secondary">You can view these settings. Only administrators can change them.</p>}
      <Card>
        <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {group.fields.map((f) => (
            <Field key={f.key} label={`${f.label}${f.unit ? ` (${f.unit})` : ""}`} hint={f.hint} error={errors[f.key]}>
              {(id, d) => (
                <Input
                  id={id}
                  aria-describedby={d}
                  inputMode="decimal"
                  disabled={!editable}
                  value={draft[f.key] ?? ""}
                  invalid={!!errors[f.key]}
                  onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                />
              )}
            </Field>
          ))}
          {isThresholds && (
            <div className="sm:col-span-2 lg:col-span-3">
              <Checkbox
                label="Raise alerts for high storage usage"
                description="Turn this off if cameras are set to overwrite old recordings, so cards that are always nearly full don't stay in warning. Disk health, read-only and offline alerts still apply."
                disabled={!editable}
                checked={usageAlerts}
                onChange={(e) => setUsageAlerts(e.target.checked)}
              />
              <div className="mt-3">
                <Checkbox
                  label="Raise alerts when a camera is not recording"
                  description="Warns when a camera reports it is not recording right now, and raises a critical alert for recording errors. Turn this off if cameras only record on motion or a schedule."
                  disabled={!editable}
                  checked={recordingAlerts}
                  onChange={(e) => setRecordingAlerts(e.target.checked)}
                />
              </div>
            </div>
          )}
        </div>
      </Card>
      {editable && (
        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={save.isPending}>Save settings</Button>
        </div>
      )}
    </form>
  );
}

// ------------------------------------------------------------------ AI Mode

function AiSettingsTab() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const status = useAiStatus();
  const save = useMutation({
    mutationFn: (enabled: boolean) => api<{ enabled: boolean }>("/ai/settings", { method: "PATCH", body: { enabled } }),
    onSuccess: (s) => {
      qc.setQueryData<AiStatus>(["ai", "status"], (old) => (old ? { ...old, enabled: s.enabled } : old));
      qc.invalidateQueries({ queryKey: ["ai"] });
      toast("success", s.enabled ? "AI Mode turned on" : "AI Mode turned off");
    },
    onError: (e) => toast("error", (e as Error).message),
  });
  if (status.isLoading) return <Spinner />;
  if (status.error) return <ErrorMessage error={status.error} />;
  const s = status.data!;
  return (
    <div className="space-y-5">
      <Card>
        <div className="space-y-4 p-4">
          <Checkbox
            label="Enable AI Mode"
            description="Adds the AI Mode page: storage forecasts, anomaly detection, camera health scores, recommended actions, reports and the assistant. Checks, alerts and camera management never depend on it."
            disabled={!can("settings:write") || save.isPending}
            checked={s.enabled}
            onChange={(e) => save.mutate(e.target.checked)}
          />
        </div>
      </Card>
      <Card title="Assistant and AI summaries">
        <dl className="grid gap-4 p-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-ink-muted">Status</dt>
            <dd className="text-ink">{s.assistant.available ? "Configured" : "Not configured"}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Model</dt>
            <dd className="text-ink">{s.assistant.model}</dd>
          </div>
          <div className="sm:col-span-2 text-ink-secondary">
            {s.assistant.available
              ? "Questions and report summaries are answered by Claude using read-only lookups of the monitoring data. Camera names, IP addresses and monitoring data are sent to the AI service; passwords and keys never are."
              : `${s.assistant.reason ?? ""} Forecasts, anomalies, recommendations and reports work without it.`}
          </div>
        </dl>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ Notifications

function NotificationsTab() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const editable = can("settings:write");
  const channels = useQuery({ queryKey: ["settings", "notifications"], queryFn: () => api<NotificationChannel[]>("/settings/notifications") });
  const [editing, setEditing] = useState<Partial<NotificationChannel> & { recipientsText?: string } | null>(null);
  const [deleting, setDeleting] = useState<NotificationChannel | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["settings", "notifications"] });

  const save = useMutation({
    mutationFn: () => {
      const e = editing!;
      const body = {
        name: e.name,
        enabled: e.enabled ?? true,
        minSeverity: e.minSeverity ?? "warning",
        cooldownMinutes: Number(e.cooldownMinutes ?? 60),
        notifyOnRecovery: e.notifyOnRecovery ?? true,
        config: { recipients: (e.recipientsText ?? "").split(/[,;\s]+/).filter(Boolean) },
      };
      return e.id
        ? api(`/settings/notifications/${e.id}`, { method: "PATCH", body })
        : api("/settings/notifications", { method: "POST", body: { ...body, type: "email" } });
    },
    onSuccess: () => {
      toast("success", "Notification channel saved");
      setEditing(null);
      void refresh();
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const test = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean; message: string }>(`/settings/notifications/${id}/test`, { method: "POST" }),
    onSuccess: (r) => toast(r.ok ? "success" : "error", r.message),
    onError: (e: Error) => toast("error", e.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/settings/notifications/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-secondary">
        Alerts always appear in the dashboard. Email notifications are optional and use the SMTP server configured in the server environment.
        A cooldown per camera and alert type prevents repeated emails; escalations to critical are always sent.
      </p>
      <Card
        title="Email channels"
        actions={editable && <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setEditing({ enabled: true, minSeverity: "warning", cooldownMinutes: 60, notifyOnRecovery: true, recipientsText: "" })}>Add channel</Button>}
      >
        {channels.isLoading ? (
          <Spinner />
        ) : !channels.data?.length ? (
          <EmptyState icon={<Mail className="h-6 w-6" />} title="No notification channels" description="Add an email channel to be notified when alerts open, escalate or resolve." />
        ) : (
          <ul className="divide-y divide-line">
            {channels.data.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{c.name} {!c.enabled && <span className="text-xs text-ink-muted">(disabled)</span>}</div>
                  <div className="text-xs text-ink-secondary">
                    {c.config.recipients?.join(", ")} · {c.minSeverity}+ · cooldown {c.cooldownMinutes} min{c.notifyOnRecovery ? " · recovery notices" : ""}
                  </div>
                </div>
                {editable && (
                  <>
                    <Button size="sm" variant="ghost" icon={<Send className="h-4 w-4" />} loading={test.isPending && test.variables === c.id} onClick={() => test.mutate(c.id)}>Send test</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing({ ...c, recipientsText: c.config.recipients?.join(", ") })}>Edit</Button>
                    <Button size="sm" variant="ghost" aria-label={`Delete ${c.name}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => setDeleting(c)} />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        title={editing?.id ? "Edit email channel" : "Add email channel"}
        footer={<><Button onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}
      >
        {editing && (
          <div className="space-y-3">
            <Field label="Name" required>{(id) => <Input id={id} value={editing.name ?? ""} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />}</Field>
            <Field label="Recipients" required hint="Separate addresses with commas">{(id, d) => <Input id={id} aria-describedby={d} value={editing.recipientsText ?? ""} onChange={(e) => setEditing({ ...editing, recipientsText: e.target.value })} />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Minimum severity">
                {(id) => (
                  <Select id={id} value={editing.minSeverity} onChange={(e) => setEditing({ ...editing, minSeverity: e.target.value as NotificationChannel["minSeverity"] })}>
                    <option value="warning">Warning and critical</option>
                    <option value="critical">Critical only</option>
                  </Select>
                )}
              </Field>
              <Field label="Cooldown (minutes)">{(id) => <Input id={id} inputMode="numeric" value={String(editing.cooldownMinutes ?? 60)} onChange={(e) => setEditing({ ...editing, cooldownMinutes: Number(e.target.value.replace(/\D/g, "")) })} />}</Field>
            </div>
            <Checkbox label="Send recovery notifications" checked={editing.notifyOnRecovery ?? true} onChange={(e) => setEditing({ ...editing, notifyOnRecovery: e.target.checked })} />
            <Checkbox label="Enabled" checked={editing.enabled ?? true} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} />
          </div>
        )}
      </Dialog>
      <ConfirmDialog open={!!deleting} danger title="Delete channel?" confirmLabel="Delete" loading={remove.isPending} onCancel={() => setDeleting(null)} onConfirm={() => remove.mutate(deleting!.id)}>
        <p>{deleting?.name} will stop receiving notifications.</p>
      </ConfirmDialog>
    </div>
  );
}

// ------------------------------------------------------------------ Users

function UsersTab() {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<ManagedUser[]>("/users") });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ username: "", displayName: "", password: "", role: "viewer" });
  const [resetting, setResetting] = useState<ManagedUser | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });

  const create = useMutation({
    mutationFn: () => api("/users", { method: "POST", body: { ...form, displayName: form.displayName || undefined } }),
    onSuccess: () => {
      toast("success", `User ${form.username} created`);
      setCreating(false);
      setForm({ username: "", displayName: "", password: "", role: "viewer" });
      void refresh();
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api(`/users/${id}`, { method: "PATCH", body }),
    onSuccess: () => {
      toast("success", "User updated");
      setResetting(null);
      setNewPassword("");
      void refresh();
    },
    onError: (e: Error) => toast("error", e.message),
  });

  return (
    <Card title="Users" actions={<Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>Add user</Button>}>
      <div className="border-b border-line px-4 py-2 text-xs text-ink-secondary">
        <strong>Admin</strong>: everything · <strong>Operator</strong>: run checks and manage alerts · <strong>Viewer</strong>: read-only
      </div>
      {users.isLoading ? <Spinner /> : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-ink-secondary">
              <tr>
                <th scope="col" className="px-4 py-2 font-medium">User</th>
                <th scope="col" className="px-4 py-2 font-medium">Role</th>
                <th scope="col" className="px-4 py-2 font-medium">Status</th>
                <th scope="col" className="px-4 py-2 font-medium">Last sign-in</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.data?.map((u) => (
                <tr key={u.id} className="border-t border-line">
                  <td className="px-4 py-2"><div className="font-medium">{u.username}</div><div className="text-xs text-ink-muted">{u.displayName}</div></td>
                  <td className="px-4 py-2">
                    <Select aria-label={`Role for ${u.username}`} className="w-auto py-1" value={u.role} disabled={u.id === user?.id} onChange={(e) => update.mutate({ id: u.id, body: { role: e.target.value } })}>
                      <option value="admin">Admin</option>
                      <option value="operator">Operator</option>
                      <option value="viewer">Viewer</option>
                    </Select>
                  </td>
                  <td className="px-4 py-2">{u.isActive ? (u.locked ? "Locked (too many attempts)" : "Active") : "Disabled"}</td>
                  <td className="px-4 py-2 text-ink-secondary" title={absoluteTime(u.lastLoginAt)}>{relativeTime(u.lastLoginAt)}</td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    <Button size="sm" variant="ghost" onClick={() => setResetting(u)}>Reset password</Button>
                    {u.id !== user?.id && (
                      <Button size="sm" variant="ghost" onClick={() => update.mutate({ id: u.id, body: { isActive: !u.isActive } })}>
                        {u.isActive ? "Disable" : "Enable"}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog open={creating} onClose={() => setCreating(false)} title="Add user" footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>Create</Button></>}>
        <div className="space-y-3">
          <Field label="Username" required>{(id) => <Input id={id} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} autoComplete="off" />}</Field>
          <Field label="Display name">{(id) => <Input id={id} value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />}</Field>
          <Field label="Initial password" required hint="At least 10 characters">{(id, d) => <Input id={id} aria-describedby={d} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" />}</Field>
          <Field label="Role">{(id) => <Select id={id} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="admin">Admin</option></Select>}</Field>
        </div>
      </Dialog>
      <Dialog open={!!resetting} onClose={() => setResetting(null)} title={`Reset password for ${resetting?.username}`} footer={<><Button onClick={() => setResetting(null)}>Cancel</Button><Button variant="primary" loading={update.isPending} onClick={() => update.mutate({ id: resetting!.id, body: { password: newPassword } })}>Reset password</Button></>}>
        <p className="mb-3 text-ink-secondary">The user is signed out of all sessions.</p>
        <Field label="New password" hint="At least 10 characters">{(id, d) => <Input id={id} aria-describedby={d} type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" />}</Field>
      </Dialog>
    </Card>
  );
}

// ------------------------------------------------------------------ Account

function AccountTab() {
  const { user } = useAuth();
  const { theme, setTheme } = useTheme();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<unknown>(null);
  const change = useMutation({
    mutationFn: () => api("/auth/password", { method: "POST", body: { currentPassword: current, newPassword: next } }),
    onSuccess: () => {
      toast("success", "Password changed. Other sessions were signed out.");
      setCurrent("");
      setNext("");
      setConfirm("");
      setError(null);
    },
    onError: setError,
  });
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Appearance">
        <div className="space-y-3 p-4 text-sm">
          <p className="text-ink-secondary">Your choice is saved in this browser. Until you choose, the theme follows your operating system.</p>
          <div role="radiogroup" aria-label="Theme" className="flex gap-2">
            {(["light", "dark"] as const).map((t) => (
              <Button key={t} role="radio" aria-checked={theme === t} variant={theme === t ? "primary" : "secondary"} onClick={() => setTheme(t)}>
                {t === "light" ? "Light" : "Dark"}
              </Button>
            ))}
          </div>
        </div>
      </Card>
      <Card title={`Change password (${user?.username})`}>
        <form
          className="space-y-3 p-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (next !== confirm) return setError(new Error("The new passwords do not match"));
            change.mutate();
          }}
        >
          <Field label="Current password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
          <Field label="New password" hint="At least 10 characters">{(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
          <Field label="Confirm new password">{(id) => <Input id={id} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}</Field>
          <ErrorMessage error={error} />
          <Button type="submit" variant="primary" loading={change.isPending}>Change password</Button>
        </form>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ Audit

function AuditTab() {
  const [page, setPage] = useState(1);
  const audit = useQuery({ queryKey: ["audit", page], queryFn: () => api<Page<AuditEntry>>(`/audit${toQuery({ page, pageSize: 50 })}`) });
  const describe = (d: Record<string, unknown>): ReactNode => {
    const entries = Object.entries(d);
    return entries.length ? entries.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`).join(" · ") : "";
  };
  return (
    <Card title="Audit log">
      {audit.isLoading ? <Spinner /> : audit.error ? <div className="p-4"><ErrorMessage error={audit.error} /></div> : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-ink-secondary">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Time</th>
                  <th scope="col" className="px-4 py-2 font-medium">User</th>
                  <th scope="col" className="px-4 py-2 font-medium">Action</th>
                  <th scope="col" className="px-4 py-2 font-medium">Details</th>
                  <th scope="col" className="px-4 py-2 font-medium">IP</th>
                </tr>
              </thead>
              <tbody>
                {audit.data?.items.map((a) => (
                  <tr key={a.id} className="border-t border-line align-top">
                    <td className="tabular whitespace-nowrap px-4 py-2 text-ink-secondary">{absoluteTime(a.created_at)}</td>
                    <td className="px-4 py-2">{a.actor_username}</td>
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs">{a.action}</td>
                    <td className="max-w-md px-4 py-2 text-xs text-ink-secondary">{describe(a.details)}</td>
                    <td className="tabular px-4 py-2 text-xs text-ink-muted">{a.ip}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {audit.data && <div className="border-t border-line"><Pagination page={page} pageSize={50} total={audit.data.total} onPage={setPage} /></div>}
        </>
      )}
    </Card>
  );
}
