import clsx from "clsx";

export const APP_NAME = "Zoho IBMS CCTV Monitoring";

/** The Zoho mark: four overlapping rounded squares, red, green, blue and yellow, each tilted a little. */
export function ZohoMark({ className }: { className?: string }) {
  const squares = [
    { x: 3, y: 10, color: "#E42527", turn: -9 },
    { x: 25, y: 8, color: "#089949", turn: 9 },
    { x: 47, y: 10, color: "#226DB4", turn: -7 },
    { x: 69, y: 9, color: "#F9B21D", turn: 5 },
  ];
  return (
    <svg viewBox="0 0 96 40" className={className} aria-hidden focusable="false">
      {squares.map((q) => (
        <rect key={q.color} x={q.x} y={q.y} width="22" height="22" rx="4.5" fill="none" stroke={q.color} strokeWidth="4.2"
          transform={`rotate(${q.turn} ${q.x + 11} ${q.y + 11})`} />
      ))}
    </svg>
  );
}

/**
 * The app's name as a brand: the Zoho mark and a two-line wordmark, "Zoho IBMS" over
 * "CCTV MONITORING". `compact` shows the mark only; `onDark` is for dark panels.
 */
export function Brand({ compact, onDark, size = "md", className }: { compact?: boolean; onDark?: boolean; size?: "sm" | "md" | "lg"; className?: string }) {
  const mark = compact
    ? "h-5 w-12"
    : size === "lg" ? "h-11 w-[6.5rem]" : size === "sm" ? "h-6 w-[3.6rem]" : "h-7 w-[4.1rem]";
  return (
    <span className={clsx("inline-flex min-w-0 items-center gap-2", className)} title={compact ? APP_NAME : undefined}>
      {/* The Zoho logo: the four squares with "ZOHO" under them. */}
      <span className="flex shrink-0 flex-col items-center leading-none">
        <ZohoMark className={mark} />
        <span
          className={clsx(
            "font-bold uppercase",
            compact ? "mt-0.5 text-[7px] tracking-[0.3em]" : size === "lg" ? "mt-1 text-[11px] tracking-[0.42em]" : "mt-0.5 text-[8px] tracking-[0.38em]",
            onDark ? "text-white" : "text-ink",
          )}
          style={{ marginRight: "-0.38em" }}
        >
          Zoho
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
}
