import { Moon, Sun, Video } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { SignInOptions } from "../../api/types";
import { Button } from "../../components/ui";
import { useTheme } from "../../hooks/theme";

/** The pages people see before they are signed in: a single card in the middle of the screen. */
export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const { theme, toggle } = useTheme();
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="absolute right-4 top-4">
        <Button variant="ghost" size="sm" onClick={toggle} aria-label="Toggle theme" icon={theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />} />
      </div>
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <Video className="h-6 w-6 shrink-0 text-accent" aria-hidden />
          <div>
            <div className="text-xs font-medium text-ink-secondary">Zoho IBMS CCTV Monitoring</div>
            <h1 className="text-lg font-semibold leading-tight">{title}</h1>
          </div>
        </div>
        {subtitle && <div className="-mt-3 mb-5 text-sm text-ink-secondary">{subtitle}</div>}
        {children}
      </div>
      {footer && <div className="mt-4 text-sm text-ink-secondary">{footer}</div>}
    </div>
  );
}

export const authLink = "font-medium text-accent-ink hover:underline";

export function BackToSignIn() {
  return <Link to="/" className={authLink}>Back to sign in</Link>;
}

/** What the server offers: creating accounts, password reset, first-time setup. */
export function useSignInOptions() {
  return useQuery({ queryKey: ["auth", "options"], queryFn: () => api<SignInOptions>("/auth/options"), staleTime: 60_000 });
}
