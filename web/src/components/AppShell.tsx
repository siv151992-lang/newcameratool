import clsx from "clsx";
import { Bell, Camera, LayoutDashboard, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Plug, Settings, Sparkles, Sun, Video, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api/client";
import type { Summary } from "../api/types";
import { useAiStatus } from "../hooks/ai";
import { useAuth } from "../hooks/auth";
import { useTheme } from "../hooks/theme";
import { Button } from "./ui";

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

export function AppShell() {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
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
        <div className={clsx("mb-6 flex items-center gap-2", collapsed ? "justify-center" : "px-2")} title={collapsed ? "Zoho IBMS CCTV Monitoring" : undefined}>
          <Video className="h-5 w-5 shrink-0 text-accent" aria-hidden />
          {!collapsed && <span className="font-semibold leading-tight">Zoho IBMS CCTV Monitoring</span>}
        </div>
        {nav(collapsed)}
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={close} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-line bg-surface p-4">
            <div className="mb-6 flex items-center justify-between px-2">
              <span className="font-semibold">Zoho IBMS CCTV Monitoring</span>
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
          <span className="font-semibold lg:hidden">Zoho IBMS CCTV Monitoring</span>
          <div className="flex-1" />
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
            <div className="capitalize text-ink-muted">{user?.role}</div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void logout()} icon={<LogOut className="h-4 w-4" />}>
            <span className="hidden sm:inline">Sign out</span>
          </Button>
        </header>
        <main id="main" className="mx-auto w-full max-w-7xl flex-1 px-4 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
