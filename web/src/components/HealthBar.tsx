import { AlertOctagon } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useSystemHealth } from "../pages/SystemPages";

/** For the super admin, on every page: a red bar while part of the installation has a problem. */
export function HealthBar() {
  const { pathname } = useLocation();
  const q = useSystemHealth();
  const bad = q.data?.items.filter((i) => i.status === "bad") ?? [];
  if (!bad.length || pathname === "/settings/health") return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-bad/30 bg-bad/10 px-4 py-2 text-sm">
      <AlertOctagon className="h-4 w-4 text-bad" aria-hidden />
      <span className="font-medium text-bad">System health:</span>
      <span>{bad.map((i) => `${i.label} – ${i.value}`).join(" · ")}</span>
      <Link to="/settings/health" className="ml-auto font-medium text-accent-ink hover:underline">Details</Link>
    </div>
  );
}
