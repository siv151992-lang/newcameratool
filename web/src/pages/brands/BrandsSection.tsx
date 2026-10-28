import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Link, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api } from "../../api/client";
import type { IntegrationSummary } from "../../api/types";
import { IntegrationStatusBadge } from "../../components/status";
import { Button, Card, ErrorMessage, Spinner } from "../../components/ui";
import { useAuth } from "../../hooks/auth";
import { absoluteTime, capabilityLabel, relativeTime } from "../../lib/format";
import { BrandDetailPage } from "./BrandDetailPage";
import { BrandWizard } from "./BrandWizard";
import { QuickAddBrand } from "./QuickAddBrand";
import { AUTH_LABELS } from "./shared";

/** Settings → Camera brands: list, add wizard, details and edit, under /settings/brands. */
export function BrandsSection() {
  const { can } = useAuth();
  return (
    <Routes>
      <Route index element={<BrandList />} />
      {can("system:manage") && <Route path="new" element={<QuickAddBrand />} />}
      {can("system:manage") && <Route path="new/manual" element={<BrandWizard />} />}
      <Route path=":key" element={<BrandDetailPage />} />
      {can("system:manage") && <Route path=":key/edit" element={<BrandWizard />} />}
      <Route path="*" element={<Navigate to="/settings/brands" replace />} />
    </Routes>
  );
}

export const TYPE_LABELS = { builtin: "Custom adapter", configurable: "Configurable API", alias: "Works like a built-in adapter" } as const;

function LastTest({ b }: { b: IntegrationSummary }) {
  if (!b.lastTestAt) return <span className="text-ink-muted">{b.integrationType === "builtin" && b.lastSuccessAt ? `Storage read ${relativeTime(b.lastSuccessAt)}` : "Never"}</span>;
  return (
    <span title={absoluteTime(b.lastTestAt)} className={b.lastTestOk ? "" : "text-bad"}>
      {b.lastTestOk ? "Passed" : "Failed"} {relativeTime(b.lastTestAt)}
    </span>
  );
}

function BrandList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const brands = useQuery({ queryKey: ["integrations"], queryFn: () => api<IntegrationSummary[]>("/integrations") });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-ink-secondary">
          <strong className="font-medium text-ink">Custom adapters</strong> are built into the application and maintained in code.{" "}
          <strong className="font-medium text-ink">Configurable API</strong> integrations are defined here for brands whose storage API is a single HTTP request returning JSON or XML.
        </p>
        {can("system:manage") && (
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => navigate("new")}>
            Add brand
          </Button>
        )}
      </div>
      {brands.isLoading && <Spinner />}
      <ErrorMessage error={brands.error} />
      {brands.data && (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-b border-line text-xs text-ink-muted">
                <tr>
                  <th className="px-4 py-2 font-medium">Brand and integration</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 text-right font-medium">Cameras</th>
                  <th className="whitespace-nowrap px-3 py-2 font-medium">Last API test</th>
                  <th className="px-3 py-2 font-medium">Authentication</th>
                  <th className="px-3 py-2 font-medium">Capabilities</th>
                  <th className="px-3 py-2 font-medium">Updated</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {brands.data.map((b) => (
                  <tr key={b.key} className="align-top hover:bg-line/30">
                    <td className="px-4 py-2.5">
                      <Link to={b.key} className="font-medium text-ink hover:underline">{b.displayName}</Link>
                      <div className="text-xs text-ink-muted">
                        {b.manufacturer && `${b.manufacturer} · `}
                        {TYPE_LABELS[b.integrationType]} v{b.integrationVersion}
                        {b.integrationType === "configurable" && b.activeVersion !== null && ` · config ${b.activeVersion}`}
                        {b.integrationType === "configurable" && b.latestVersion !== null && b.latestVersion !== b.activeVersion && ` · draft ${b.latestVersion}`}
                      </div>
                    </td>
                    <td className="px-3 py-2.5"><IntegrationStatusBadge status={b.status} /></td>
                    <td className="tabular px-3 py-2.5 text-right">{b.cameraCount}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs"><LastTest b={b} /></td>
                    <td className="px-3 py-2.5 text-xs">{b.authMethods.map((a) => AUTH_LABELS[a] ?? a).join(", ")}</td>
                    <td className="px-3 py-2.5 text-xs text-ink-secondary">{b.capabilities.map(capabilityLabel).join(" · ")}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-ink-secondary">
                      <div title={absoluteTime(b.updatedAt)}>{relativeTime(b.updatedAt)}</div>
                      <div title={absoluteTime(b.createdAt)} className="text-ink-muted">created {relativeTime(b.createdAt)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
