import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, CircleHelp } from "lucide-react";
import { api } from "../api/client";
import type { Brand } from "../api/types";
import { Card, ErrorMessage, PageHeader, Spinner } from "../components/ui";

const STATUS = {
  supported: { icon: <CheckCircle2 className="h-4 w-4 text-good" aria-hidden />, label: "Supported" },
  unverified: { icon: <CircleHelp className="h-4 w-4 text-warn" aria-hidden />, label: "Unverified" },
  planned: { icon: <CircleDashed className="h-4 w-4 text-unknown" aria-hidden />, label: "Planned — not available yet" },
};

export function BrandsPage() {
  const brands = useQuery({ queryKey: ["brands"], queryFn: () => api<Brand[]>("/brands") });
  return (
    <>
      <PageHeader
        title="Brand integrations"
        description="Each brand uses its own adapter with a verified storage API. Brands marked planned cannot be selected until their adapter is implemented and tested."
      />
      {brands.isLoading && <Spinner />}
      <ErrorMessage error={brands.error} />
      <div className="grid gap-4 md:grid-cols-2">
        {brands.data?.map((b) => (
          <Card key={b.key} title={b.displayName} actions={<span className="inline-flex items-center gap-1.5 text-xs font-medium">{STATUS[b.supportStatus].icon}{STATUS[b.supportStatus].label}</span>}>
            <dl className="grid grid-cols-2 gap-3 p-4 text-sm">
              <div><dt className="text-xs text-ink-muted">Registered cameras</dt><dd>{b.cameraCount}</dd></div>
              <div><dt className="text-xs text-ink-muted">Default ports</dt><dd>HTTP {b.defaultPorts.http} · HTTPS {b.defaultPorts.https}</dd></div>
              <div><dt className="text-xs text-ink-muted">Authentication</dt><dd>{b.authMethods.join(", ") || "—"}</dd></div>
              <div><dt className="text-xs text-ink-muted">Capabilities</dt><dd>{b.capabilities.join(", ") || "—"}</dd></div>
              {b.storageEndpoint && <div className="col-span-2"><dt className="text-xs text-ink-muted">Storage API</dt><dd className="break-all font-mono text-xs">{b.storageEndpoint}</dd></div>}
              <div className="col-span-2"><dt className="text-xs text-ink-muted">Notes</dt><dd className="text-ink-secondary">{b.notes}</dd></div>
            </dl>
          </Card>
        ))}
      </div>
    </>
  );
}
