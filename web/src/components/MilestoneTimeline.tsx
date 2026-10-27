import { useEffect, useRef, useState } from "react";

const HOUR = 3_600_000;
/** Time spans the timeline can show across its width. */
export const SPANS = [
  { label: "5 min", ms: HOUR / 12 },
  { label: "15 min", ms: HOUR / 4 },
  { label: "30 min", ms: HOUR / 2 },
  { label: "1 hour", ms: HOUR },
  { label: "2 hours", ms: 2 * HOUR },
  { label: "4 hours", ms: 4 * HOUR },
  { label: "8 hours", ms: 8 * HOUR },
  { label: "12 hours", ms: 12 * HOUR },
  { label: "24 hours", ms: 24 * HOUR },
  { label: "2 days", ms: 48 * HOUR },
];

/** The next span in (direction -1, zoom in) or out (+1), or the same at either end. */
export function zoomSpan(span: number, direction: -1 | 1): number {
  const i = SPANS.findIndex((s) => s.ms >= span);
  const at = i < 0 ? SPANS.length - 1 : i;
  return SPANS[Math.min(SPANS.length - 1, Math.max(0, at + direction))]!.ms;
}
const hhmm = (t: number, withSeconds = false) => new Date(t).toISOString().slice(11, withSeconds ? 19 : 16);

/** Labels on round times, about 8 across. */
function ticks(from: number, to: number, span: number) {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360].map((m) => m * 60_000);
  const step = steps.find((s) => span / s <= 8) ?? steps.at(-1)!;
  const minor = step / (step >= 10 * 60_000 ? 5 : step >= 2 * 60_000 ? 2 : 1);
  const out: { t: number; major: boolean }[] = [];
  for (let t = Math.ceil(from / minor) * minor; t <= to; t += minor) out.push({ t, major: t % step === 0 });
  return out;
}

/**
 * A playback timeline like Milestone XProtect's: the playhead stays in the middle and the recordings
 * slide under it. Drag (or scroll the wheel over) the timeline to move through time; letting go
 * plays from the time under the playhead. A click plays from the clicked time.
 */
export function MilestoneTimeline({
  time,
  span,
  min,
  max,
  segments,
  onSeek,
  onScrub,
  onZoom,
}: {
  /** The time under the playhead (camera wall-clock, as UTC ms). */
  time: number;
  /** How much time the width shows. */
  span: number;
  min: number;
  max: number;
  segments: { start: number; end: number; title: string }[];
  /** Play from this time. */
  onSeek: (t: number) => void;
  /** The time under the playhead while dragging (null when done). */
  onScrub: (t: number | null) => void;
  /** Zoom in (-1) or out (+1): Ctrl + wheel (or a pinch), and the + and - keys. */
  onZoom?: (direction: -1 | 1) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [scrub, setScrub] = useState<number | null>(null);
  const drag = useRef<{ x: number; time: number; moved: boolean } | null>(null);
  const wheel = useRef<{ time: number; timer: ReturnType<typeof setTimeout> } | null>(null);

  // Ctrl + wheel over the timeline zooms the timeline, not the page (React's wheel listener is passive).
  const zooms = Boolean(onZoom);
  useEffect(() => {
    const el = box.current;
    if (!el || !zooms) return;
    const stop = (e: WheelEvent) => e.ctrlKey && e.preventDefault();
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  }, [zooms]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const center = scrub ?? time;
  const perPx = span / width;
  const from = center - span / 2;
  const to = center + span / 2;
  const x = (t: number) => (t - from) / perPx;
  const clamp = (t: number) => Math.min(max, Math.max(min, t));
  const setScrubbing = (t: number | null) => {
    setScrub(t);
    onScrub(t);
  };

  return (
    <div
      ref={box}
      role="slider"
      tabIndex={0}
      aria-label="Timeline: drag to move through time, click to play from a time, + and - to zoom"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={center}
      aria-valuetext={hhmm(center, true)}
      className="relative h-20 cursor-grab touch-none select-none overflow-hidden rounded-md bg-neutral-950 active:cursor-grabbing"
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, time: center, moved: false };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (Math.abs(e.clientX - d.x) > 3) d.moved = true;
        if (d.moved) setScrubbing(clamp(d.time - (e.clientX - d.x) * perPx));
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (!d) return;
        if (d.moved) {
          const t = clamp(d.time - (e.clientX - d.x) * perPx);
          setScrubbing(null);
          onSeek(t);
        } else {
          const r = e.currentTarget.getBoundingClientRect();
          onSeek(clamp(from + (e.clientX - r.left) * perPx));
        }
      }}
      onWheel={(e) => {
        // Ctrl + wheel (and a touchpad pinch, which browsers send as one) zooms.
        if (e.ctrlKey && onZoom) {
          if (Math.abs(e.deltaY) > 2) onZoom(e.deltaY < 0 ? -1 : 1);
          return;
        }
        // The wheel moves through time; playback follows once it stops turning.
        const base = wheel.current?.time ?? center;
        const t = clamp(base + (e.deltaY + e.deltaX) * perPx);
        if (wheel.current) clearTimeout(wheel.current.timer);
        wheel.current = {
          time: t,
          timer: setTimeout(() => {
            wheel.current = null;
            setScrubbing(null);
            onSeek(t);
          }, 450),
        };
        setScrubbing(t);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") onSeek(clamp(center + (e.key === "ArrowLeft" ? -1 : 1) * span * 0.05));
        if ((e.key === "+" || e.key === "=") && onZoom) onZoom(-1);
        if ((e.key === "-" || e.key === "_") && onZoom) onZoom(1);
      }}
    >
      {/* Outside the day: dimmed. */}
      {from < min && <div className="absolute inset-y-0 left-0 bg-neutral-800/60" style={{ width: Math.max(0, x(min)) }} />}
      {to > max && <div className="absolute inset-y-0 right-0 bg-neutral-800/60" style={{ left: Math.min(width, x(max)) }} />}

      {/* Recordings */}
      <div className="absolute inset-x-0 top-3 h-7">
        {segments
          .filter((s) => s.end > from && s.start < to)
          .map((s) => (
            <div
              key={s.start}
              className="absolute inset-y-0 border-y border-red-400/70 bg-red-600/80"
              style={{ left: Math.max(-2, x(s.start)), width: Math.max(2, Math.min(width + 2, x(s.end)) - Math.max(-2, x(s.start))) }}
              title={s.title}
            />
          ))}
      </div>

      {/* Time scale */}
      <div className="absolute inset-x-0 bottom-0 h-9 border-t border-neutral-700 text-[11px] text-neutral-400 tabular" aria-hidden>
        {ticks(from, to, span).map(({ t, major }) => (
          <div key={t} className="absolute top-0" style={{ left: x(t) }}>
            <div className={major ? "h-3 w-px bg-neutral-400" : "h-1.5 w-px bg-neutral-600"} />
            {major && <span className="absolute left-0 top-3.5 -translate-x-1/2 whitespace-nowrap">{t % 86_400_000 === 0 ? new Date(t).toISOString().slice(5, 10).split("-").reverse().join("-") : hhmm(t)}</span>}
          </div>
        ))}
      </div>

      {/* The playhead, fixed in the middle */}
      <div className="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-amber-400" aria-hidden>
        <div className="absolute -top-0.5 left-1/2 h-0 w-0 -translate-x-1/2 border-x-[6px] border-t-[7px] border-x-transparent border-t-amber-400" />
      </div>
    </div>
  );
}
