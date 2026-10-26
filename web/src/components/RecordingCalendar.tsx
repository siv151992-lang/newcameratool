import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { CalendarDays, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { Button } from "./ui";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const monthName = (month: string) =>
  new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const shiftMonth = (month: string, by: number) => {
  const d = new Date(`${month}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + by);
  return d.toISOString().slice(0, 7);
};
const display = (date: string) => `${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}`;

/**
 * A day picker for a camera's recordings: the days its storage holds recordings are marked, so you
 * can see at a glance which dates have something to play.
 */
export function RecordingCalendar({ cameraId, channel, value, max, onChange }: { cameraId: string; channel?: number; value: string; max: string; onChange: (date: string) => void }) {
  const [open, setOpen] = useState(false);
  // Placed against the window (fixed), so the scrolling dialog it sits in does not cut it off.
  const [at, setAt] = useState({ top: 0, left: 0 });
  const [month, setMonth] = useState(value.slice(0, 7));
  const box = useRef<HTMLDivElement>(null);
  const days = useQuery({
    queryKey: ["recording-days", cameraId, channel, month],
    queryFn: () => api<{ days: string[] }>(`/cameras/${cameraId}/recordings/days?month=${month}${channel ? `&channel=${channel}` : ""}`),
    enabled: open,
    staleTime: 60_000,
  });
  const recorded = new Set(days.data?.days ?? []);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const shut = () => setOpen(false);
    document.addEventListener("mousedown", away);
    window.addEventListener("resize", shut);
    return () => {
      document.removeEventListener("mousedown", away);
      window.removeEventListener("resize", shut);
    };
  }, [open]);

  const first = new Date(`${month}-01T00:00:00Z`);
  const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const cells: (string | null)[] = [
    ...Array<null>(first.getUTCDay()).fill(null),
    ...Array.from({ length: count }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`),
  ];
  const pick = (date: string) => {
    onChange(date);
    setOpen(false);
  };

  return (
    <div ref={box} className="relative">
      <Button
        size="sm"
        icon={<CalendarDays className="h-4 w-4" />}
        aria-label={`Day: ${display(value)}. Choose a day`}
        aria-expanded={open}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt({ top: Math.min(r.bottom + 4, window.innerHeight - 380), left: Math.min(r.left, window.innerWidth - 296) });
          setMonth(value.slice(0, 7));
          setOpen((o) => !o);
        }}
      >
        <span className="tabular">{display(value)}</span>
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Choose a day"
          style={{ top: Math.max(8, at.top), left: Math.max(8, at.left) }}
          className="fixed z-50 w-72 rounded-md border border-line bg-surface p-3 shadow-lg"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <div className="mb-2 flex items-center justify-between">
            <Button size="sm" variant="ghost" icon={<ChevronLeft className="h-4 w-4" />} onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month" />
            <span className="text-sm font-semibold">{monthName(month)}</span>
            <Button size="sm" variant="ghost" icon={<ChevronRight className="h-4 w-4" />} onClick={() => setMonth(shiftMonth(month, 1))} disabled={month >= max.slice(0, 7)} aria-label="Next month" />
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-xs">
            {WEEKDAYS.map((d) => <span key={d} className="py-1 font-medium text-ink-muted">{d}</span>)}
            {cells.map((date, i) => {
              if (!date) return <span key={`blank-${i}`} />;
              const has = recorded.has(date);
              const future = date > max;
              return (
                <button
                  key={date}
                  type="button"
                  disabled={future}
                  onClick={() => pick(date)}
                  aria-label={`${display(date)}${has ? ", has recordings" : ""}`}
                  aria-pressed={date === value}
                  className={clsx(
                    "tabular relative h-8 rounded-md text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-30",
                    date === value
                      ? "bg-accent font-semibold text-white"
                      : has
                        ? "bg-accent/20 font-medium text-ink hover:bg-accent/35"
                        : "text-ink-muted hover:bg-raised",
                    date === max && date !== value && "ring-1 ring-accent",
                  )}
                >
                  {Number(date.slice(8))}
                  {has && date !== value && <span className="absolute bottom-1 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-accent" aria-hidden />}
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex items-center justify-between text-xs text-ink-secondary">
            {days.isFetching ? (
              <span role="status" className="flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Checking the camera…</span>
            ) : days.error ? (
              <span className="text-bad">Could not read the recorded days</span>
            ) : (
              <span className="flex items-center gap-1.5">
                <span className="h-3 w-3 rounded-sm bg-accent/20 ring-1 ring-accent/50" aria-hidden /> {recorded.size} day{recorded.size === 1 ? "" : "s"} with recordings
              </span>
            )}
            <button type="button" className="font-medium text-accent hover:underline" onClick={() => pick(max)}>Today</button>
          </div>
        </div>
      )}
    </div>
  );
}
