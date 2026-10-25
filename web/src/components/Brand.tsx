import clsx from "clsx";
import { Video } from "lucide-react";

export const APP_NAME = "Zoho IBMS CCTV Monitoring";

/**
 * The app's name as a brand: a logo tile (camera with a recording light) and a two-line wordmark,
 * "Zoho IBMS" over "CCTV MONITORING". `compact` shows the tile only; `onDark` is for dark panels.
 */
export function Brand({ compact, onDark, size = "md", className }: { compact?: boolean; onDark?: boolean; size?: "sm" | "md" | "lg"; className?: string }) {
  const tile = size === "lg" ? "h-11 w-11 rounded-xl" : size === "sm" ? "h-8 w-8 rounded-lg" : "h-9 w-9 rounded-[10px]";
  const icon = size === "lg" ? "h-6 w-6" : size === "sm" ? "h-4 w-4" : "h-5 w-5";
  return (
    <span className={clsx("inline-flex min-w-0 items-center gap-2.5", className)} title={compact ? APP_NAME : undefined}>
      <span
        className={clsx(
          "relative flex shrink-0 items-center justify-center text-white shadow-md",
          tile,
          onDark ? "bg-white/15 ring-1 ring-white/25 shadow-black/20" : "bg-gradient-to-br from-accent to-[#0b3d91] shadow-accent/30",
        )}
        aria-hidden
      >
        <Video className={icon} strokeWidth={2.2} />
        {/* The recording light */}
        <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-red-500 ring-2 ring-red-500/30 motion-safe:animate-pulse" />
      </span>
      {!compact && (
        <span className="flex min-w-0 flex-col leading-none">
          <span
            className={clsx(
              "truncate font-extrabold tracking-tight",
              size === "lg" ? "text-xl" : size === "sm" ? "text-sm" : "text-base",
              onDark ? "text-white" : "bg-gradient-to-r from-ink to-accent bg-clip-text text-transparent",
            )}
          >
            Zoho IBMS
          </span>
          <span className={clsx("mt-1 truncate font-semibold uppercase tracking-[0.22em]", size === "lg" ? "text-[11px]" : "text-[9.5px]", onDark ? "text-white/70" : "text-ink-secondary")}>
            CCTV Monitoring
          </span>
        </span>
      )}
      <span className="sr-only">{APP_NAME}</span>
    </span>
  );
}
