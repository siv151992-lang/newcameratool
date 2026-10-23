import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { Button, Card, Spinner } from "../components/ui";
import { useToast } from "../components/toast";
import { relativeTime } from "../lib/format";
import { PROVIDER_LABELS, providerMark, type ProviderKey } from "./auth/ProviderButtons";

export interface IdentitiesView {
  identities: { provider: ProviderKey; email: string | null; connectedAt: string; lastUsedAt: string | null }[];
  hasPassword: boolean;
  available: ProviderKey[];
}

export const useIdentities = () => useQuery({ queryKey: ["auth", "identities"], queryFn: () => api<IdentitiesView>("/auth/identities") });

/**
 * Shows the outcome of a Google / Zoho redirect once (?connected=… or ?signin_error=…) and removes
 * it from the address bar.
 */
export function useRedirectNotice() {
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  useEffect(() => {
    const connected = params.get("connected") as ProviderKey | null;
    const error = params.get("signin_error");
    if (!connected && !error) return;
    if (connected && PROVIDER_LABELS[connected]) toast("success", `${PROVIDER_LABELS[connected]} account connected. You can now sign in with it.`);
    if (error) toast("error", error);
    params.delete("connected");
    params.delete("signin_error");
    setParams(params, { replace: true });
  }, [params, setParams, toast]);
}

/** Settings → Account & theme: the Google / Zoho accounts this user can sign in with. */
export function ConnectedAccountsCard() {
  const identities = useIdentities();
  const toast = useToast();
  const qc = useQueryClient();
  const disconnect = useMutation({
    mutationFn: (p: ProviderKey) => api(`/auth/identities/${p}`, { method: "DELETE" }),
    onSuccess: (_r, p) => {
      toast("success", `${PROVIDER_LABELS[p]} account disconnected`);
      void qc.invalidateQueries({ queryKey: ["auth", "identities"] });
    },
    onError: (e: Error) => toast("error", e.message),
  });
  const data = identities.data;
  const providers = [...new Set([...(data?.available ?? []), ...(data?.identities.map((i) => i.provider) ?? [])])];
  if (data && providers.length === 0) return null;

  return (
    <Card title="Sign in with Google or Zoho">
      {!data ? (
        <Spinner />
      ) : (
        <ul className="divide-y divide-line text-sm">
          {providers.map((p) => {
            const linked = data.identities.find((i) => i.provider === p);
            return (
              <li key={p} className="flex flex-wrap items-center gap-3 px-4 py-3">
                {providerMark(p, "h-5 w-5")}
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{PROVIDER_LABELS[p]}</div>
                  <div className="text-xs text-ink-secondary">
                    {linked ? `Connected as ${linked.email ?? "your account"} · last used ${relativeTime(linked.lastUsedAt ?? linked.connectedAt)}` : "Not connected"}
                  </div>
                </div>
                {linked ? (
                  <Button size="sm" variant="ghost" loading={disconnect.isPending && disconnect.variables === p} onClick={() => disconnect.mutate(p)}>
                    Disconnect
                  </Button>
                ) : data.available.includes(p) ? (
                  // A plain link: the server sends the browser to the provider and back.
                  <a href={`/api/auth/oauth/${p}/start?link=1`} className="inline-flex h-8 items-center rounded-md border border-line-strong px-2.5 text-sm font-medium hover:bg-line/40">
                    Connect
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
