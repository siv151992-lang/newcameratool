import clsx from "clsx";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

const MAX = 8;
const STEP = 1.5;

/**
 * Digital zoom on a picture or video: the wheel zooms on the point under the pointer, dragging
 * moves around while zoomed, a double-click zooms in on a spot (or back out), and buttons zoom
 * from the middle. The picture never leaves the frame. Only the view is enlarged: the camera
 * sends the same picture (a camera's own optical zoom needs PTZ controls).
 */
export function ZoomPan({ children, className }: { children: ReactNode; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  /** Keeps the enlarged picture covering the frame. */
  const clampView = (scale: number, x: number, y: number) => {
    const el = box.current;
    const w = el?.clientWidth ?? 0;
    const h = el?.clientHeight ?? 0;
    return { scale, x: Math.min(0, Math.max(w - w * scale, x)), y: Math.min(0, Math.max(h - h * scale, y)) };
  };

  /** Zooms to `scale` keeping the point (cx, cy) of the frame where it is. */
  const zoomAt = (scale: number, cx?: number, cy?: number) =>
    setView((v) => {
      const el = box.current;
      const s = Math.min(MAX, Math.max(1, scale));
      if (s === 1) return { scale: 1, x: 0, y: 0 };
      const px = cx ?? (el?.clientWidth ?? 0) / 2;
      const py = cy ?? (el?.clientHeight ?? 0) / 2;
      return clampView(s, px - ((px - v.x) / v.scale) * s, py - ((py - v.y) / v.scale) * s);
    });

  // The wheel zooms the picture, not the page (React's wheel listener cannot stop scrolling).
  const scaleRef = useRef(view.scale);
  scaleRef.current = view.scale;
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(scaleRef.current * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // zoomAt only uses refs and the state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const zoomed = view.scale > 1;
  return (
    <div
      ref={box}
      className={clsx("relative h-full w-full overflow-hidden", zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in", className)}
      onPointerDown={(e) => {
        if (!zoomed || e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) setView(clampView(view.scale, d.x + e.clientX - d.px, d.y + e.clientY - d.py));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        zoomAt(zoomed ? 1 : 2.5, e.clientX - r.left, e.clientY - r.top);
      }}
    >
      <div className="h-full w-full origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
        {children}
      </div>
      <div className="absolute right-2 top-2 flex items-center gap-0.5 rounded-full bg-black/60 p-0.5 text-white" role="group" aria-label="Picture zoom" onDoubleClick={(e) => e.stopPropagation()}>
        <ZoomButton label="Zoom out of the picture" onClick={() => zoomAt(view.scale / STEP)} disabled={!zoomed}><Minus className="h-4 w-4" /></ZoomButton>
        <span className="min-w-[2.5rem] text-center text-xs tabular" aria-live="polite">{Math.round(view.scale * 10) / 10}×</span>
        <ZoomButton label="Zoom into the picture" onClick={() => zoomAt(view.scale * STEP)} disabled={view.scale >= MAX}><Plus className="h-4 w-4" /></ZoomButton>
        {zoomed && <ZoomButton label="Show the whole picture" onClick={() => zoomAt(1)}><RotateCcw className="h-3.5 w-3.5" /></ZoomButton>}
      </div>
    </div>
  );
}

function ZoomButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-white/20 disabled:opacity-40"
    >
      {children}
    </button>
  );
}
