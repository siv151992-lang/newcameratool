import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronLeft, ChevronRight, Film, Maximize2, Play, Rewind, FastForward, Square } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { api } from "../api/client";
import { LiveVideo } from "./LiveVideo";
import { Button, Dialog, EmptyState, ErrorMessage, Input, Spinner } from "./ui";

interface Segment {
  start: string;
  end: string;
}
interface Day {
  date: string;
  cameraNow: string;
  segments: Segment[];
}

/** Camera wall-clock times ("YYYY-MM-DDTHH:MM:SS") are handled as UTC instants so no zone shifts them. */
const ms = (t: string) => Date.parse(`${t}Z`);
const text = (m: number) => new Date(m).toISOString().slice(0, 19);
const clock = (t: string) => t.slice(11, 19);
const DAY = 86_400_000;
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
function duration(a: string, b: string) {
  const min = Math.round((ms(b) - ms(a)) / 60_000);
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

/** The recordings on a camera's own storage: pick a day, see what was recorded, play from any time. */
export function RecordingsDialog({ camera, onClose }: { camera: { id: string; name: string } | null; onClose: () => void }) {
  return (
    <Dialog open={!!camera} onClose={onClose} title={camera ? `Recordings: ${camera.name}` : "Recordings"} size="xl">
      {camera && <RecordingsBody key={camera.id} cameraId={camera.id} name={camera.name} />}
    </Dialog>
  );
}

function RecordingsBody({ cameraId, name }: { cameraId: string; name: string }) {
  const [date, setDate] = useState(today);
  const [start, setStart] = useState<string | null>(null);
  const [played, setPlayed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const video = useQuery({ queryKey: ["live-video"], queryFn: () => api<{ enabled: boolean }>("/cameras/live-video"), staleTime: 5 * 60_000 });
  const day = useQuery({ queryKey: ["recordings", cameraId, date], queryFn: () => api<Day>(`/cameras/${cameraId}/recordings?date=${date}`) });
  const onFailed = useCallback((m: string) => setError(m), []);

  const dayStart = ms(`${date}T00:00:00`);
  const play = (t: string) => {
    setError(null);
    setPlayed(0);
    setStart(t);
  };
  const position = start ? text(ms(start) + played * 1000) : null;
  const jump = (seconds: number) => position && play(text(Math.max(dayStart, ms(position) + seconds * 1000)));
  const shiftDay = (days: number) => {
    setStart(null);
    setDate(text(dayStart + days * DAY).slice(0, 10));
  };
  // A click on the timeline plays from there, or from the next recording after it.
  const onTimeline = (e: React.MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const at = dayStart + Math.round(((e.clientX - box.left) / box.width) * DAY / 1000) * 1000;
    const segs = day.data?.segments ?? [];
    const inside = segs.find((s) => ms(s.start) <= at && at < ms(s.end));
    const next = segs.find((s) => ms(s.start) > at);
    if (inside) play(text(at));
    else if (next) play(next.start);
  };

  if (video.data && !video.data.enabled) {
    return <ErrorMessage error={new Error("Playing recordings needs the live video service (go2rtc), which is not set up on this server.")} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" icon={<ChevronLeft className="h-4 w-4" />} onClick={() => shiftDay(-1)} aria-label="Previous day" />
        <Input type="date" aria-label="Day" className="w-auto" value={date} max={today()} onChange={(e) => e.target.value && (setStart(null), setDate(e.target.value))} />
        <Button size="sm" variant="ghost" icon={<ChevronRight className="h-4 w-4" />} onClick={() => shiftDay(1)} disabled={date >= today()} aria-label="Next day" />
        <span className="text-xs text-ink-secondary">Times are the camera's clock{day.data ? ` (camera time now ${day.data.cameraNow.replace("T", " ")})` : ""}.</span>
      </div>

      {/* 24-hour timeline: recorded periods in color, the playing position as a line. */}
      <div>
        <div
          role="button"
          tabIndex={0}
          aria-label="Timeline of the day: click to play from that time"
          onClick={onTimeline}
          className="relative h-9 cursor-pointer overflow-hidden rounded-md border border-line bg-raised"
        >
          {day.data?.segments.map((s) => (
            <div
              key={s.start}
              className="absolute inset-y-1 rounded-sm bg-accent/70 hover:bg-accent"
              style={{ left: `${((ms(s.start) - dayStart) / DAY) * 100}%`, width: `${Math.max(0.2, ((ms(s.end) - ms(s.start)) / DAY) * 100)}%` }}
              title={`${clock(s.start)} – ${clock(s.end)}`}
            />
          ))}
          {position && position.slice(0, 10) === date && (
            <div className="absolute inset-y-0 w-0.5 bg-bad" style={{ left: `${((ms(position) - dayStart) / DAY) * 100}%` }} aria-hidden />
          )}
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-ink-muted tabular" aria-hidden>
          {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => <span key={h}>{String(h).padStart(2, "0")}:00</span>)}
        </div>
      </div>

      {start && (
        <div className="space-y-2">
          <div ref={frame} className="relative mx-auto flex aspect-video max-h-[42vh] items-center justify-center overflow-hidden rounded-md bg-black">
            <LiveVideo key={start} cameraId={cameraId} name={name} playbackStart={start} onFailed={onFailed} onTime={setPlayed} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="tabular text-sm">
              Playing <strong>{position?.replace("T", " ")}</strong>
              <span className="text-ink-secondary"> · started at {clock(start)}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<Rewind className="h-4 w-4" />} onClick={() => jump(-60)}>1 min back</Button>
              <Button size="sm" icon={<FastForward className="h-4 w-4" />} onClick={() => jump(60)}>1 min ahead</Button>
              <Button size="sm" icon={<Maximize2 className="h-4 w-4" />} onClick={() => void frame.current?.requestFullscreen?.()}>Full screen</Button>
              <Button size="sm" icon={<Square className="h-4 w-4" />} onClick={() => setStart(null)}>Stop</Button>
            </div>
          </div>
          {error && <ErrorMessage error={new Error(error)} />}
        </div>
      )}

      {day.isLoading ? (
        <Spinner label="Searching the camera's recordings" />
      ) : day.error ? (
        <ErrorMessage error={day.error} />
      ) : !day.data?.segments.length ? (
        <EmptyState icon={<Film className="h-6 w-6" />} title="No recordings on this day" description="The camera's storage holds nothing recorded on this date." />
      ) : (
        <div className="max-h-56 overflow-y-auto rounded-md border border-line">
          <table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-surface text-xs text-ink-secondary">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Recorded</th>
                <th scope="col" className="px-3 py-2 font-medium">Length</th>
                <th scope="col" className="px-3 py-2 text-right font-medium"><span className="sr-only">Play</span></th>
              </tr>
            </thead>
            <tbody>
              {day.data.segments.map((s) => (
                <tr key={s.start} className={clsx("border-t border-line", start && ms(start) >= ms(s.start) && ms(start) < ms(s.end) && "bg-accent-soft/40")}>
                  <td className="tabular px-3 py-1.5">{clock(s.start)} – {clock(s.end)}</td>
                  <td className="px-3 py-1.5 text-ink-secondary">{duration(s.start, s.end)}</td>
                  <td className="px-3 py-1.5 text-right">
                    <Button size="sm" icon={<Play className="h-4 w-4" />} onClick={() => play(s.start)}>Play</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
