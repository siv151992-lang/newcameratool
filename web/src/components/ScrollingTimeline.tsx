import clsx from "clsx";
import { Crosshair, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui";

const HOUR = 3_600_000;
/** How much of the day one screen width shows, from close up to the whole range. */
const ZOOMS = [0.25, 0.5, 1, 2, 4, 8, Infinity].map((h) => h * HOUR);
const zoomLabel = (w: number) => (w === Infinity ? "Fit" : w < HOUR ? `${w / 60_000} min` : `${w / HOUR} h`);
const hhmm = (t: number, dayStart: number) => (t - dayStart >= 86_400_000 ? "24:00" : new Date(t).toISOString().slice(11, 16));

/** Labels on round times: about 8 per screen width. */
function ticks(from: number, to: number, perScreen: number): number[] {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180].map((m) => m * 60_000);
  const step = steps.find((s) => perScreen / s <= 8) ?? steps.at(-1)!;
  const out: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push(t);
  return out;
}

/**
 * A timeline like a recorder's: zoom in to see minutes, drag or scroll sideways to move along the
 * day, click to play from a time. While playing, it keeps the playing position in the middle until
 * the user moves it themselves (then "Follow" brings it back).
 */
export function ScrollingTimeline({
  from,
  to,
  dayStart,
  segments,
  position,
  onPick,
}: {
  from: number;
  to: number;
  dayStart: number;
  segments: { start: number; end: number; title: string }[];
  position: number | null;
  onPick: (at: number) => void;
}) {
  const span = Math.max(to - from, 60_000);
  const [zoom, setZoom] = useState(2); // 1 h per screen width
  const width = Math.min(ZOOMS[zoom]!, span);
  // The zoom level in use: the first that shows the whole range once it fits.
  const level = width >= span ? ZOOMS.findIndex((z) => z >= span) : zoom;
  const scale = span / width; // content width in screen widths
  const box = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const drag = useRef<{ x: number; left: number; moved: boolean } | null>(null);
  const pct = (t: number) => ((t - from) / span) * 100;

  // Keep the playing position in the middle while following.
  useEffect(() => {
    const el = box.current;
    if (!el || position === null || !follow) return;
    const x = ((position - from) / span) * el.scrollWidth;
    el.scrollTo({ left: x - el.clientWidth / 2 });
  }, [position, follow, from, span, scale]);

  // Zooming keeps the middle of the view (or the playing position) in place.
  const zoomTo = (next: number) => {
    const el = box.current;
    const center = el ? from + ((el.scrollLeft + el.clientWidth / 2) / el.scrollWidth) * span : from;
    setZoom(next);
    requestAnimationFrame(() => {
      if (!el) return;
      const at = follow && position !== null ? position : center;
      el.scrollTo({ left: ((at - from) / span) * el.scrollWidth - el.clientWidth / 2 });
    });
  };

  const timeAt = (clientX: number) => {
    const el = box.current!;
    const r = el.getBoundingClientRect();
    return from + Math.round((((clientX - r.left + el.scrollLeft) / el.scrollWidth) * span) / 1000) * 1000;
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-end gap-1">
        {!follow && position !== null && (
          <Button size="sm" variant="ghost" icon={<Crosshair className="h-3.5 w-3.5" />} onClick={() => setFollow(true)}>Follow</Button>
        )}
        <Button size="sm" variant="ghost" icon={<ZoomOut className="h-3.5 w-3.5" />} onClick={() => zoomTo(level + 1)} disabled={width >= span} aria-label="Zoom out" />
        <span className="w-12 text-center text-xs text-ink-secondary tabular">{width >= span ? "Fit" : zoomLabel(width)}</span>
        <Button size="sm" variant="ghost" icon={<ZoomIn className="h-3.5 w-3.5" />} onClick={() => zoomTo(Math.max(0, level - 1))} disabled={level === 0} aria-label="Zoom in" />
      </div>
      <div
        ref={box}
        role="slider"
        tabIndex={0}
        aria-label="Timeline: drag or scroll to move along the day, click to play from that time"
        aria-valuemin={from}
        aria-valuemax={to}
        aria-valuenow={position ?? from}
        aria-valuetext={position !== null ? hhmm(position, dayStart) : undefined}
        className={clsx("overflow-x-auto overscroll-x-contain rounded-md border border-line bg-raised select-none", scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-pointer")}
        onWheel={(e) => {
          // A mouse wheel moves along the timeline.
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && box.current) {
            box.current.scrollLeft += e.deltaY;
            setFollow(false);
          }
        }}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, left: box.current!.scrollLeft, moved: false };
          box.current!.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          if (Math.abs(e.clientX - d.x) > 4) {
            d.moved = true;
            setFollow(false);
          }
          if (d.moved) box.current!.scrollLeft = d.left - (e.clientX - d.x);
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) {
            setFollow(true);
            onPick(timeAt(e.clientX));
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            box.current!.scrollLeft += (e.key === "ArrowLeft" ? -1 : 1) * box.current!.clientWidth * 0.25;
            setFollow(false);
          }
        }}
      >
        <div className="relative" style={{ width: `${scale * 100}%` }}>
          <div className="relative h-10">
            {segments.map((s) => (
              <div
                key={s.start}
                className="absolute inset-y-1.5 rounded-sm bg-accent/70 hover:bg-accent"
                style={{ left: `${pct(s.start)}%`, width: `max(2px, ${((s.end - s.start) / span) * 100}%)` }}
                title={s.title}
              />
            ))}
            {position !== null && position >= from && position <= to && (
              <div className="absolute inset-y-0 w-0.5 bg-bad" style={{ left: `${pct(position)}%` }} aria-hidden>
                <span className="absolute -top-0 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-bad" />
              </div>
            )}
          </div>
          <div className="relative h-5 border-t border-line text-[11px] text-ink-muted tabular" aria-hidden>
            {ticks(from, to, width).map((t) => (
              <span key={t} className="absolute top-0 flex flex-col items-center" style={{ left: `${pct(t)}%`, transform: "translateX(-50%)" }}>
                <span className="h-1.5 w-px bg-line-strong" />
                <span className="whitespace-nowrap px-1">{hhmm(t, dayStart)}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
