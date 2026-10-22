import { BellRing, Building2, Cctv, HardDrive, Moon, Sun, Video } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import type { SignInOptions } from "../../api/types";
import { Button } from "../../components/ui";
import { useTheme } from "../../hooks/theme";

/** Zoho brand colors. */
const ZOHO = { red: "#E42527", green: "#089949", blue: "#226DB4", yellow: "#F9B21D" };

/** The four Zoho colors as a thin band. */
function ZohoBand({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden className={`flex ${className}`}>
      {[ZOHO.red, ZOHO.green, ZOHO.blue, ZOHO.yellow].map((c) => (
        <span key={c} className="flex-1" style={{ background: c }} />
      ))}
    </div>
  );
}

const FEATURES = [
  { icon: HardDrive, color: ZOHO.green, title: "Storage and recording", text: "SD card health, free space and days of recordings for every camera." },
  { icon: BellRing, color: ZOHO.red, title: "Alerts that matter", text: "Offline cameras, full cards and recording errors, by email as they happen." },
  { icon: Building2, color: ZOHO.yellow, title: "Organizations", text: "Each team sees only its own cameras, with the roles you choose." },
];

/** Six camera tiles with status lights: the monitoring wall the product is about. */
function CameraWall() {
  const tiles = ["good", "good", "warn", "good", "bad", "good"] as const;
  const light = { good: ZOHO.green, warn: ZOHO.yellow, bad: ZOHO.red };
  return (
    <div aria-hidden className="grid grid-cols-3 gap-2.5">
      {tiles.map((t, i) => (
        <div key={i} className="relative aspect-video overflow-hidden rounded-md border border-white/15 bg-white/[0.06]">
          <div className="absolute inset-x-2 bottom-2 h-1 rounded-full bg-white/15">
            <div className="h-1 rounded-full bg-white/50" style={{ width: `${[46, 62, 88, 35, 97, 54][i]}%` }} />
          </div>
          <Cctv className="absolute left-2 top-2 h-3.5 w-3.5 text-white/40" />
          <span className="absolute right-2 top-2 h-2 w-2 rounded-full" style={{ background: light[t], boxShadow: `0 0 8px ${light[t]}` }} />
        </div>
      ))}
    </div>
  );
}

/**
 * The pages people see before they are signed in. Wide screens show the product on the left and the
 * form on the right; narrow screens show the form alone.
 */
export function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const { theme, toggle } = useTheme();
  return (
    <div className="flex min-h-screen">
      <aside
        className="relative hidden w-[46%] max-w-[640px] flex-col justify-between overflow-hidden p-10 text-white lg:flex xl:p-14"
        style={{ background: `linear-gradient(150deg, #0c2340 0%, #164a80 50%, ${ZOHO.blue} 100%)` }}
      >
        <ZohoBand className="absolute inset-x-0 top-0 h-1.5" />
        {/* Fine dot grid and a soft light, behind everything. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-60" style={{ backgroundImage: "radial-gradient(rgb(255 255 255 / 0.10) 1px, transparent 1px)", backgroundSize: "22px 22px" }} />
        {/* Soft lights in the Zoho colors. */}
        <div aria-hidden className="pointer-events-none absolute -right-28 -top-28 h-80 w-80 rounded-full blur-3xl" style={{ background: ZOHO.yellow, opacity: 0.14 }} />
        <div aria-hidden className="pointer-events-none absolute -bottom-36 -left-20 h-96 w-96 rounded-full blur-3xl" style={{ background: ZOHO.green, opacity: 0.16 }} />
        <div aria-hidden className="pointer-events-none absolute -bottom-24 right-0 h-72 w-72 rounded-full blur-3xl" style={{ background: ZOHO.red, opacity: 0.12 }} />

        <div className="relative flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/20">
            <Video className="h-5 w-5" aria-hidden />
          </span>
          <span className="text-lg font-semibold tracking-tight">Zoho IBMS CCTV Monitoring</span>
        </div>

        <div className="relative space-y-8">
          <div>
            <h2 className="text-3xl font-semibold leading-tight tracking-tight xl:text-4xl">Every camera's storage, at a glance.</h2>
            <p className="mt-3 max-w-md text-white/70">Know before a card fills up, a camera goes offline or recording stops.</p>
          </div>
          <CameraWall />
          <ul className="space-y-4">
            {FEATURES.map(({ icon: Icon, color, title: t, text }) => (
              <li key={t} className="flex gap-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md" style={{ background: color }}>
                  <Icon className="h-4 w-4" aria-hidden />
                </span>
                <span>
                  <span className="block text-sm font-medium">{t}</span>
                  <span className="block text-sm text-white/65">{text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-white/50">Hikvision · Dahua · Axis · Hanwha · Uniview · Panasonic · ONVIF</p>
      </aside>

      <main className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-4 py-10">
        <ZohoBand className="absolute inset-x-0 top-0 h-1 lg:hidden" />
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-80 " style={{ backgroundImage: `linear-gradient(to bottom, ${ZOHO.blue}1a, transparent)` }} />
        <div aria-hidden className="pointer-events-none absolute -right-24 bottom-0 h-72 w-72 rounded-full blur-3xl" style={{ background: ZOHO.yellow, opacity: 0.08 }} />
        <div aria-hidden className="pointer-events-none absolute -left-24 bottom-10 h-64 w-64 rounded-full blur-3xl" style={{ background: ZOHO.green, opacity: 0.07 }} />
        <div className="absolute right-4 top-4">
          <Button variant="ghost" size="sm" onClick={toggle} aria-label="Toggle theme" icon={theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />} />
        </div>
        <div className="relative w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2 lg:hidden">
            <Video className="h-6 w-6 text-accent" aria-hidden />
            <span className="font-semibold">Zoho IBMS CCTV Monitoring</span>
          </div>
          <div className="overflow-hidden rounded-xl border border-line bg-surface/95 shadow-lg shadow-black/5 backdrop-blur">
            <ZohoBand className="h-1" />
            <div className="p-6 sm:p-7">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {subtitle && <div className="mt-1 text-sm text-ink-secondary">{subtitle}</div>}
            <div className="mt-5">{children}</div>
            </div>
          </div>
          {footer && <div className="mt-5 text-center text-sm text-ink-secondary">{footer}</div>}
        </div>
      </main>
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
