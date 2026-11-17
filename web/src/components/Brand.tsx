import clsx from "clsx";

export const APP_NAME = "Zoho IBMS CCTV Monitoring";

/** The IBMS mark: the building in a circle, white on IBMS blue (public/ibms-mark.png). */
export function IbmsMark({ className }: { className?: string }) {
  return <img src="/ibms-mark.png" alt="" aria-hidden draggable={false} className={clsx("rounded-[22%] object-cover", className)} />;
}

/**
 * The Zoho logo (public/zoho-logo.png): its "ZOHO" letters are black, so dark backgrounds (the
 * sign-in panel, dark mode) get the copy with white letters (zoho-logo-dark.png).
 */
export function ZohoLogo({ onDark, className }: { onDark?: boolean; className?: string }) {
  if (onDark) return <img src="/zoho-logo-dark.png" alt="Zoho" draggable={false} className={className} />;
  return (
    <>
      <img src="/zoho-logo.png" alt="Zoho" draggable={false} className={clsx("dark:hidden", className)} />
      <img src="/zoho-logo-dark.png" alt="Zoho" draggable={false} className={clsx("hidden dark:block", className)} />
    </>
  );
}

/**
 * The app's name as a brand: the IBMS mark with "IBMS" under it, and a two-line wordmark,
 * "Zoho IBMS" over "CCTV MONITORING", with the Zoho logo under them. `compact` shows the mark only;
 * `onDark` is for dark panels.
 */
export function Brand({ compact, onDark, size = "md", className, withZoho = true }: { compact?: boolean; onDark?: boolean; size?: "sm" | "md" | "lg"; className?: string; withZoho?: boolean }) {
  const mark = compact ? "h-7 w-7" : size === "lg" ? "h-12 w-12" : size === "sm" ? "h-7 w-7" : "h-9 w-9";
  const lockup = (
    <span className={clsx("inline-flex min-w-0 items-center gap-2", compact && className)} title={compact ? APP_NAME : undefined}>
      {/* The IBMS logo with "IBMS" under it. */}
      <span className="flex shrink-0 flex-col items-center leading-none">
        <IbmsMark className={mark} />
        <span
          className={clsx(
            "font-bold uppercase",
            compact ? "mt-0.5 text-[7px] tracking-[0.3em]" : size === "lg" ? "mt-1 text-[11px] tracking-[0.42em]" : "mt-0.5 text-[8px] tracking-[0.38em]",
            onDark ? "text-white" : "text-ink",
          )}
          style={{ marginRight: "-0.38em" }}
        >
          IBMS
        </span>
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
          <span className={clsx("mt-1 truncate font-semibold uppercase", size === "lg" ? "text-[11px] tracking-[0.22em]" : "text-[9px] tracking-[0.14em]", onDark ? "text-white/70" : "text-ink-secondary")}>
            CCTV Monitoring
          </span>
        </span>
      )}
      <span className="sr-only">{APP_NAME}</span>
    </span>
  );
  if (compact || !withZoho) return compact ? lockup : <span className={className}>{lockup}</span>;
  // The Zoho logo under the IBMS logo and name.
  return (
    <span className={clsx("inline-flex min-w-0 flex-col items-start", size === "lg" ? "gap-3" : "gap-2", className)}>
      {lockup}
      <ZohoLogo onDark={onDark} className={clsx("w-auto", size === "lg" ? "h-10" : size === "sm" ? "h-5" : "h-7")} />
    </span>
  );
}
