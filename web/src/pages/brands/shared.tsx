import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { AlertTriangle, CheckCircle2, CircleDashed, Plus, Trash2, XCircle } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type {
  ByteUnit,
  IntegrationCamera,
  IntegrationConfig,
  IntegrationTestResult,
  MappingResult,
  NameValue,
  Page,
} from "../../api/types";
import { Button, Field, Input, Select, Textarea } from "../../components/ui";
import { formatBytes, formatPercent } from "../../lib/format";

export const UNITS: ByteUnit[] = ["B", "KB", "MB", "GB", "TB", "KiB", "MiB", "GiB", "TiB"];

export const AUTH_LABELS: Record<string, string> = {
  none: "No authentication",
  basic: "HTTP Basic (HTTPS only)",
  digest: "HTTP Digest",
  api_key: "API key (HTTPS only)",
  bearer: "Bearer token (HTTPS only)",
};

export const CREDENTIAL_LABELS: Record<string, string> = {
  user_password: "Username and password",
  secret: "API key or token",
  none: "None",
};

/** What the configurable framework cannot do; such brands need a custom adapter (Mode B). */
export const NEEDS_CUSTOM_ADAPTER = [
  "Login flows that first obtain a session cookie or token (e.g. POST /login, then use the session)",
  "OAuth, request signing (HMAC, AWS-style), challenge-response or vendor cryptography",
  "SOAP with WS-Security (use the built-in ONVIF adapter), or several dependent requests",
  "Non-HTTP or proprietary binary protocols, websockets, and plain-text key=value replies",
  "Values that need calculation beyond unit conversion (e.g. blocks × block size)",
];

// ------------------------------------------------------------------ form model

/** Editable form state; empty optional paths are dropped by toConfig(). */
export interface ConfigForm {
  method: "GET" | "POST";
  path: string;
  query: NameValue[];
  headers: NameValue[];
  body: string;
  contentType: string;
  timeoutSeconds: string;
  authType: IntegrationConfig["auth"]["type"];
  apiKeyIn: "header" | "query";
  apiKeyName: string;
  pagination: "none" | "page";
  pageParam: string;
  firstPage: "0" | "1";
  pageSizeParam: string;
  pageSize: string;
  maxPages: string;
  format: "json" | "xml";
  devicesPath: string;
  idPath: string;
  namePath: string;
  totalPath: string;
  totalUnit: ByteUnit;
  freePath: string;
  freeUnit: ByteUnit;
  usedPath: string;
  usedUnit: ByteUnit;
  healthPath: string;
  readWritePath: string;
  healthy: string;
  degraded: string;
  unhealthy: string;
  absent: string;
  readWrite: string;
  readOnly: string;
  deviceInfo: boolean;
  infoPath: string;
  infoFormat: "json" | "xml";
  infoModel: string;
  infoSerial: string;
  infoFirmware: string;
  infoName: string;
  maxConcurrency: string;
}

export const EMPTY_CONFIG: ConfigForm = {
  method: "GET", path: "", query: [], headers: [], body: "", contentType: "", timeoutSeconds: "10",
  authType: "digest", apiKeyIn: "header", apiKeyName: "X-API-Key",
  pagination: "none", pageParam: "page", firstPage: "1", pageSizeParam: "", pageSize: "", maxPages: "5",
  format: "json", devicesPath: "", idPath: "", namePath: "", totalPath: "", totalUnit: "B", freePath: "", freeUnit: "B", usedPath: "", usedUnit: "B",
  healthPath: "", readWritePath: "",
  healthy: "normal, ok, healthy, ready", degraded: "formatting, repairing, initializing", unhealthy: "error, abnormal, failed, broken, damaged", absent: "absent, nocard, notexist, none",
  readWrite: "rw, readwrite", readOnly: "ro, readonly",
  deviceInfo: false, infoPath: "", infoFormat: "json", infoModel: "", infoSerial: "", infoFirmware: "", infoName: "",
  maxConcurrency: "5",
};

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const joined = (a: string[] | undefined) => (a ?? []).join(", ");
const cleanPairs = (p: NameValue[]) => p.filter((x) => x.name.trim() !== "");

export function toConfig(f: ConfigForm): IntegrationConfig {
  const field = (path: string, unit: ByteUnit) => (path.trim() ? { path: path.trim(), unit } : undefined);
  const opt = (s: string) => (s.trim() ? s.trim() : undefined);
  return {
    request: {
      method: f.method,
      path: f.path.trim(),
      query: cleanPairs(f.query),
      headers: cleanPairs(f.headers),
      body: f.method === "POST" && f.body ? f.body : null,
      contentType: f.method === "POST" && f.contentType.trim() ? f.contentType.trim() : null,
      timeoutMs: Math.round(Number(f.timeoutSeconds || "10") * 1000),
    },
    auth: f.authType === "api_key" ? { type: "api_key", apiKeyIn: f.apiKeyIn, apiKeyName: f.apiKeyName.trim() } : { type: f.authType },
    pagination:
      f.pagination === "page"
        ? {
            type: "page", pageParam: f.pageParam.trim(), firstPage: f.firstPage === "0" ? 0 : 1, maxPages: Number(f.maxPages || "5"),
            ...(f.pageSizeParam.trim() && f.pageSize ? { pageSizeParam: f.pageSizeParam.trim(), pageSize: Number(f.pageSize) } : {}),
          }
        : { type: "none" },
    response: {
      format: f.format,
      devicesPath: f.devicesPath.trim(),
      fields: {
        id: opt(f.idPath), name: opt(f.namePath),
        total: { path: f.totalPath.trim(), unit: f.totalUnit },
        free: field(f.freePath, f.freeUnit), used: field(f.usedPath, f.usedUnit),
        health: opt(f.healthPath), readWrite: opt(f.readWritePath),
      },
      healthValues: { healthy: list(f.healthy), degraded: list(f.degraded), unhealthy: list(f.unhealthy), absent: list(f.absent) },
      readWriteValues: { readWrite: list(f.readWrite), readOnly: list(f.readOnly) },
    },
    deviceInfo: f.deviceInfo && f.infoPath.trim()
      ? { path: f.infoPath.trim(), query: [], format: f.infoFormat, fields: { model: opt(f.infoModel), serialNumber: opt(f.infoSerial), firmwareVersion: opt(f.infoFirmware), deviceName: opt(f.infoName) } }
      : null,
    maxConcurrency: Number(f.maxConcurrency || "5"),
  };
}

export function fromConfig(c: IntegrationConfig): ConfigForm {
  const r = c.response;
  return {
    ...EMPTY_CONFIG,
    method: c.request.method, path: c.request.path, query: c.request.query, headers: c.request.headers,
    body: c.request.body ?? "", contentType: c.request.contentType ?? "", timeoutSeconds: String(c.request.timeoutMs / 1000),
    authType: c.auth.type, apiKeyIn: c.auth.apiKeyIn ?? "header", apiKeyName: c.auth.apiKeyName ?? "X-API-Key",
    pagination: c.pagination.type,
    ...(c.pagination.type === "page"
      ? { pageParam: c.pagination.pageParam, firstPage: String(c.pagination.firstPage) as "0" | "1", pageSizeParam: c.pagination.pageSizeParam ?? "", pageSize: c.pagination.pageSize ? String(c.pagination.pageSize) : "", maxPages: String(c.pagination.maxPages) }
      : {}),
    format: r.format, devicesPath: r.devicesPath, idPath: r.fields.id ?? "", namePath: r.fields.name ?? "",
    totalPath: r.fields.total.path, totalUnit: r.fields.total.unit,
    freePath: r.fields.free?.path ?? "", freeUnit: r.fields.free?.unit ?? "B", usedPath: r.fields.used?.path ?? "", usedUnit: r.fields.used?.unit ?? "B",
    healthPath: r.fields.health ?? "", readWritePath: r.fields.readWrite ?? "",
    healthy: joined(r.healthValues.healthy), degraded: joined(r.healthValues.degraded), unhealthy: joined(r.healthValues.unhealthy), absent: joined(r.healthValues.absent),
    readWrite: joined(r.readWriteValues.readWrite), readOnly: joined(r.readWriteValues.readOnly),
    deviceInfo: !!c.deviceInfo, infoPath: c.deviceInfo?.path ?? "", infoFormat: c.deviceInfo?.format ?? "json",
    infoModel: c.deviceInfo?.fields.model ?? "", infoSerial: c.deviceInfo?.fields.serialNumber ?? "", infoFirmware: c.deviceInfo?.fields.firmwareVersion ?? "", infoName: c.deviceInfo?.fields.deviceName ?? "",
    maxConcurrency: String(c.maxConcurrency),
  };
}

/** Field errors from the server ("response.fields.total.path") mapped to form keys. */
export const ISSUE_FIELDS: Record<string, keyof ConfigForm> = {
  "request.path": "path", "request.body": "body", "request.contentType": "contentType", "request.timeoutMs": "timeoutSeconds",
  "auth.apiKeyName": "apiKeyName", "auth.apiKeyIn": "apiKeyIn", "pagination.pageParam": "pageParam",
  "response.devicesPath": "devicesPath", "response.fields.id": "idPath", "response.fields.name": "namePath",
  "response.fields.total.path": "totalPath", "response.fields.free": "freePath", "response.fields.free.path": "freePath",
  "response.fields.used.path": "usedPath", "response.fields.health": "healthPath", "response.fields.readWrite": "readWritePath",
  "deviceInfo.path": "infoPath",
};

// ------------------------------------------------------------------ small editors

export function PairsEditor({ label, value, onChange, namePlaceholder, valuePlaceholder, hint, disabled }: {
  label: string; value: NameValue[]; onChange: (v: NameValue[]) => void; namePlaceholder: string; valuePlaceholder: string; hint?: string; disabled?: boolean;
}) {
  const update = (i: number, k: keyof NameValue, v: string) => onChange(value.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1 text-sm font-medium text-ink">{label}</legend>
      {value.map((p, i) => (
        <div key={i} className="flex gap-2">
          <Input aria-label={`${label} name ${i + 1}`} placeholder={namePlaceholder} value={p.name} onChange={(e) => update(i, "name", e.target.value)} disabled={disabled} className="w-full" />
          <Input aria-label={`${label} value ${i + 1}`} placeholder={valuePlaceholder} value={p.value} onChange={(e) => update(i, "value", e.target.value)} disabled={disabled} className="w-full" />
          <Button variant="ghost" size="sm" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} icon={<Trash2 className="h-4 w-4" />} onClick={() => onChange(value.filter((_, j) => j !== i))} disabled={disabled} />
        </div>
      ))}
      <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => onChange([...value, { name: "", value: "" }])} disabled={disabled || value.length >= 20}>
        Add {label.toLowerCase().replace(/s$/, "")}
      </Button>
      {hint && <p className="text-xs text-ink-muted">{hint}</p>}
    </fieldset>
  );
}

export function PathWithUnit({ label, path, unit, onPath, onUnit, error, hint, required }: {
  label: string; path: string; unit: ByteUnit; onPath: (v: string) => void; onUnit: (v: ByteUnit) => void; error?: string; hint?: string; required?: boolean;
}) {
  return (
    <Field label={label} error={error} hint={hint} required={required}>
      {(id, d) => (
        <div className="flex gap-2">
          <Input id={id} aria-describedby={d} value={path} onChange={(e) => onPath(e.target.value)} invalid={!!error} spellCheck={false} className="w-full font-mono text-xs" />
          <Select aria-label={`${label} unit`} value={unit} onChange={(e) => onUnit(e.target.value as ByteUnit)} className="w-24">
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </Select>
        </div>
      )}
    </Field>
  );
}

// ------------------------------------------------------------------ test target

export type TestTarget =
  | { cameraId: string }
  | { host: string; port: number; protocol: "http" | "https"; username: string; password: string; caCertificate?: string | null };

interface TargetForm {
  mode: "manual" | "camera";
  cameraId: string;
  host: string;
  port: string;
  protocol: "http" | "https";
  username: string;
  password: string;
}

/** Where a backend test request goes: a camera already using the brand, or a test camera's address. */
export function useTestTarget(brandKey: string | undefined, defaults: { protocol: "http" | "https"; ports: { http: number; https: number } }) {
  const [t, setT] = useState<TargetForm>({ mode: "manual", cameraId: "", host: "", port: "", protocol: defaults.protocol, username: "", password: "" });
  const cameras = useQuery({
    queryKey: ["integrations", brandKey, "cameras", "all"],
    queryFn: () => api<Page<Pick<IntegrationCamera, "id" | "name" | "host">>>(`/integrations/${brandKey}/cameras?pageSize=100`),
    enabled: !!brandKey,
  });
  const target: TestTarget | null =
    t.mode === "camera"
      ? t.cameraId ? { cameraId: t.cameraId } : null
      : t.host.trim()
        ? { host: t.host.trim(), port: Number(t.port || (t.protocol === "https" ? defaults.ports.https : defaults.ports.http)), protocol: t.protocol, username: t.username, password: t.password }
        : null;
  return { form: t, setForm: setT, cameras: cameras.data?.items ?? [], target };
}

export function TestTargetFields({ state, credentials }: { state: ReturnType<typeof useTestTarget>; credentials: string }) {
  const { form: t, setForm, cameras } = state;
  const set = <K extends keyof TargetForm>(k: K, v: TargetForm[K]) => setForm({ ...t, [k]: v });
  return (
    <div className="space-y-3">
      {cameras.length > 0 && (
        <Field label="Test against">
          {(id) => (
            <Select id={id} value={t.mode} onChange={(e) => set("mode", e.target.value as TargetForm["mode"])}>
              <option value="manual">A test camera (enter its address)</option>
              <option value="camera">A camera registered with this brand</option>
            </Select>
          )}
        </Field>
      )}
      {t.mode === "camera" ? (
        <Field label="Camera" hint="Its stored, encrypted credentials are used on the server.">
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={t.cameraId} onChange={(e) => set("cameraId", e.target.value)}>
              <option value="">Choose a camera…</option>
              {cameras.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.host})</option>)}
            </Select>
          )}
        </Field>
      ) : (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_7rem_6rem]">
          <Field label="Camera IP or hostname" hint="Must be inside Settings → Camera networks.">
            {(id, d) => <Input id={id} aria-describedby={d} value={t.host} onChange={(e) => set("host", e.target.value)} placeholder="10.10.15.57" spellCheck={false} />}
          </Field>
          <Field label="Protocol">
            {(id) => (
              <Select id={id} value={t.protocol} onChange={(e) => set("protocol", e.target.value as "http" | "https")}>
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
              </Select>
            )}
          </Field>
          <Field label="Port">
            {(id) => <Input id={id} inputMode="numeric" value={t.port} onChange={(e) => set("port", e.target.value.replace(/\D/g, ""))} placeholder="Default" />}
          </Field>
          {credentials === "user_password" && (
            <Field label="Username">
              {(id) => <Input id={id} value={t.username} onChange={(e) => set("username", e.target.value)} autoComplete="off" />}
            </Field>
          )}
          {credentials !== "none" && (
            <Field label={credentials === "secret" ? "API key or token" : "Password"} hint="Used for this test only; never stored or shown again." className="sm:col-span-2">
              {(id, d) => <Input id={id} aria-describedby={d} type="password" value={t.password} onChange={(e) => set("password", e.target.value)} autoComplete="new-password" />}
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ results

const STEP_ICONS = {
  passed: <CheckCircle2 className="h-4 w-4 text-good" aria-hidden />,
  failed: <XCircle className="h-4 w-4 text-bad" aria-hidden />,
  warning: <AlertTriangle className="h-4 w-4 text-warn" aria-hidden />,
  skipped: <CircleDashed className="h-4 w-4 text-unknown" aria-hidden />,
};

export function MappingView({ mapping }: { mapping: MappingResult }) {
  const r = mapping.reading;
  return (
    <div className="space-y-3">
      {(mapping.missing.length > 0 || mapping.errors.length > 0) && (
        <div className="rounded-md border border-bad/40 bg-bad/10 p-3 text-sm">
          {mapping.missing.length > 0 && <p><strong>Missing required fields:</strong> {mapping.missing.join(", ")}</p>}
          {mapping.errors.length > 0 && (
            <ul className="mt-1 list-disc pl-5">
              {mapping.errors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
        </div>
      )}
      {mapping.warnings.length > 0 && (
        <ul className="list-disc rounded-md border border-warn/50 bg-warn/10 p-3 pl-8 text-sm">
          {mapping.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      {mapping.devices.map((d) => (
        <div key={d.index} className="overflow-x-auto rounded-md border border-line">
          <div className="flex items-center justify-between border-b border-line bg-raised/50 px-3 py-1.5 text-xs font-medium">
            <span>Device {d.index + 1}{d.device?.name ? ` · ${d.device.name}` : ""}</span>
            <span className="text-ink-muted">{d.skipped ?? (d.device ? `Status: ${d.device.healthStatus}` : "")}</span>
          </div>
          <table className="w-full text-left text-xs">
            <thead className="text-ink-muted">
              <tr><th className="px-3 py-1 font-medium">Normalized field</th><th className="px-3 py-1 font-medium">Path</th><th className="px-3 py-1 font-medium">Vendor value</th><th className="px-3 py-1 font-medium">Result</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d.fields.map((f) => (
                <tr key={f.field}>
                  <td className="px-3 py-1">{f.field}</td>
                  <td className="px-3 py-1 font-mono">{f.path}</td>
                  <td className="px-3 py-1 font-mono">{f.raw ?? "—"}</td>
                  <td className={clsx("px-3 py-1", f.error && (f.error === "Not found" ? "text-ink-muted" : "text-bad"))}>
                    {f.error === "Not found" ? "Not in response" : f.error ?? (typeof f.value === "number" && /capacity/i.test(f.field) ? `${formatBytes(f.value)} (${f.value.toLocaleString()} B)` : String(f.value ?? "—"))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <dl className="grid grid-cols-2 gap-2 rounded-md border border-line p-3 text-sm sm:grid-cols-5">
        <div><dt className="text-ink-muted">Devices</dt><dd className="tabular font-medium">{r.devices.length}</dd></div>
        <div><dt className="text-ink-muted">Total</dt><dd className="tabular font-medium">{formatBytes(r.totalBytes)}</dd></div>
        <div><dt className="text-ink-muted">Used</dt><dd className="tabular font-medium">{formatBytes(r.usedBytes)}</dd></div>
        <div><dt className="text-ink-muted">Free</dt><dd className="tabular font-medium">{formatBytes(r.freeBytes)}</dd></div>
        <div><dt className="text-ink-muted">Utilization</dt><dd className="tabular font-medium">{formatPercent(r.usedPercentage)}</dd></div>
      </dl>
    </div>
  );
}

export function TestResultView({ result }: { result: IntegrationTestResult }) {
  const [showSample, setShowSample] = useState(false);
  return (
    <div className="space-y-3" aria-live="polite">
      <div className={clsx("rounded-md border px-3 py-2 text-sm", result.ok ? "border-good/40 bg-good/10" : "border-bad/40 bg-bad/10")}>
        <strong>{result.outcomeLabel}</strong>
        {result.version !== null && <span className="text-ink-muted"> · configuration version {result.version}</span>}
        <span className="text-ink-muted"> · {result.durationMs} ms</span>
        <div className="mt-0.5 text-ink-secondary">{result.message}</div>
      </div>
      <ol className="space-y-2">
        {result.steps.map((s) => (
          <li key={s.key + s.label} className="flex items-start gap-2 text-sm">
            <span className="mt-0.5">{STEP_ICONS[s.status]}</span>
            <div><span className="font-medium">{s.label}</span><div className="text-ink-secondary">{s.message}</div></div>
          </li>
        ))}
      </ol>
      {result.deviceInfo && Object.keys(result.deviceInfo).length > 0 && (
        <p className="text-sm text-ink-secondary">
          Device: {[result.deviceInfo.model, result.deviceInfo.firmwareVersion && `firmware ${result.deviceInfo.firmwareVersion}`, result.deviceInfo.serialNumber && `serial ${result.deviceInfo.serialNumber}`].filter(Boolean).join(", ")}
        </p>
      )}
      {result.mapping ? <MappingView mapping={result.mapping} /> : result.storage && (
        <dl className="grid grid-cols-2 gap-2 rounded-md border border-line p-3 text-sm sm:grid-cols-4">
          <div><dt className="text-ink-muted">Total</dt><dd className="tabular font-medium">{formatBytes(result.storage.totalBytes)}</dd></div>
          <div><dt className="text-ink-muted">Used</dt><dd className="tabular font-medium">{formatBytes(result.storage.usedBytes)}</dd></div>
          <div><dt className="text-ink-muted">Free</dt><dd className="tabular font-medium">{formatBytes(result.storage.freeBytes)}</dd></div>
          <div><dt className="text-ink-muted">Utilization</dt><dd className="tabular font-medium">{formatPercent(result.storage.usedPercentage)}</dd></div>
        </dl>
      )}
      {result.sample && (
        <div>
          <Button size="sm" variant="ghost" onClick={() => setShowSample(!showSample)} aria-expanded={showSample}>
            {showSample ? "Hide" : "Show"} sanitised API response
          </Button>
          {showSample && <Textarea readOnly value={result.sample} rows={10} aria-label="Sanitised API response" className="mt-2 w-full" />}
        </div>
      )}
    </div>
  );
}
