import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Check, ChevronLeft, ChevronRight, Download, FlaskConical, Power, Save, Wand2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../../api/client";
import type { IntegrationDetail, IntegrationDetails, IntegrationTestResult, PreviewResult } from "../../api/types";
import { useToast } from "../../components/toast";
import { Button, Card, Checkbox, ErrorMessage, Field, Input, Select, Spinner, Textarea } from "../../components/ui";
import {
  AUTH_LABELS,
  CREDENTIAL_LABELS,
  EMPTY_CONFIG,
  fromConfig,
  ISSUE_FIELDS,
  MappingView,
  NEEDS_CUSTOM_ADAPTER,
  PairsEditor,
  PathWithUnit,
  TestResultView,
  TestTargetFields,
  toConfig,
  useTestTarget,
  type ConfigForm,
} from "./shared";

const STEPS = ["Brand details", "API configuration", "Response mapping", "Test integration", "Review and publish"];

interface DetailsForm {
  displayName: string;
  manufacturer: string;
  description: string;
  supportedModels: string;
  mode: "configurable" | "custom";
  defaultProtocol: "http" | "https";
  defaultHttpPort: string;
  defaultHttpsPort: string;
  integrationVersion: string;
  compatibilityNotes: string;
}

const EMPTY_DETAILS: DetailsForm = {
  displayName: "", manufacturer: "", description: "", supportedModels: "", mode: "configurable", defaultProtocol: "http",
  defaultHttpPort: "80", defaultHttpsPort: "443", integrationVersion: "1.0", compatibilityNotes: "",
};

function toDetails(f: DetailsForm): IntegrationDetails {
  const n = (s: string) => (s.trim() ? s.trim() : null);
  return {
    displayName: f.displayName.trim(), manufacturer: n(f.manufacturer), description: n(f.description),
    supportedModels: f.supportedModels.split(",").map((s) => s.trim()).filter(Boolean),
    defaultProtocol: f.defaultProtocol, defaultHttpPort: Number(f.defaultHttpPort || "80"), defaultHttpsPort: Number(f.defaultHttpsPort || "443"),
    integrationVersion: f.integrationVersion.trim() || "1.0", compatibilityNotes: n(f.compatibilityNotes),
  };
}

const credentialMode = (auth: ConfigForm["authType"]) => (auth === "basic" || auth === "digest" ? "user_password" : auth === "none" ? "none" : "secret");

export function BrandWizard() {
  const { key: routeKey } = useParams();
  const editing = !!routeKey;
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [details, setDetails] = useState<DetailsForm>(EMPTY_DETAILS);
  const [cfg, setCfg] = useState<ConfigForm>(EMPTY_CONFIG);
  const [key, setKey] = useState<string | undefined>(routeKey);
  const [changeNote, setChangeNote] = useState("");
  const [issues, setIssues] = useState<Record<string, string>>({});
  const [issueList, setIssueList] = useState<string[]>([]);
  const [sample, setSample] = useState("");
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [saved, setSaved] = useState<IntegrationDetail | null>(null);
  const [error, setError] = useState<unknown>(null);

  const existing = useQuery({ queryKey: ["integrations", routeKey], queryFn: () => api<IntegrationDetail>(`/integrations/${routeKey}`), enabled: editing });
  useEffect(() => {
    const d = existing.data;
    if (!d || saved) return;
    setSaved(d);
    setDetails({
      displayName: d.displayName, manufacturer: d.manufacturer ?? "", description: d.description ?? "", supportedModels: d.supportedModels.join(", "),
      mode: "configurable", defaultProtocol: d.defaultProtocol, defaultHttpPort: String(d.defaultPorts.http), defaultHttpsPort: String(d.defaultPorts.https),
      integrationVersion: d.integrationVersion, compatibilityNotes: d.compatibilityNotes ?? "",
    });
    if (d.latestConfig) setCfg(fromConfig(d.latestConfig));
  }, [existing.data, saved]);

  const credentials = credentialMode(cfg.authType);
  const target = useTestTarget(key, { protocol: details.defaultProtocol, ports: { http: Number(details.defaultHttpPort) || 80, https: Number(details.defaultHttpsPort) || 443 } });
  const setD = <K extends keyof DetailsForm>(k: K, v: DetailsForm[K]) => setDetails((d) => ({ ...d, [k]: v }));
  const setC = <K extends keyof ConfigForm>(k: K, v: ConfigForm[K]) => {
    setCfg((c) => ({ ...c, [k]: v }));
    setIssues((i) => ({ ...i, [k]: "" }));
  };
  const issue = (k: keyof ConfigForm) => issues[k] || undefined;

  const applyIssues = (list: { field: string; message: string }[]) => {
    const map: Record<string, string> = {};
    const unmatched: string[] = [];
    for (const i of list) {
      const field = ISSUE_FIELDS[i.field] ?? ISSUE_FIELDS[i.field.replace(/\.\d+.*$/, "")];
      if (field && !map[field]) map[field] = i.message;
      else unmatched.push(`${i.field}: ${i.message}`);
    }
    setIssues(map);
    setIssueList(unmatched);
  };

  const validate = useMutation({
    mutationFn: () => api<{ valid: boolean; issues: { field: string; message: string }[] }>("/integrations/validate", { method: "POST", body: { config: toConfig(cfg) } }),
  });
  const runPreview = useMutation({
    mutationFn: () => api<PreviewResult>("/integrations/preview", { method: "POST", body: { config: toConfig(cfg), sample } }),
    onSuccess: (r) => {
      setPreview(r);
      if (r.issues) applyIssues(r.issues);
    },
    onError: (e) => setError(e),
  });

  /** Creates the integration on first save, then saves changes; unchanged configurations add no version. */
  const save = useMutation({
    mutationFn: () => {
      const body = { details: toDetails(details), config: toConfig(cfg), changeNote: changeNote.trim() || null };
      return key
        ? api<IntegrationDetail>(`/integrations/${key}`, { method: "PATCH", body })
        : api<IntegrationDetail>("/integrations", { method: "POST", body });
    },
    onSuccess: (r) => {
      setKey(r.key);
      setSaved(r);
      void qc.invalidateQueries({ queryKey: ["integrations"] });
    },
  });
  const test = useMutation({
    mutationFn: async () => {
      const r = await save.mutateAsync();
      return api<IntegrationTestResult>(`/integrations/${r.key}/test`, { method: "POST", body: { target: target.target, versionId: r.latestVersionId ?? undefined } });
    },
    onMutate: () => {
      setError(null);
      setTestResult(null);
    },
    onSuccess: async (r) => {
      setTestResult(r);
      if (r.sample && !sample) setSample(r.sample);
      if (key) setSaved(await api<IntegrationDetail>(`/integrations/${key}`));
      void qc.invalidateQueries({ queryKey: ["integrations"] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fieldErrors.length) applyIssues(e.fieldErrors);
      setError(e);
    },
  });
  const enable = useMutation({
    mutationFn: async () => {
      const r = await save.mutateAsync();
      return api<IntegrationDetail>(`/integrations/${r.key}/enable`, { method: "POST", body: { versionId: r.latestVersionId ?? undefined } });
    },
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["integrations"] });
      void qc.invalidateQueries({ queryKey: ["brands"] });
      toast("success", `${r.displayName} is enabled and can be selected when adding cameras`);
      navigate(`/settings/brands/${r.key}`);
    },
    onError: (e) => setError(e),
  });

  const next = async () => {
    setError(null);
    if (step === 0 && !details.displayName.trim()) return setError(new Error("Enter the brand name."));
    if (step === 0 && details.mode === "custom") return;
    if (step === 1 && !cfg.path.trim()) {
      setIssues({ path: "Endpoint path is required" });
      return;
    }
    if (step === 2) {
      const r = await validate.mutateAsync().catch((e) => {
        setError(e);
        return null;
      });
      if (!r) return;
      if (!r.valid) {
        applyIssues(r.issues);
        const firstApiIssue = r.issues.some((i) => /^(request|auth|pagination)\./.test(i.field));
        if (firstApiIssue) setStep(1);
        return setError(new Error("The configuration has problems; they are highlighted."));
      }
      setIssues({});
      setIssueList([]);
    }
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  if (editing && existing.isLoading) return <Spinner />;
  if (editing && existing.error) return <ErrorMessage error={existing.error} />;
  if (editing && existing.data?.integrationType === "builtin") {
    return <p className="text-sm text-ink-secondary">Built-in adapters are maintained in code and cannot be edited here.</p>;
  }
  if (editing && existing.data?.integrationType === "alias") {
    return <p className="text-sm text-ink-secondary">This brand works like {existing.data.basedOn?.displayName}: it has no API configuration to edit.</p>;
  }

  const latest = saved?.versions[0];
  const testedLatest = latest?.testStatus === "passed" && testResult?.ok !== false;
  const configNow = toConfig(cfg);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <Link to={key ? `/settings/brands/${key}` : "/settings/brands"} className="text-sm text-ink-secondary hover:underline">← {key ? "Back to brand" : "All camera brands"}</Link>
          <h2 className="mt-1 text-lg font-semibold">{editing ? `Edit ${existing.data?.displayName}` : "Add brand"}</h2>
        </div>
        {saved && <span className="text-xs text-ink-muted">Saved as {saved.key} · latest configuration {saved.latestVersion}</span>}
      </div>

      <ol className="grid grid-cols-5 gap-1" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label}>
            <button
              type="button"
              onClick={() => i < step && setStep(i)}
              disabled={i > step}
              aria-current={i === step ? "step" : undefined}
              className={clsx(
                "flex w-full flex-col gap-1 border-t-2 pt-2 text-left text-xs",
                i === step ? "border-accent text-ink" : i < step ? "border-accent/50 text-ink-secondary hover:text-ink" : "border-line text-ink-muted",
              )}
            >
              <span className="font-medium">{i < step ? <Check className="inline h-3.5 w-3.5" aria-hidden /> : `Step ${i + 1}`}</span>
              <span className="hidden sm:block">{label}</span>
            </button>
          </li>
        ))}
      </ol>

      <ErrorMessage error={error} />

      {step === 0 && (
        <Card title="Brand details">
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <Field label="Brand name" required hint="Shown in the brand list when adding a camera. Must be unique.">
              {(id, d) => <Input id={id} aria-describedby={d} value={details.displayName} onChange={(e) => setD("displayName", e.target.value)} maxLength={60} required />}
            </Field>
            <Field label="Manufacturer">
              {(id) => <Input id={id} value={details.manufacturer} onChange={(e) => setD("manufacturer", e.target.value)} maxLength={80} />}
            </Field>
            <Field label="Integration description" className="sm:col-span-2">
              {(id) => <Textarea id={id} value={details.description} onChange={(e) => setD("description", e.target.value)} rows={2} className="!font-sans !text-sm" maxLength={500} />}
            </Field>
            <Field label="Supported models" hint="Optional, comma separated.">
              {(id, d) => <Input id={id} aria-describedby={d} value={details.supportedModels} onChange={(e) => setD("supportedModels", e.target.value)} />}
            </Field>
            <Field label="Integration version" hint="Your label for this integration, e.g. 1.0.">
              {(id, d) => <Input id={id} aria-describedby={d} value={details.integrationVersion} onChange={(e) => setD("integrationVersion", e.target.value)} />}
            </Field>
            <div className="grid grid-cols-3 gap-3 sm:col-span-2">
              <Field label="Default protocol">
                {(id) => (
                  <Select id={id} value={details.defaultProtocol} onChange={(e) => setD("defaultProtocol", e.target.value as "http" | "https")}>
                    <option value="http">HTTP</option>
                    <option value="https">HTTPS</option>
                  </Select>
                )}
              </Field>
              <Field label="Default HTTP port">
                {(id) => <Input id={id} inputMode="numeric" value={details.defaultHttpPort} onChange={(e) => setD("defaultHttpPort", e.target.value.replace(/\D/g, ""))} />}
              </Field>
              <Field label="Default HTTPS port">
                {(id) => <Input id={id} inputMode="numeric" value={details.defaultHttpsPort} onChange={(e) => setD("defaultHttpsPort", e.target.value.replace(/\D/g, ""))} />}
              </Field>
            </div>
            <fieldset className="sm:col-span-2">
              <legend className="mb-2 text-sm font-medium">Integration type</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                <ModeOption checked={details.mode === "configurable"} onChange={() => setD("mode", "configurable")} title="Configurable API" disabled={editing}>
                  One HTTP request (GET or POST) that returns storage information as JSON or XML, with Basic, Digest, API key, bearer token or no authentication. Set up entirely here.
                </ModeOption>
                <ModeOption checked={details.mode === "custom"} onChange={() => setD("mode", "custom")} title="Custom adapter" disabled={editing}>
                  For APIs the configurable framework cannot express. A developer adds a trusted adapter to the application, with automated tests.
                </ModeOption>
              </div>
            </fieldset>
            {details.mode === "custom" && (
              <div className="rounded-md border border-warn/50 bg-warn/10 p-3 text-sm sm:col-span-2">
                <p className="font-medium">This brand needs a custom adapter, which cannot be added from the UI.</p>
                <p className="mt-1 text-ink-secondary">For security, the application never runs uploaded scripts or plugins. A custom adapter is a reviewed code change (see docs/architecture.md → Adding a camera brand). Typical reasons:</p>
                <ul className="mt-1 list-disc pl-5 text-ink-secondary">{NEEDS_CUSTOM_ADAPTER.map((x) => <li key={x}>{x}</li>)}</ul>
              </div>
            )}
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card title="API configuration">
          <div className="grid gap-4 p-4 sm:grid-cols-[8rem_minmax(0,1fr)]">
            <Field label="HTTP method">
              {(id) => (
                <Select id={id} value={cfg.method} onChange={(e) => setC("method", e.target.value as "GET" | "POST")}>
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                </Select>
              )}
            </Field>
            <Field label="Endpoint path" required error={issue("path")} hint="Only the path, e.g. /api/v1/storage. Each camera's address and port are added automatically; full URLs are refused.">
              {(id, d) => <Input id={id} aria-describedby={d} value={cfg.path} onChange={(e) => setC("path", e.target.value)} invalid={!!issue("path")} spellCheck={false} className="font-mono text-xs" placeholder="/api/v1/storage" />}
            </Field>
            <div className="sm:col-span-2 grid gap-4 md:grid-cols-2">
              <PairsEditor label="Query parameters" value={cfg.query} onChange={(v) => setC("query", v)} namePlaceholder="name" valuePlaceholder="value" hint="Fixed values only. Never put passwords or keys here." />
              <PairsEditor label="Headers" value={cfg.headers} onChange={(v) => setC("headers", v)} namePlaceholder="X-Header" valuePlaceholder="value" hint="Authorization, Cookie, Host and similar headers cannot be set." />
            </div>
            {cfg.method === "POST" && (
              <>
                <Field label="Content type" error={issue("contentType")}>
                  {(id) => <Input id={id} value={cfg.contentType} onChange={(e) => setC("contentType", e.target.value)} placeholder="application/json" />}
                </Field>
                <Field label="Request body" error={issue("body")} hint="Sent as is. No placeholders or secrets.">
                  {(id, d) => <Textarea id={id} aria-describedby={d} value={cfg.body} onChange={(e) => setC("body", e.target.value)} rows={4} />}
                </Field>
              </>
            )}
            <Field label="Timeout (seconds)" error={issue("timeoutSeconds")}>
              {(id) => <Input id={id} inputMode="numeric" value={cfg.timeoutSeconds} onChange={(e) => setC("timeoutSeconds", e.target.value.replace(/[^\d.]/g, ""))} />}
            </Field>
            <Field label="Response format">
              {(id) => (
                <Select id={id} value={cfg.format} onChange={(e) => setC("format", e.target.value as "json" | "xml")}>
                  <option value="json">JSON</option>
                  <option value="xml">XML</option>
                </Select>
              )}
            </Field>
            <Field label="Authentication" hint={`Cameras of this brand will need: ${CREDENTIAL_LABELS[credentials]}. Values are entered per camera and stored encrypted, never in this configuration.`} className="sm:col-span-2">
              {(id, d) => (
                <Select id={id} aria-describedby={d} value={cfg.authType} onChange={(e) => setC("authType", e.target.value as ConfigForm["authType"])}>
                  {Object.entries(AUTH_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              )}
            </Field>
            {cfg.authType === "api_key" && (
              <div className="grid gap-3 sm:col-span-2 sm:grid-cols-2">
                <Field label="Send the API key in" error={issue("apiKeyIn")}>
                  {(id) => (
                    <Select id={id} value={cfg.apiKeyIn} onChange={(e) => setC("apiKeyIn", e.target.value as "header" | "query")}>
                      <option value="header">A request header</option>
                      <option value="query">A query parameter</option>
                    </Select>
                  )}
                </Field>
                <Field label={cfg.apiKeyIn === "header" ? "Header name" : "Parameter name"} error={issue("apiKeyName")}>
                  {(id) => <Input id={id} value={cfg.apiKeyName} onChange={(e) => setC("apiKeyName", e.target.value)} spellCheck={false} />}
                </Field>
              </div>
            )}
            {cfg.authType === "none" && <p className="text-sm text-warn sm:col-span-2">Only use this for cameras whose storage API is genuinely unauthenticated on an isolated network.</p>}
            {["basic", "api_key", "bearer"].includes(cfg.authType) && <p className="text-xs text-ink-muted sm:col-span-2">These credentials are only sent over HTTPS, so cameras must use HTTPS. Digest authentication also works over HTTP.</p>}
            <Field label="Pagination" className="sm:col-span-2" hint="Only if the API returns storage devices in pages.">
              {(id, d) => (
                <Select id={id} aria-describedby={d} value={cfg.pagination} onChange={(e) => setC("pagination", e.target.value as "none" | "page")}>
                  <option value="none">No pagination</option>
                  <option value="page">Page number parameter</option>
                </Select>
              )}
            </Field>
            {cfg.pagination === "page" && (
              <div className="grid gap-3 sm:col-span-2 sm:grid-cols-5">
                <Field label="Page parameter" error={issue("pageParam")}>{(id) => <Input id={id} value={cfg.pageParam} onChange={(e) => setC("pageParam", e.target.value)} />}</Field>
                <Field label="First page">{(id) => <Select id={id} value={cfg.firstPage} onChange={(e) => setC("firstPage", e.target.value as "0" | "1")}><option value="1">1</option><option value="0">0</option></Select>}</Field>
                <Field label="Page size parameter">{(id) => <Input id={id} value={cfg.pageSizeParam} onChange={(e) => setC("pageSizeParam", e.target.value)} placeholder="optional" />}</Field>
                <Field label="Page size">{(id) => <Input id={id} inputMode="numeric" value={cfg.pageSize} onChange={(e) => setC("pageSize", e.target.value.replace(/\D/g, ""))} />}</Field>
                <Field label="Max pages">{(id) => <Input id={id} inputMode="numeric" value={cfg.maxPages} onChange={(e) => setC("maxPages", e.target.value.replace(/\D/g, ""))} />}</Field>
              </div>
            )}
          </div>
        </Card>
      )}

      {step === 2 && (
        <div className="grid gap-5 xl:grid-cols-2">
          <Card title="Storage response mapping">
            <div className="space-y-4 p-4">
              <p className="text-xs text-ink-secondary">
                Paths are dotted names: <code>data.disks[*]</code>, <code>hddList.hdd</code>, <code>@id</code> for an XML attribute. A leading <code>$.</code> is allowed. Field paths are relative to each storage device. Nothing is evaluated as code.
              </p>
              <Field label="Storage device list" error={issue("devicesPath")} hint="Path to the list (or single object) of storage devices. Empty means the whole response is one device.">
                {(id, d) => <Input id={id} aria-describedby={d} value={cfg.devicesPath} onChange={(e) => setC("devicesPath", e.target.value)} invalid={!!issue("devicesPath")} spellCheck={false} className="font-mono text-xs" />}
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Storage device ID" error={issue("idPath")} hint="Optional">{(id, d) => <Input id={id} aria-describedby={d} value={cfg.idPath} onChange={(e) => setC("idPath", e.target.value)} spellCheck={false} className="font-mono text-xs" />}</Field>
                <Field label="Storage device name" error={issue("namePath")} hint="Optional">{(id, d) => <Input id={id} aria-describedby={d} value={cfg.namePath} onChange={(e) => setC("namePath", e.target.value)} spellCheck={false} className="font-mono text-xs" />}</Field>
              </div>
              <PathWithUnit label="Total capacity" required path={cfg.totalPath} unit={cfg.totalUnit} onPath={(v) => setC("totalPath", v)} onUnit={(v) => setC("totalUnit", v)} error={issue("totalPath")} />
              <PathWithUnit label="Free capacity" path={cfg.freePath} unit={cfg.freeUnit} onPath={(v) => setC("freePath", v)} onUnit={(v) => setC("freeUnit", v)} error={issue("freePath")} hint="Map free or used capacity (or both)." />
              <PathWithUnit label="Used capacity" path={cfg.usedPath} unit={cfg.usedUnit} onPath={(v) => setC("usedPath", v)} onUnit={(v) => setC("usedUnit", v)} error={issue("usedPath")} hint="Optional when free capacity is mapped. Free is derived from total − used only when both are reported." />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Disk health status" error={issue("healthPath")} hint="Optional">{(id, d) => <Input id={id} aria-describedby={d} value={cfg.healthPath} onChange={(e) => setC("healthPath", e.target.value)} spellCheck={false} className="font-mono text-xs" />}</Field>
                <Field label="Read/write status" error={issue("readWritePath")} hint="Optional">{(id, d) => <Input id={id} aria-describedby={d} value={cfg.readWritePath} onChange={(e) => setC("readWritePath", e.target.value)} spellCheck={false} className="font-mono text-xs" />}</Field>
              </div>
              <fieldset className="grid gap-3 sm:grid-cols-2">
                <legend className="mb-1 text-sm font-medium">Status values (comma separated, case-insensitive)</legend>
                <Field label="Healthy">{(id) => <Input id={id} value={cfg.healthy} onChange={(e) => setC("healthy", e.target.value)} />}</Field>
                <Field label="Degraded">{(id) => <Input id={id} value={cfg.degraded} onChange={(e) => setC("degraded", e.target.value)} />}</Field>
                <Field label="Unhealthy">{(id) => <Input id={id} value={cfg.unhealthy} onChange={(e) => setC("unhealthy", e.target.value)} />}</Field>
                <Field label="No disk installed (skipped)">{(id) => <Input id={id} value={cfg.absent} onChange={(e) => setC("absent", e.target.value)} />}</Field>
                {cfg.readWritePath && (
                  <>
                    <Field label="Read/write values">{(id) => <Input id={id} value={cfg.readWrite} onChange={(e) => setC("readWrite", e.target.value)} />}</Field>
                    <Field label="Read-only values">{(id) => <Input id={id} value={cfg.readOnly} onChange={(e) => setC("readOnly", e.target.value)} />}</Field>
                  </>
                )}
              </fieldset>
              <Checkbox label="Also read device information (model, serial, firmware)" checked={cfg.deviceInfo} onChange={(e) => setC("deviceInfo", e.target.checked)} />
              {cfg.deviceInfo && (
                <div className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-2">
                  <Field label="Device info path" error={issue("infoPath")} className="sm:col-span-2">{(id) => <Input id={id} value={cfg.infoPath} onChange={(e) => setC("infoPath", e.target.value)} className="font-mono text-xs" placeholder="/api/v1/system" />}</Field>
                  <Field label="Model">{(id) => <Input id={id} value={cfg.infoModel} onChange={(e) => setC("infoModel", e.target.value)} className="font-mono text-xs" />}</Field>
                  <Field label="Serial number">{(id) => <Input id={id} value={cfg.infoSerial} onChange={(e) => setC("infoSerial", e.target.value)} className="font-mono text-xs" />}</Field>
                  <Field label="Firmware version">{(id) => <Input id={id} value={cfg.infoFirmware} onChange={(e) => setC("infoFirmware", e.target.value)} className="font-mono text-xs" />}</Field>
                  <Field label="Format">{(id) => <Select id={id} value={cfg.infoFormat} onChange={(e) => setC("infoFormat", e.target.value as "json" | "xml")}><option value="json">JSON</option><option value="xml">XML</option></Select>}</Field>
                </div>
              )}
              {issueList.length > 0 && <ul className="list-disc rounded-md border border-bad/40 bg-bad/10 p-3 pl-8 text-sm">{issueList.map((i) => <li key={i}>{i}</li>)}</ul>}
            </div>
          </Card>
          <Card title="Sample response and preview">
            <div className="space-y-3 p-4">
              <Field label={`Sample ${cfg.format.toUpperCase()} response`} hint="Paste a response from the vendor's documentation or a camera, or fetch one from a test camera below. Nothing is sent to a camera when previewing.">
                {(id, d) => <Textarea id={id} aria-describedby={d} value={sample} onChange={(e) => setSample(e.target.value)} rows={12} spellCheck={false} className="w-full" />}
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" icon={<Wand2 className="h-4 w-4" />} onClick={() => runPreview.mutate()} loading={runPreview.isPending} disabled={!sample.trim()}>Preview mapping</Button>
              </div>
              <details className="rounded-md border border-line p-3">
                <summary className="cursor-pointer text-sm font-medium">Fetch a sample from a test camera</summary>
                <div className="mt-3 space-y-3">
                  <p className="text-xs text-ink-secondary">Saves this configuration as a draft, then runs the request on the server. Sensitive fields are redacted from the returned sample.</p>
                  <TestTargetFields state={target} credentials={credentials} />
                  <Button icon={<Download className="h-4 w-4" />} onClick={() => test.mutate(undefined, { onSuccess: (r) => r.sample && setSample(r.sample) })} loading={test.isPending} disabled={!target.target}>Save draft and fetch sample</Button>
                </div>
              </details>
              {preview?.stage === "format" && <p className="rounded-md border border-bad/40 bg-bad/10 p-3 text-sm">{preview.message}</p>}
              {preview?.stage === "config" && <p className="rounded-md border border-bad/40 bg-bad/10 p-3 text-sm">Complete the highlighted mapping fields first.</p>}
              {preview?.mapping && (
                <>
                  <p className={clsx("text-sm font-medium", preview.ok ? "text-good" : "text-bad")}>{preview.ok ? "Mapping is valid for this sample." : "The mapping does not produce valid storage data yet."}</p>
                  <MappingView mapping={preview.mapping} />
                </>
              )}
            </div>
          </Card>
        </div>
      )}

      {step === 3 && (
        <Card title="Test integration">
          <div className="space-y-4 p-4">
            <p className="text-sm text-ink-secondary">
              The test runs on the server: it validates the configuration, checks that the camera address is allowed, connects, authenticates, sends the request, parses the reply and checks the required storage fields. The integration cannot be enabled until a test succeeds.
            </p>
            <TestTargetFields state={target} credentials={credentials} />
            {key && (
              <Field label="Change note" hint="Optional, recorded with this configuration version.">
                {(id, d) => <Input id={id} aria-describedby={d} value={changeNote} onChange={(e) => setChangeNote(e.target.value)} maxLength={200} />}
              </Field>
            )}
            <Button variant="primary" icon={<FlaskConical className="h-4 w-4" />} onClick={() => test.mutate()} loading={test.isPending} disabled={!target.target}>
              Save and test API
            </Button>
            {testResult && <TestResultView result={testResult} />}
          </div>
        </Card>
      )}

      {step === 4 && (
        <Card title="Review and publish">
          <div className="space-y-4 p-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <Summary label="Brand" value={`${details.displayName}${details.manufacturer ? ` (${details.manufacturer})` : ""}`} />
              <Summary label="Integration" value={`Configurable API · version ${details.integrationVersion}`} />
              <Summary label="Default connection" value={`${details.defaultProtocol.toUpperCase()} · ports ${details.defaultHttpPort} / ${details.defaultHttpsPort}`} />
              <Summary label="Request" value={`${configNow.request.method} ${configNow.request.path}${configNow.request.query.length ? ` (+${configNow.request.query.length} parameters)` : ""}`} mono />
              <Summary label="Authentication" value={AUTH_LABELS[configNow.auth.type] ?? String(configNow.auth.type)} />
              <Summary label="Camera credentials" value={CREDENTIAL_LABELS[credentials] ?? credentials} />
              <Summary label="Response" value={`${configNow.response.format.toUpperCase()} · devices at ${configNow.response.devicesPath || "(root)"}`} mono />
              <Summary label="Capacity fields" value={[`total ${configNow.response.fields.total.path} (${configNow.response.fields.total.unit})`, configNow.response.fields.free && `free ${configNow.response.fields.free.path}`, configNow.response.fields.used && `used ${configNow.response.fields.used.path}`].filter(Boolean).join(", ")} mono />
              <Summary label="Last test" value={testResult ? `${testResult.outcomeLabel}` : latest?.testStatus === "passed" ? "Passed" : "Not tested"} />
            </dl>
            <details>
              <summary className="cursor-pointer text-sm font-medium">Configuration JSON (contains no secrets)</summary>
              <pre className="mt-2 max-h-80 overflow-auto rounded-md border border-line bg-raised/50 p-3 text-xs">{JSON.stringify(configNow, null, 2)}</pre>
            </details>
            <div className="rounded-md border border-line bg-raised/50 p-3 text-sm text-ink-secondary">
              <p><strong className="text-ink">Draft</strong> saves it without testing. <strong className="text-ink">Tested</strong> is set automatically after a successful test. <strong className="text-ink">Enabled</strong> makes it available for new cameras and monitoring; only a tested configuration can be enabled.</p>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                icon={<Save className="h-4 w-4" />}
                loading={save.isPending && !enable.isPending}
                onClick={() =>
                  save.mutate(undefined, {
                    onSuccess: (r) => {
                      toast("success", `${r.displayName} saved as ${r.status === "enabled" ? "a new draft version" : r.status}`);
                      navigate(`/settings/brands/${r.key}`);
                    },
                    onError: (e) => setError(e),
                  })
                }
              >
                Save as draft
              </Button>
              <Button variant="primary" icon={<Power className="h-4 w-4" />} onClick={() => enable.mutate()} loading={enable.isPending} disabled={!testedLatest} title={testedLatest ? undefined : "Run a successful test first (step 4)"}>
                Enable for monitoring
              </Button>
            </div>
          </div>
        </Card>
      )}

      {!(step === 0 && details.mode === "custom") && (
        <div className="flex justify-between">
          <Button icon={<ChevronLeft className="h-4 w-4" />} onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>Back</Button>
          {step < STEPS.length - 1 && (
            <Button variant="primary" onClick={() => void next()} loading={validate.isPending}>
              Next <ChevronRight className="h-4 w-4" aria-hidden />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function ModeOption({ checked, onChange, title, children, disabled }: { checked: boolean; onChange: () => void; title: string; children: ReactNode; disabled?: boolean }) {
  return (
    <label className={clsx("flex cursor-pointer gap-2 rounded-md border p-3 text-sm", checked ? "border-accent bg-accent-soft/30" : "border-line", disabled && "cursor-default opacity-70")}>
      <input type="radio" name="integration-mode" checked={checked} onChange={onChange} disabled={disabled} className="mt-0.5 accent-[rgb(var(--accent))]" />
      <span>
        <span className="block font-medium text-ink">{title}</span>
        <span className="text-ink-secondary">{children}</span>
      </span>
    </label>
  );
}

function Summary({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs" : ""}>{value}</dd>
    </div>
  );
}
