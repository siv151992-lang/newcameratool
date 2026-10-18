import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, onUnauthorized, setCsrfToken } from "../api/client";
import type { User } from "../api/types";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const qc = useQueryClient();

  useEffect(() => {
    api<{ user: User; csrfToken: string }>("/auth/me")
      .then((r) => {
        setCsrfToken(r.csrfToken);
        setUser(r.user);
      })
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) console.warn(e);
      })
      .finally(() => setLoading(false));
    return onUnauthorized(() => {
      setUser(null);
      qc.clear();
    });
  }, [qc]);

  const login = useCallback(async (username: string, password: string) => {
    const r = await api<{ user: User; csrfToken: string }>("/auth/login", { method: "POST", body: { username, password } });
    setCsrfToken(r.csrfToken);
    setUser(r.user);
  }, []);

  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    setCsrfToken(null);
    setUser(null);
    qc.clear();
  }, [qc]);

  const can = useCallback((p: string) => !!user?.permissions.includes(p), [user]);

  return <AuthContext.Provider value={{ user, loading, login, logout, can }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
