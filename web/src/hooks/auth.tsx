import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, onUnauthorized, setCsrfToken } from "../api/client";
import type { Membership, PendingInvitation, User } from "../api/types";

interface AuthState {
  user: User | null;
  /** The organizations the user belongs to. */
  organizations: Membership[];
  /** Open invitations to the user's confirmed email address. */
  invitations: PendingInvitation[];
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Moves this session to another organization; everything on screen reloads for it. */
  switchOrganization: (organizationId: string) => Promise<void>;
  /** Reloads the user and their organizations (after signing up, confirming an email, or joining or creating one). */
  refresh: () => Promise<void>;
  can: (permission: string) => boolean;
}

interface Me {
  user: User;
  csrfToken: string;
  organizations: Membership[];
  invitations: PendingInvitation[];
}

const AuthContext = createContext<AuthState | null>(null);

/** Roles as people see them: an organization's admin is its Org Admin. */
export const ROLE_LABELS: Record<string, string> = { admin: "Org Admin", operator: "Operator", viewer: "Viewer" };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [organizations, setOrganizations] = useState<Membership[]>([]);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  const load = useCallback(async () => {
    const r = await api<Me>("/auth/me");
    setCsrfToken(r.csrfToken);
    setUser(r.user);
    setOrganizations(r.organizations);
    setInvitations(r.invitations ?? []);
  }, []);

  useEffect(() => {
    load()
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) console.warn(e);
      })
      .finally(() => setLoading(false));
    return onUnauthorized(() => {
      setUser(null);
      qc.clear();
    });
  }, [qc, load]);

  const login = useCallback(async (username: string, password: string) => {
    const r = await api<{ user: User; csrfToken: string }>("/auth/login", { method: "POST", body: { username, password } });
    setCsrfToken(r.csrfToken);
    await load();
  }, [load]);

  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    setCsrfToken(null);
    setUser(null);
    setOrganizations([]);
    setInvitations([]);
    qc.clear();
  }, [qc]);

  const switchOrganization = useCallback(async (organizationId: string) => {
    await api("/auth/organization", { method: "POST", body: { organizationId } });
    qc.clear();
    await load();
  }, [qc, load]);

  const can = useCallback((p: string) => !!user?.permissions.includes(p), [user]);

  return (
    <AuthContext.Provider value={{ user, organizations, invitations, loading, login, logout, switchOrganization, refresh: load, can }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
