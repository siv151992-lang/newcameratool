import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, KeyRound, PlugZap, Save, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { Brand, CameraDetail, CameraPasswordPolicyView, ConnectionResult, MonitoringSettings } from "../api/types";
import { Diagnostics } from "../components/Diagnostics";
import { Button, Card, Checkbox, ConfirmDialog, ErrorMessage, Field, Input, PageHeader, Select, Spinner, Textarea } from "../components/ui";
import { useToast } from "../components/toast";
import { useInvalidateCameras } from "../hooks/cameras";
import { previewChecks } from "../lib/cameraPassword";
import { capabilityLabel } from "../lib/format";

interface FormState {
  name: string;
  host: string;
  brand: string;
  model: string;
  username: string;
  password: string;
  location: string;
  port: string;
  protocol: "http" | "https";
  monitoringEnabled: boolean;
  localStorage: boolean;
  priority: "critical" | "normal";
  deviceType: "camera" | "nvr";
  warningThreshold: string;
  criticalThreshold: string;
  caCertificate: string;
}

const EMPTY: FormState = {
  name: "", host: "", brand: "hikvision", model: "", username: "admin", password: "", location: "", port: "",
  protocol: "http", monitoringEnabled: true, localStorage: true, priority: "normal", deviceType: "camera", warningThreshold: "", criticalThreshold: "", caCertificate: "",
};

function fromCamera(c: CameraDetail): FormState {
  return {
    name: c.name, host: c.host, brand: c.brand, model: c.model ?? "", username: c.username ?? "", password: "",
    location: c.location ?? "", port: String(c.port), protocol: c.protocol, monitoringEnabled: c.monitoringEnabled, localStorage: c.localStorage ?? true, priority: c.priority ?? "normal", deviceType: c.deviceType ?? "camera",
    warningThreshold: c.warningThreshold?.toString() ?? "", criticalThreshold: c.criticalThreshold?.toString() ?? "", caCertificate: "",
  };
}

/** Builds the API payload. In edit mode only changed fields are sent and a blank password keeps the stored one. */
function toPayload(f: FormState, original?: FormState) {
  const num = (v: string) => (v.trim() === "" ? null : Number(v));
  const full: Record<string, unknown> = {
    name: f.name, host: f.host, brand: f.brand, model: f.model || null, username: f.username, location: f.location || null,
    port: num(f.port), protocol: f.protocol, monitoringEnabled: f.monitoringEnabled, localStorage: f.localStorage, priority: f.priority, deviceType: f.deviceType,
    warningThreshold: num(f.warningThreshold), criticalThreshold: num(f.criticalThreshold),
  };
  if (f.password) full.password = f.password;
  if (f.caCertificate.trim()) full.caCertificate = f.caCertificate.trim();
  if (!original) return full;
  const orig: Record<string, unknown> = toPayload(original);
  return Object.fromEntries(Object.entries(full).filter(([k, v]) => k === "password" || k === "caCertificate" || orig[k] !== v));
}

export function CameraFormPage() {
  const { id } = useParams();
  const editing = !!id;
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidateCameras();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [original, setOriginal] = useState<FormState>();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [test, setTest] = useState<ConnectionResult | null>(null);
  const [testedSnapshot, setTestedSnapshot] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);

  const brands = useQuery({ queryKey: ["brands"], queryFn: () => api<Brand[]>("/brands") });
  const settings = useQuery({ queryKey: ["settings", "monitoring"], queryFn: () => api<MonitoringSettings>("/settings/monitoring") });
  const camera = useQuery({ queryKey: ["camera", id], queryFn: () => api<CameraDetail>(`/cameras/${id}`), enabled: editing });

  useEffect(() => {
    if (camera.data && !original) {
      const f = fromCamera(camera.data);
      setForm(f);
      setOriginal(f);
    }
  }, [camera.data, original]);

  const brand = brands.data?.find((b) => b.key === form.brand);
  const credentials = brand?.credentials ?? "user_password";
  // Choosing a brand applies its default protocol (the port placeholder follows) for a new camera.
  const chooseBrand = (key: string) => {
    const b = brands.data?.find((x) => x.key === key);
    setForm((f) => ({ ...f, brand: key, ...(!editing && b?.defaultProtocol ? { protocol: b.defaultProtocol, port: "" } : {}) }));
    setErrors((e) => ({ ...e, brand: "" }));
  };
  const defaultPort = brand ? (form.protocol === "https" ? brand.defaultPorts.https : brand.defaultPorts.http) : form.protocol === "https" ? 443 : 80;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => ({ ...e, [k]: "" }));
  };
  useEffect(() => {
    // The default brand may be disabled: start a new camera on the first available one instead.
    const usable = brands.data?.filter((b) => b.supportStatus !== "planned") ?? [];
    if (!editing && usable.length && !usable.some((b) => b.key === form.brand)) chooseBrand(usable[0]!.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brands.data, editing]);
  const snapshot = useMemo(() => JSON.stringify(toPayload(form)), [form]);
  const testIsCurrent = test && testedSnapshot === snapshot;

  const handleError = (err: unknown) => {
    if (err instanceof ApiError && err.fieldErrors.length) {
      const map: Record<string, string> = {};
      for (const fe of err.fieldErrors) map[fe.field] = fe.message;
      setErrors(map);
      setFormError(new Error("Please correct the highlighted fields."));
    } else {
      setFormError(err);
    }
  };

  const testMutation = useMutation({
    mutationFn: () =>
      editing
        ? api<ConnectionResult>(`/cameras/${id}/test-connection`, { method: "POST", body: toPayload(form, original) })
        : api<ConnectionResult>("/cameras/test-connection", { method: "POST", body: toPayload(form) }),
    onMutate: () => {
      setFormError(null);
      setTest(null);
    },
    onSuccess: (r) => {
      setTest(r);
      setTestedSnapshot(snapshot);
    },
    onError: handleError,
  });

  const save = useMutation({
    mutationFn: () =>
      editing
        ? api<CameraDetail>(`/cameras/${id}`, { method: "PATCH", body: toPayload(form, original) })
        : api<CameraDetail>("/cameras", { method: "POST", body: toPayload(form) }),
    onSuccess: (c) => {
      invalidate();
      toast("success", editing ? `Saved changes to ${c.name}` : `${c.name} added — first storage check scheduled`);
      navigate(`/cameras/${c.id}`);
    },
    onError: (e) => {
      setConfirmOpen(false);
      handleError(e);
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    // Saving without a current, successful test needs an explicit confirmation.
    if (!testIsCurrent || !test?.ok) setConfirmOpen(true);
    else save.mutate();
  };

  if (editing && camera.isLoading) return <Spinner label="Loading camera" />;
  if (editing && camera.error) return <ErrorMessage error={camera.error} />;

  const s = settings.data;
  return (
    <>
      <PageHeader
        title={editing ? `Edit ${camera.data?.name ?? "camera"}` : "Add camera"}
        description={editing ? "Change settings or rotate credentials. Leave the password blank to keep the current one." : "Enter the camera's address and credentials, test the connection, then save."}
      />
      <form onSubmit={onSubmit} className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]" noValidate>
        <div className="space-y-5">
          <Card title="Camera">
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <Field label="Camera name" required error={errors.name}>
                {(fid, d) => <Input id={fid} aria-describedby={d} value={form.name} onChange={(e) => set("name", e.target.value)} invalid={!!errors.name} required maxLength={120} />}
              </Field>
              <Field
                label="Brand / manufacturer"
                required
                error={errors.brand}
                hint={
                  brand ? (
                    <>
                      {brand.notes}
                      {brand.capabilities.length > 0 && <span className="mt-1 block text-ink-muted">Capabilities: {brand.capabilities.map(capabilityLabel).join(", ")}</span>}
                    </>
                  ) : editing ? (
                    "This camera's integration is disabled. An administrator can enable it in Settings → Camera brands, or choose another brand."
                  ) : undefined
                }
              >
                {(fid, d) => (
                  <Select id={fid} aria-describedby={d} value={form.brand} onChange={(e) => chooseBrand(e.target.value)}>
                    {/* Only enabled integrations are listed; keep a disabled one visible when editing its camera. */}
                    {editing && brands.data && !brand && <option value={form.brand}>{camera.data?.brandName ?? form.brand} (disabled)</option>}
                    {brands.data?.map((b) => (
                      <option key={b.key} value={b.key} disabled={b.supportStatus === "planned"}>
                        {b.displayName}
                        {b.supportStatus === "planned" ? " (planned)" : b.supportStatus === "unverified" ? " (unverified)" : ""}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="IP address or hostname" required error={errors.host} hint="For example 10.10.15.57. No http:// or paths.">
                {(fid, d) => <Input id={fid} aria-describedby={d} value={form.host} onChange={(e) => set("host", e.target.value)} invalid={!!errors.host} required autoComplete="off" spellCheck={false} />}
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Protocol" error={errors.protocol}>
                  {(fid) => (
                    <Select id={fid} value={form.protocol} onChange={(e) => set("protocol", e.target.value as "http" | "https")}>
                      <option value="http">HTTP</option>
                      <option value="https">HTTPS</option>
                    </Select>
                  )}
                </Field>
                <Field label="Port" error={errors.port} hint={`Default ${defaultPort}`}>
                  {(fid, d) => <Input id={fid} aria-describedby={d} inputMode="numeric" placeholder={String(defaultPort)} value={form.port} onChange={(e) => set("port", e.target.value.replace(/\D/g, ""))} invalid={!!errors.port} />}
                </Field>
              </div>
              <Field label="Model" error={errors.model} hint="Optional. Filled in automatically from the camera when available.">
                {(fid, d) => <Input id={fid} aria-describedby={d} value={form.model} onChange={(e) => set("model", e.target.value)} />}
              </Field>
              <Field label="Location" error={errors.location} hint="Optional, e.g. Reception or Floor 2 – East">
                {(fid, d) => <Input id={fid} aria-describedby={d} value={form.location} onChange={(e) => set("location", e.target.value)} />}
              </Field>
            </div>
            {form.protocol === "http" && (
              <p className="border-t border-line px-4 py-3 text-xs text-ink-secondary">
                HTTP is unencrypted. Credentials are protected by Digest authentication, but storage data is sent in clear text. Use HTTPS if the camera supports it.
              </p>
            )}
          </Card>

          <Card title="Credentials">
            {credentials === "none" ? (
              <p className="p-4 text-sm text-ink-secondary">This integration does not use credentials. Make sure the camera is only reachable from trusted networks.</p>
            ) : (
              <div className="grid gap-4 p-4 sm:grid-cols-2">
                {credentials === "user_password" && (
                  <Field label="Username" required error={errors.username}>
                    {(fid, d) => <Input id={fid} aria-describedby={d} value={form.username} onChange={(e) => set("username", e.target.value)} autoComplete="off" invalid={!!errors.username} required />}
                  </Field>
                )}
                <Field
                  label={credentials === "secret" ? (editing ? "New API key or token" : "API key or token") : editing ? "New password" : "Password"}
                  required={!editing}
                  error={errors.password}
                  hint={editing ? "Leave blank to keep the stored value." : "Stored encrypted on the server. Never shown again."}
                  className={credentials === "secret" ? "sm:col-span-2" : undefined}
                >
                  {(fid, d) => <Input id={fid} aria-describedby={d} type="password" value={form.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" invalid={!!errors.password} required={!editing} />}
                </Field>
                {credentials === "user_password" && form.password && <PasswordChecklist password={form.password} username={form.username} />}
              </div>
            )}
            {form.protocol === "https" && (
              <div className="border-t border-line p-4">
                <CameraCertificate
                  host={form.host}
                  port={form.port}
                  onTrust={(pem) => set("caCertificate", pem)}
                />
                <Field
                  label="Camera CA certificate (optional)"
                  error={errors.caCertificate}
                  hint={
                    editing && camera.data?.hasCaCertificate
                      ? "A certificate is stored. Paste a new PEM to replace it."
                      : "Cameras usually make their own (self-signed) certificate: get it above and trust it, or paste a certificate (PEM). Certificate checks are never disabled."
                  }
                >
                  {(fid, d) => <Textarea id={fid} aria-describedby={d} placeholder="-----BEGIN CERTIFICATE-----" value={form.caCertificate} onChange={(e) => set("caCertificate", e.target.value)} />}
                </Field>
              </div>
            )}
          </Card>

          <Card title="Monitoring">
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Checkbox
                  label="Monitoring enabled"
                  description="When disabled, the configuration is kept but no checks or alerts run."
                  checked={form.monitoringEnabled}
                  onChange={(e) => set("monitoringEnabled", e.target.checked)}
                />
                <div className="mt-3">
                  <Checkbox
                    label="This is an NVR"
                    description="A network video recorder: its hard disks are monitored as its storage, and each channel (camera) is checked for video and recording."
                    checked={form.deviceType === "nvr"}
                    onChange={(e) => setForm((f) => ({ ...f, deviceType: e.target.checked ? "nvr" : "camera", localStorage: e.target.checked ? true : f.localStorage }))}
                  />
                </div>
                <div className="mt-3">
                  <Checkbox
                    label="Records to an SD card or local storage"
                    description="Untick for cameras that record elsewhere (e.g. to an NVR) and have no SD card. They are still checked for being online, but storage and recording alerts are off."
                    checked={form.localStorage}
                    onChange={(e) => set("localStorage", e.target.checked)}
                  />
                </div>
                <div className="mt-3">
                  <Checkbox
                    label="Critical area"
                    description="For cameras covering critical areas (entrances, server rooms, cash counters): listed first, and every problem is raised as critical."
                    checked={form.priority === "critical"}
                    onChange={(e) => set("priority", e.target.checked ? "critical" : "normal")}
                  />
                </div>
              </div>
              <Field label="Warning threshold (%)" error={errors.warningThreshold} hint={`Blank uses the global default (${s?.warningThresholdPercent ?? 80}%)`}>
                {(fid, d) => <Input id={fid} aria-describedby={d} inputMode="decimal" placeholder={String(s?.warningThresholdPercent ?? 80)} value={form.warningThreshold} onChange={(e) => set("warningThreshold", e.target.value)} invalid={!!errors.warningThreshold} />}
              </Field>
              <Field label="Critical threshold (%)" error={errors.criticalThreshold} hint={`Blank uses the global default (${s?.criticalThresholdPercent ?? 90}%)`}>
                {(fid, d) => <Input id={fid} aria-describedby={d} inputMode="decimal" placeholder={String(s?.criticalThresholdPercent ?? 90)} value={form.criticalThreshold} onChange={(e) => set("criticalThreshold", e.target.value)} invalid={!!errors.criticalThreshold} />}
              </Field>
            </div>
          </Card>
        </div>

        <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <Card title="Test connection">
            <div className="space-y-3 p-4">
              <p className="text-sm text-ink-secondary">
                Checks reachability, authentication, API availability and storage, using the values in this form. Nothing is saved.
              </p>
              <Button className="w-full" icon={<PlugZap className="h-4 w-4" />} loading={testMutation.isPending} onClick={() => testMutation.mutate()}>
                Test connection
              </Button>
              {test && <Diagnostics result={test} />}
              {test && !testIsCurrent && <p className="text-xs text-ink-muted">The form changed since this test. Test again to confirm.</p>}
            </div>
          </Card>
          <ErrorMessage error={formError} />
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => navigate(-1)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" className="flex-1" icon={<Save className="h-4 w-4" />} loading={save.isPending}>
              {editing ? "Save changes" : "Save camera"}
            </Button>
          </div>
        </div>
      </form>

      <ConfirmDialog
        open={confirmOpen}
        title={!testIsCurrent ? "Save without testing?" : "Save despite the failed test?"}
        confirmLabel="Save anyway"
        onConfirm={() => save.mutate()}
        onCancel={() => setConfirmOpen(false)}
        loading={save.isPending}
      >
        {!testIsCurrent ? (
          <p>This configuration has not been tested. You can save it now; the camera's status will show any problem after the first check.</p>
        ) : (
          <>
            <p>The connection test did not complete:</p>
            <p className="mt-2 rounded-md bg-page px-3 py-2 text-ink-secondary">{test?.error?.message ?? "Storage information could not be retrieved."}</p>
            <p className="mt-2">You can still save the camera to diagnose it later. Its status will show the error until checks succeed.</p>
          </>
        )}
      </ConfirmDialog>
    </>
  );
}

/** The camera password against the organization's policy, as it is typed. */
function PasswordChecklist({ password, username }: { password: string; username: string }) {
  const policy = useQuery({ queryKey: ["camera-password-rules"], queryFn: () => api<Pick<CameraPasswordPolicyView, "policy">>("/settings/camera-password-rules"), staleTime: 60_000 });
  const p = policy.data?.policy;
  if (!p) return null;
  const checks = previewChecks(password, username, p);
  const failing = checks.filter((c) => !c.ok).length;
  return (
    <div className="rounded-md border border-line bg-raised p-3 text-sm sm:col-span-2" aria-live="polite">
      <p className="font-medium">
        {failing === 0 ? "Meets the camera password policy" : p.enforcement === "block" ? "Does not meet the camera password policy: it cannot be saved" : "Does not meet the camera password policy: it can be saved, and the camera is flagged as weak"}
      </p>
      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
        {checks.map((c) => (
          <li key={c.label} className="flex items-center gap-2">
            {c.ok ? <Check className="h-4 w-4 shrink-0 text-good" aria-hidden /> : <X className="h-4 w-4 shrink-0 text-bad" aria-hidden />}
            <span className={c.ok ? "text-ink-secondary" : undefined}>{c.label}</span>
            <span className="sr-only">{c.ok ? "(met)" : "(not met)"}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-ink-secondary">Set the same password on the camera itself; this app only stores it to read the camera.</p>
    </div>
  );
}

interface FetchedCertificate {
  pem: string;
  fingerprint256: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  selfSigned: boolean;
}

/**
 * Gets the certificate the camera presents on HTTPS and shows its fingerprint, so the user can
 * trust that exact certificate (it becomes the camera's TLS CA certificate).
 */
function CameraCertificate({ host, port, onTrust }: { host: string; port: string; onTrust: (pem: string) => void }) {
  const [trusted, setTrusted] = useState<string | null>(null);
  const fetchCert = useMutation({
    mutationFn: () => api<FetchedCertificate>("/cameras/tls-certificate", { method: "POST", body: { host, port: port.trim() ? Number(port) : 443 } }),
    onSuccess: () => setTrusted(null),
  });
  const c = fetchCert.data;
  return (
    <div className="mb-4 rounded-md border border-line bg-raised/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-secondary">Most cameras use their own certificate for HTTPS. Get it, check it, and trust it for this camera.</p>
        <Button size="sm" icon={<KeyRound className="h-4 w-4" />} onClick={() => fetchCert.mutate()} loading={fetchCert.isPending} disabled={!host.trim()}>
          Get the camera's certificate
        </Button>
      </div>
      {fetchCert.error && <ErrorMessage error={fetchCert.error} className="mt-2" />}
      {c && (
        <div className="mt-3 space-y-2 text-sm">
          <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[auto_1fr]">
            <dt className="text-ink-secondary">Issued to</dt>
            <dd className="break-all">{c.subject}{c.selfSigned && <span className="ml-2 text-xs text-ink-muted">(self-signed)</span>}</dd>
            <dt className="text-ink-secondary">Valid</dt>
            <dd>
              {c.validFrom.slice(0, 10)} to {c.validTo.slice(0, 10)}
              {Date.parse(c.validTo) < Date.now() && <span className="ml-1 text-ink-secondary">(expired, as cameras' own certificates often are: trusting it here still works)</span>}
            </dd>
            <dt className="text-ink-secondary">SHA-256 fingerprint</dt>
            <dd className="break-all font-mono text-xs">{c.fingerprint256}</dd>
          </dl>
          <p className="text-xs text-ink-muted">If you can, compare the fingerprint with the one the camera's web page shows, then trust it.</p>
          {trusted === c.fingerprint256 ? (
            <p className="flex items-center gap-1.5 text-sm text-good"><ShieldCheck className="h-4 w-4" aria-hidden /> Trusted: save the camera to keep it.</p>
          ) : (
            <Button size="sm" variant="primary" icon={<ShieldCheck className="h-4 w-4" />} onClick={() => { onTrust(c.pem); setTrusted(c.fingerprint256); }}>
              Trust this certificate
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
