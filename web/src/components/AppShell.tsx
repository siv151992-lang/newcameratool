import clsx from "clsx";
import { Bell, Building2, Camera, LayoutDashboard, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Plug, Settings, Sparkles, Sun, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Summary } from "../api/types";
import { useAiStatus } from "../hooks/ai";
import { ROLE_LABELS, useAuth } from "../hooks/auth";
import { useTheme } from "../hooks/theme";
import { useToast } from "./toast";
import { Button, Select } from "./ui";
import { ZohoBand } from "./ZohoBand";
import { Brand } from "./Brand";
import { useRedirectNotice } from "../pages/ConnectedAccounts";

const SIDEBAR_KEY = "cctv-sidebar-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

function NavItem({ to, icon, children, badge, onClick, collapsed }: { to: string; icon: ReactNode; children: string; badge?: number; onClick?: () => void; collapsed?: boolean }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      onClick={onClick}
      title={collapsed ? (badge ? `${children} (${badge})` : children) : undefined}
      aria-label={collapsed ? children : undefined}
      className={({ isActive }) =>
        clsx(
          "relative flex items-center rounded-md py-2 text-sm font-medium",
          collapsed ? "justify-center px-2" : "gap-2.5 px-3",
          isActive ? "bg-accent-soft/70 text-ink" : "text-ink-secondary hover:bg-line/60 hover:text-ink",
        )
      }
    >
      <span aria-hidden>{icon}</span>
      {!collapsed && <span className="flex-1">{children}</span>}
      {badge ? (
        collapsed ? (
          <span className="tabular absolute right-0.5 top-0.5 min-w-[16px] rounded-full bg-bad px-1 text-center text-[10px] font-semibold leading-4 text-white" aria-label={`${badge} active alerts`}>
            {badge > 99 ? "99+" : badge}
          </span>
        ) : (
          <span className="tabular rounded-full bg-bad px-1.5 py-0.5 text-[11px] font-semibold text-white" aria-label={`${badge} active alerts`}>
            {badge}
          </span>
        )
      ) : null}
    </NavLink>
  );
}

/** The organization this session works in; a picker when the user belongs to several. */
function OrganizationSwitcher() {
  const { user, organizations, switchOrganization } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!user?.organizationId) return null;
  if (organizations.length < 2) {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-sm text-ink-secondary" title="Organization">
        <Building2 className="h-4 w-4 shrink-0" aria-hidden />
        <span className="truncate">{user.organizationName}</span>
      </span>
    );
  }
  return (
    <label className="flex min-w-0 items-center gap-1.5">
      <Building2 className="h-4 w-4 shrink-0 text-ink-secondary" aria-hidden />
      <span className="sr-only">Organization</span>
      <Select
        className="w-auto max-w-[14rem] py-1 text-sm"
        value={user.organizationId}
        disabled={busy}
        onChange={(e) => {
          const target = organizations.find((o) => o.id === e.target.value);
          setBusy(true);
          switchOrganization(e.target.value)
            .then(() => {
              navigate("/");
              toast("success", `Now working in ${target?.name ?? "the selected organization"}`);
            })
            .catch((err: Error) => toast("error", err.message))
            .finally(() => setBusy(false));
        }}
      >
        {organizations.map((o) => (
          <option key={o.id} value={o.id}>{o.name}</option>
        ))}
      </Select>
    </label>
  );
}

export function AppShell() {
  const { user, logout } = useAuth();
  useRedirectNotice();
  const { theme, toggle, palette } = useTheme();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? "1" : "0");
    } catch {
      // Storage unavailable: the choice lasts for this page only.
    }
  }, [collapsed]);
  const summary = useQuery({ queryKey: ["summary"], queryFn: () => api<Summary>("/cameras/summary"), refetchInterval: 30_000 });
  const ai = useAiStatus();
  const close = () => setOpen(false);
  const icon = "h-4 w-4";

  const nav = (collapsed = false) => (
    <nav aria-label="Main" className="flex flex-col gap-1">
      <NavItem to="/" icon={<LayoutDashboard className={icon} />} onClick={close} collapsed={collapsed}>Dashboard</NavItem>
      <NavItem to="/cameras" icon={<Camera className={icon} />} onClick={close} collapsed={collapsed}>Cameras</NavItem>
      <NavItem to="/alerts" icon={<Bell className={icon} />} badge={summary.data?.alerts.active} onClick={close} collapsed={collapsed}>Alerts</NavItem>
      {ai.data?.enabled && <NavItem to="/ai" icon={<Sparkles className={icon} />} onClick={close} collapsed={collapsed}>AI Mode</NavItem>}
      <NavItem to="/integrations" icon={<Plug className={icon} />} onClick={close} collapsed={collapsed}>Integrations</NavItem>
      <NavItem to="/settings" icon={<Settings className={icon} />} onClick={close} collapsed={collapsed}>Settings</NavItem>
    </nav>
  );

  return (
    <div className="min-h-screen lg:flex">
      {palette === "zoho" && <ZohoBand className="fixed inset-x-0 top-0 z-50 h-1" />}
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-raised focus:px-3 focus:py-2">
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside
        className={clsx(
          "sticky top-0 hidden h-screen shrink-0 flex-col overflow-y-auto border-r border-line bg-surface py-4 transition-[width] duration-200 lg:flex",
          collapsed ? "w-16 px-2" : "w-60 px-4",
        )}
      >
        <div className={clsx("mb-6 flex items-center", collapsed ? "justify-center" : "px-2")}>
          <Brand compact={collapsed} />
        </div>
        {nav(collapsed)}
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={close} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-line bg-surface p-4">
            <div className="mb-6 flex items-center justify-between px-2">
              <Brand />
              <Button variant="ghost" size="sm" onClick={close} aria-label="Close menu" icon={<X className="h-4 w-4" />} />
            </div>
            {nav()}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-surface/95 px-4 backdrop-blur">
          <Button variant="ghost" size="sm" className="lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu" icon={<Menu className="h-5 w-5" />} />
          <Button
            variant="ghost"
            size="sm"
            className="hidden lg:inline-flex"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            icon={collapsed ? <PanelLeftOpen className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
          />
          <Brand size="sm" className="lg:hidden" />
          <div className="flex min-w-0 flex-1 justify-end sm:justify-start sm:pl-2">
            <OrganizationSwitcher />
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={toggle}
            aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            title={theme === "dark" ? "Light theme" : "Dark theme"}
            icon={theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          />
          <div className="hidden text-right text-xs sm:block">
            <div className="font-medium text-ink">{user?.displayName ?? user?.username}</div>
            <div className="text-ink-muted">
              {[user?.role && ROLE_LABELS[user.role], user?.isSystemAdmin && "System admin"].filter(Boolean).join(" · ")}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void logout()} icon={<LogOut className="h-4 w-4" />}>
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </header>
        <main id="main" className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
