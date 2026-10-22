import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, FlaskConical, Pencil, Power, PowerOff, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api } from "../../api/client";
import type { Brand, IntegrationCamera, IntegrationDetail, IntegrationTestRecord, IntegrationTestResult, Page } from "../../api/types";
import { ConnectionBadge, HealthBadge, IntegrationStatusBadge } from "../../components/status";
import { useToast } from "../../components/toast";
import { Button, Card, ConfirmDialog, Dialog, EmptyState, ErrorMessage, Field, Pagination, Select, Spinner } from "../../components/ui";
import { useAuth } from "../../hooks/auth";
import { absoluteTime, capabilityLabel, relativeTime } from "../../lib/format";
import { TYPE_LABELS } from "./BrandsSection";
import { AUTH_LABELS, CREDENTIAL_LABELS, TestResultView, TestTargetFields, useTestTarget } from "./shared";

export function BrandDetailPage() {
  const { key = "" } = useParams();
  const { can } = useAuth();
  const admin = can("system:manage");
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const detail = useQuery({ queryKey: ["integrations", key], queryFn: () => api<IntegrationDetail>(`/integrations/${key}`) });
  const [dialog, setDialog] = useState<null | "disable" | "delete" | "reassign">(null);
  const [testResult, setTestResult] = useState<IntegrationTestResult | null>(null);
  const [camPage, setCamPage] = useState(1);
  const [testPage, setTestPage] = useState(1);
  const cameras = useQuery({ queryKey: ["integrations", key, "cameras", camPage], queryFn: () => api<Page<IntegrationCamera>>(`/integrations/${key}/cameras?page=${camPage}&pageSize=10`) });
  // Test history names test cameras from every organization: the system administrator's view only.
  const tests = useQuery({ queryKey: ["integrations", key, "tests", testPage], queryFn: () => api<Page<IntegrationTestRecord>>(`/integrations/${key}/tests?page=${testPage}&pageSize=10`), enabled: admin });
  const d = detail.data;
  const target = useTestTarget(key, { protocol: d?.defaultProtocol ?? "http", ports: d?.defaultPorts ?? { http: 80, https: 443 } });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["integrations"] });
    void qc.invalidateQueries({ queryKey: ["brands"] });
  };
  const onError = (e: unknown) => toast("error", (e as Error).message);
  const runTest = useMutation({
    mutationFn: () => api<IntegrationTestResult>(`/integrations/${key}/test`, { method: "POST", body: { target: target.target } }),
    onMutate: () => setTestResult(null),
    onSuccess: (r) => {
      setTestResult(r);
      refresh();
    },
    onError,
  });
  const enable = useMutation({
    mutationFn: (versionId?: string) => api<IntegrationDetail>(`/integrations/${key}/enable`, { method: "POST", body: versionId ? { versionId } : {} }),
    onSuccess: (r) => {
      refresh();
      toast("success", `${r.displayName} is enabled${r.activeVersion ? ` with configuration version ${r.activeVersion}` : ""}`);
    },
    onError,
  });
  const disable = useMutation({
    mutationFn: () => api<{ impact: { cameras: number } }>(`/integrations/${key}/disable`, { method: "POST", body: {} }),
    onSuccess: (r) => {
      setDialog(null);
      refresh();
      toast("success", `Integration disabled. ${r.impact.cameras} camera(s) are no longer checked; their history is kept.`);
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => api(`/integrations/${key}`, { method: "DELETE" }),
    onSuccess: () => {
      refresh();
      toast("success", "Integration deleted");
      navigate("/settings/brands");
    },
    onError: (e) => {
      setDialog(null);
      onError(e);
    },
  });

  if (detail.isLoading) return <Spinner />;
  if (detail.error || !d) return <ErrorMessage error={detail.error} />;
  const configurable = d.integrationType === "configurable";
  const latest = d.versions[0];
  const active = d.versions.find((v) => v.isActive);
  // Enable the latest configuration if it passed a test, else the tested one that was in use before.
  const enableVersion = !configurable ? undefined : latest?.testStatus === "passed" ? latest : active?.testStatus === "passed" ? active : undefined;
  const canEnable = !configurable || !!enableVersion;
  const pendingDraft = configurable && d.status === "enabled" && latest && !latest.isActive;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/settings/brands" className="text-sm text-ink-secondary hover:underline">← All camera brands</Link>
          <h2 className="mt-1 flex flex-wrap items-center gap-2 text-lg font-semibold">
            {d.displayName} <IntegrationStatusBadge status={d.status} />
          </h2>
          <p className="text-sm text-ink-secondary">
            {TYPE_LABELS[d.integrationType]} · version {d.integrationVersion}
            {configurable && d.activeVersion !== null && ` · monitoring with configuration ${d.activeVersion}`}
          </p>
        </div>
        {admin && (
          <div className="flex flex-wrap gap-2">
            {configurable && <Button icon={<Pencil className="h-4 w-4" />} onClick={() => navigate("edit")}>Edit configuration</Button>}
            {d.status !== "enabled" ? (
              <Button
                variant="primary"
                icon={<Power className="h-4 w-4" />}
                onClick={() => enable.mutate(enableVersion?.id)}
                loading={enable.isPending}
                disabled={!canEnable}
                title={canEnable ? undefined : "Run Test API successfully on the latest configuration first"}
              >
                {configurable && enableVersion && enableVersion !== latest ? `Enable with configuration ${enableVersion.version}` : "Enable"}
              </Button>
            ) : (
              <Button icon={<PowerOff className="h-4 w-4" />} onClick={() => setDialog("disable")}>Disable</Button>
            )}
            {configurable && <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => setDialog("delete")}>Delete</Button>}
          </div>
        )}
      </div>

      {pendingDraft && (
        <p className="rounded-md border border-warn/50 bg-warn/10 px-3 py-2 text-sm">
          Configuration {latest.version} is {latest.testStatus === "passed" ? "tested but not applied" : "a draft"}. Monitoring keeps using configuration {d.activeVersion} until version {latest.version} passes a test and is activated below.
        </p>
      )}
      {!canEnable && d.status !== "enabled" && (
        <p className="rounded-md border border-line bg-raised/50 px-3 py-2 text-sm text-ink-secondary">
          This integration cannot be enabled until its latest configuration passes <strong>Test API</strong> against a real camera.
        </p>
      )}

      <Card title="Details">
        <dl className="grid gap-4 p-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Item label="Manufacturer" value={d.manufacturer} />
          <Item label="Cameras using it" value={String(d.cameraCount)} />
          <Item label="Camera credentials" value={CREDENTIAL_LABELS[d.credentials]} />
          <Item label="Authentication" value={d.authMethods.map((a) => AUTH_LABELS[a] ?? a).join(", ")} />
          <Item label="Default port / protocol" value={`${d.defaultProtocol.toUpperCase()} · ${d.defaultPorts.http} / ${d.defaultPorts.https}`} />
          <Item label="Capabilities" value={d.capabilities.map(capabilityLabel).join(", ")} />
          <Item label="Last API test" value={d.lastTestAt ? `${d.lastTestOk ? "Passed" : "Failed"} ${relativeTime(d.lastTestAt)}` : "Never"} />
          <Item label="Last successful storage retrieval" value={d.lastSuccessAt ? `${relativeTime(d.lastSuccessAt)} (${absoluteTime(d.lastSuccessAt)})` : "Never"} />
          <Item label="Created / updated" value={`${absoluteTime(d.createdAt)} · ${absoluteTime(d.updatedAt)}`} />
          {d.storageEndpoint && <Item label="Storage API" value={d.storageEndpoint} mono />}
          {d.activeConfig && <Item label="Storage request" value={`${d.activeConfig.request.method} ${d.activeConfig.request.path} → ${d.activeConfig.response.format.toUpperCase()}`} mono />}
          {d.supportedModels.length > 0 && <Item label="Supported models" value={d.supportedModels.join(", ")} />}
          <div className="sm:col-span-2 lg:col-span-3"><Item label="Description" value={d.description ?? d.notes} /></div>
          {d.compatibilityNotes && <div className="sm:col-span-2 lg:col-span-3"><Item label="Compatibility notes" value={d.compatibilityNotes} /></div>}
        </dl>
      </Card>

      {admin && (
        <Card title="Test API" actions={<span className="text-xs text-ink-muted">{configurable && latest ? `Tests configuration ${latest.version}` : "Runs the built-in adapter"}</span>}>
          <div className="space-y-4 p-4">
            <TestTargetFields state={target} credentials={d.credentials} />
            <Button icon={<FlaskConical className="h-4 w-4" />} onClick={() => runTest.mutate()} loading={runTest.isPending} disabled={!target.target}>
              Test API
            </Button>
            {testResult && <TestResultView result={testResult} />}
          </div>
        </Card>
      )}

      {configurable && (
        <Card title="Configuration versions">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-ink-muted">
              <tr><th className="px-4 py-2 font-medium">Version</th><th className="px-3 py-2 font-medium">Test</th><th className="px-3 py-2 font-medium">Created</th><th className="px-3 py-2 font-medium">Note</th><th className="px-3 py-2" /></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d.versions.map((v) => (
                <tr key={v.id}>
                  <td className="px-4 py-2 font-medium">{v.version}{v.isActive && <span className="ml-2 rounded bg-accent-soft/70 px-1.5 py-0.5 text-xs">In use</span>}</td>
                  <td className="px-3 py-2">{v.testStatus === "passed" ? "Passed" : v.testStatus === "failed" ? "Failed" : "Not tested"}{v.testedAt && <span className="text-xs text-ink-muted"> · {relativeTime(v.testedAt)}</span>}</td>
                  <td className="px-3 py-2 text-xs text-ink-secondary">{absoluteTime(v.createdAt)}{v.createdBy && ` by ${v.createdBy}`}</td>
                  <td className="px-3 py-2 text-xs text-ink-secondary">{v.changeNote ?? "—"}</td>
                  <td className="px-3 py-2 text-right">
                    {admin && (!v.isActive || d.status !== "enabled") && v.testStatus === "passed" && (
                      <Button size="sm" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => enable.mutate(v.id)} loading={enable.isPending && enable.variables === v.id}>
                        {v.isActive ? "Enable this" : d.activeVersion !== null && v.version < d.activeVersion ? "Roll back to this" : "Activate"}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <Card
        title="Cameras using this integration"
        actions={admin && d.cameraCount > 0 ? <Button size="sm" icon={<ArrowRightLeft className="h-3.5 w-3.5" />} onClick={() => setDialog("reassign")}>Reassign cameras</Button> : undefined}
      >
        {cameras.data && cameras.data.total === 0 ? (
          <EmptyState title="No cameras use this integration" />
        ) : (
          <>
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-xs text-ink-muted">
                <tr><th className="px-4 py-2 font-medium">Camera</th><th className="px-3 py-2 font-medium">Address</th><th className="px-3 py-2 font-medium">Connection</th><th className="px-3 py-2 font-medium">Storage</th><th className="px-3 py-2 font-medium">Last success</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {cameras.data?.items.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-2"><Link to={`/cameras/${c.id}`} className="font-medium hover:underline">{c.name}</Link></td>
                    <td className="tabular px-3 py-2">{c.host}:{c.port}</td>
                    <td className="px-3 py-2"><ConnectionBadge status={c.connectionStatus} monitoringEnabled={c.monitoringEnabled} /></td>
                    <td className="px-3 py-2"><HealthBadge health={c.storageHealth} /></td>
                    <td className="px-3 py-2 text-xs text-ink-secondary">{relativeTime(c.lastSuccessAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {cameras.data && cameras.data.total > 10 && <Pagination page={camPage} pageSize={10} total={cameras.data.total} onPage={setCamPage} />}
          </>
        )}
      </Card>

      {admin && <Card title="Test history">
        {tests.data && tests.data.total === 0 ? (
          <EmptyState title="No API tests yet" />
        ) : (
          <>
            <table className="w-full text-left text-sm">
              <thead className="border-b border-line text-xs text-ink-muted">
                <tr><th className="px-4 py-2 font-medium">When</th><th className="px-3 py-2 font-medium">Result</th><th className="px-3 py-2 font-medium">Config</th><th className="px-3 py-2 font-medium">Camera</th><th className="px-3 py-2 font-medium">Message</th></tr>
              </thead>
              <tbody className="divide-y divide-line">
                {tests.data?.items.map((t) => (
                  <tr key={t.id} className="align-top">
                    <td className="px-4 py-2 text-xs" title={absoluteTime(t.createdAt)}>{relativeTime(t.createdAt)}{t.createdBy && <div className="text-ink-muted">{t.createdBy}</div>}</td>
                    <td className={t.ok ? "px-3 py-2 text-good" : "px-3 py-2 text-bad"}>{t.ok ? "Passed" : t.outcome.replace(/_/g, " ").toLowerCase()}</td>
                    <td className="px-3 py-2">{t.version ?? "—"}</td>
                    <td className="tabular px-3 py-2 text-xs">{t.targetHost}:{t.targetPort}</td>
                    <td className="px-3 py-2 text-xs text-ink-secondary">{t.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {tests.data && tests.data.total > 10 && <Pagination page={testPage} pageSize={10} total={tests.data.total} onPage={setTestPage} />}
          </>
        )}
      </Card>}

      <ConfirmDialog
        open={dialog === "disable"}
        title={`Disable ${d.displayName}?`}
        confirmLabel="Disable integration"
        danger
        loading={disable.isPending}
        onConfirm={() => disable.mutate()}
        onCancel={() => setDialog(null)}
      >
        <p>
          {d.cameraCount === 0
            ? "No cameras use this integration."
            : `${d.cameraCount} camera(s) will stop being checked and cannot be tested until it is enabled again. Cameras, storage history and alerts are kept.`}
        </p>
        <p className="mt-2 text-ink-secondary">The brand will no longer be offered when adding a camera.</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === "delete"}
        title={`Delete ${d.displayName}?`}
        confirmLabel="Delete integration"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setDialog(null)}
      >
        {d.cameraCount > 0 ? (
          <p>{d.cameraCount} camera(s) still use this integration, so it cannot be deleted. Use <strong>Reassign cameras</strong> to move them to another integration first.</p>
        ) : (
          <p>The integration, its configuration versions and test history are removed. This cannot be undone.</p>
        )}
      </ConfirmDialog>
      {dialog === "reassign" && <ReassignDialog brandKey={key} count={d.cameraCount} onClose={() => setDialog(null)} onDone={refresh} />}
    </div>
  );
}

function Item({ label, value, mono }: { label: string; value: string | null | undefined; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={mono ? "break-all font-mono text-xs text-ink" : "text-ink"}>{value || "—"}</dd>
    </div>
  );
}

function ReassignDialog({ brandKey, count, onClose, onDone }: { brandKey: string; count: number; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const brands = useQuery({ queryKey: ["brands"], queryFn: () => api<Brand[]>("/brands") });
  const [toKey, setToKey] = useState("");
  const options = (brands.data ?? []).filter((b) => b.key !== brandKey && b.supportStatus !== "planned");
  const move = useMutation({
    mutationFn: () => api<{ moved: number }>(`/integrations/${brandKey}/reassign`, { method: "POST", body: { toKey } }),
    onSuccess: (r) => {
      toast("success", `${r.moved} camera(s) moved; they are checked with the new integration next.`);
      onDone();
      onClose();
    },
    onError: (e) => toast("error", (e as Error).message),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title="Reassign cameras"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => move.mutate()} loading={move.isPending} disabled={!toKey}>Move {count} camera(s)</Button>
        </>
      }
    >
      <p className="mb-3">Move every camera of this integration to another enabled integration. Their history and alerts stay with the cameras. Credentials are kept, so check the target uses the same kind of login.</p>
      <Field label="Move to">
        {(id) => (
          <Select id={id} value={toKey} onChange={(e) => setToKey(e.target.value)}>
            <option value="">Choose an integration…</option>
            {options.map((b) => <option key={b.key} value={b.key}>{b.displayName}</option>)}
          </Select>
        )}
      </Field>
    </Dialog>
  );
}
