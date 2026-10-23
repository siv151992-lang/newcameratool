import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { useToast } from "../components/toast";
import { PROVIDER_LABELS, type ProviderKey } from "./auth/ProviderButtons";

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
