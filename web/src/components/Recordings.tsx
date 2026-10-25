import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronLeft, ChevronRight, Film, Maximize2, Play, Rewind, FastForward, SkipBack, SkipForward, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { LiveVideo } from "./LiveVideo";
import { RecordingCalendar } from "./RecordingCalendar";
import { Button, Dialog, EmptyState, ErrorMessage, Spinner } from "./ui";

interface Segment {
  start: string;
  end: string;
}
interface Day {
  date: string;
  cameraNow: string;
  segments: Segment[];
  /** The camera plays a recording from its beginning (Axis), not from any time inside it. */
  playsFromRecordingStart: boolean;
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

/** Timeline labels: the two ends, and round times (every 1 min to 3 h) between them. */
function timelineTicks(from: number, to: number): number[] {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 180].map((m) => m * 60_000);
  const step = steps.find((s) => (to - from) / s <= 8) ?? steps.at(-1)!;
  // The two ends always; round times in between, leaving room next to the ends.
  const out = [from];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) if (t - from > step / 2 && to - t > step / 2) out.push(t);
  out.push(to);
  return out;
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
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const video = useQuery({ queryKey: ["live-video"], queryFn: () => api<{ enabled: boolean }>("/cameras/live-video"), staleTime: 5 * 60_000 });
  const day = useQuery({ queryKey: ["recordings", cameraId, date], queryFn: () => api<Day>(`/cameras/${cameraId}/recordings?date=${date}`) });
  const onFailed = useCallback((m: string) => setError(m), []);

  const dayStart = ms(`${date}T00:00:00`);
  const play = (t: string) => {
    setError(null);
    setPlayed(0);
    setStartedAt(null);
    setStart(t);
  };
  const from = startedAt ?? start;
  const position = from ? text(ms(from) + played * 1000) : null;
  const jump = (seconds: number) => position && play(text(Math.max(dayStart, ms(position) + seconds * 1000)));
  // From start: the oldest recording on the camera; Latest: the newest minute recorded. The day is
  // listed first, so playback knows the recordings around the time.
  const [pending, setPending] = useState<{ kind: "oldest"; at: string } | { kind: "latest"; date: string } | null>(null);
  const [finding, setFinding] = useState(false);
  const goTo = (p: NonNullable<typeof pending>) => {
    setStart(null);
    setPending(p);
    setDate(p.kind === "oldest" ? p.at.slice(0, 10) : p.date);
  };
  const playOldest = async () => {
    setError(null);
    setFinding(true);
    try {
      const { oldest } = await api<{ oldest: string | null }>(`/cameras/${cameraId}/recordings/oldest`);
      if (oldest) goTo({ kind: "oldest", at: oldest });
      else setError("The camera has no recordings.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setFinding(false);
    }
  };
  const playLatest = () => {
    setError(null);
    goTo({ kind: "latest", date: (day.data?.cameraNow ?? today()).slice(0, 10) });
  };
  useEffect(() => {
    if (!pending || !day.data || day.data.date !== date || date !== (pending.kind === "oldest" ? pending.at.slice(0, 10) : pending.date)) return;
    setPending(null);
    const segs = day.data.segments;
    if (pending.kind === "oldest") {
      const seg = segs.find((s) => ms(s.end) > ms(pending.at));
      if (seg) play(text(Math.max(ms(seg.start), ms(pending.at))));
      return;
    }
    const last = segs.at(-1);
    if (!last) setError("No recordings today: pick a day to see older recordings.");
    else play(day.data.playsFromRecordingStart ? last.start : text(Math.max(ms(last.start), ms(last.end) - 60_000)));
  }, [pending, day.data, date]);
  const ends = (
    <>
      <Button size="sm" icon={<SkipBack className="h-4 w-4" />} onClick={() => void playOldest()} loading={finding} title="Play from the oldest recording on the camera">From start</Button>
      <Button size="sm" icon={<SkipForward className="h-4 w-4" />} onClick={playLatest} title="Play the newest recording on the camera">Latest</Button>
    </>
  );
  const shiftDay = (days: number) => {
    setStart(null);
    setDate(text(dayStart + days * DAY).slice(0, 10));
  };
  // The timeline shows the recorded period (first recording to last) unless the whole day is asked for.
  const [wholeDay, setWholeDay] = useState(false);
  const daySegs = day.data?.segments ?? [];
  const fitted = !wholeDay && daySegs.length > 0;
  const viewFrom = fitted ? ms(daySegs[0]!.start) : dayStart;
  const viewTo = fitted ? Math.max(ms(daySegs.at(-1)!.end), viewFrom + 60_000) : dayStart + DAY;
  const span = viewTo - viewFrom;
  const pct = (t: number) => ((t - viewFrom) / span) * 100;
  const ticks = timelineTicks(viewFrom, viewTo);
  // A click on the timeline plays from there, or from the next recording after it.
  const onTimeline = (e: React.MouseEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const at = viewFrom + Math.round(((e.clientX - box.left) / box.width) * span / 1000) * 1000;
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
        <RecordingCalendar cameraId={cameraId} value={date} max={today()} onChange={(d) => (setStart(null), setDate(d))} />
        <Button size="sm" variant="ghost" icon={<ChevronRight className="h-4 w-4" />} onClick={() => shiftDay(1)} disabled={date >= today()} aria-label="Next day" />
        {!start && ends}
        <span className="text-xs text-ink-secondary">
          Times are the camera's clock{day.data ? ` (camera time now ${day.data.cameraNow.replace("T", " ")})` : ""}.
          {day.data?.playsFromRecordingStart && " This camera plays each recording from its beginning."}
        </span>
      </div>

      {/* Timeline: recorded periods in color, the playing position as a line. */}
      <div>
        {daySegs.length > 0 && (
          <div className="mb-1 flex items-center justify-between gap-2 text-xs text-ink-secondary">
            <span className="tabular">
              {fitted ? (
                <>Recorded <strong className="text-ink">{clock(daySegs[0]!.start)}</strong> to <strong className="text-ink">{daySegs.at(-1)!.end.slice(0, 10) > date ? "24:00:00" : clock(daySegs.at(-1)!.end)}</strong></>
              ) : (
                "Whole day"
              )}
            </span>
            <div className="flex rounded-md border border-line p-0.5" role="group" aria-label="Timeline range">
              {[
                { label: "Recorded period", whole: false },
                { label: "Whole day", whole: true },
              ].map((o) => (
                <button
                  key={o.label}
                  type="button"
                  aria-pressed={wholeDay === o.whole}
                  onClick={() => setWholeDay(o.whole)}
                  className={clsx("rounded px-2 py-0.5", wholeDay === o.whole ? "bg-accent text-white" : "hover:bg-raised")}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        )}
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
              style={{ left: `${pct(ms(s.start))}%`, width: `${Math.max(0.2, ((ms(s.end) - ms(s.start)) / span) * 100)}%` }}
              title={`${clock(s.start)} – ${clock(s.end)}`}
            />
          ))}
          {position && ms(position) >= viewFrom && ms(position) <= viewTo && (
            <div className="absolute inset-y-0 w-0.5 bg-bad" style={{ left: `${pct(ms(position))}%` }} aria-hidden />
          )}
        </div>
        <div className="relative mt-1 h-4 text-[11px] text-ink-muted tabular" aria-hidden>
          {ticks.map((t) => {
            const left = pct(t);
            return (
              <span key={t} className="absolute whitespace-nowrap" style={{ left: `${left}%`, transform: `translateX(${left < 3 ? 0 : left > 97 ? -100 : -50}%)` }}>
                {t - dayStart >= DAY ? "24:00" : text(t).slice(11, 16)}
              </span>
            );
          })}
        </div>
      </div>

      {start && (
        <div className="space-y-2">
          <div ref={frame} className="relative mx-auto flex aspect-video max-h-[42vh] items-center justify-center overflow-hidden rounded-md bg-black">
            <LiveVideo key={start} cameraId={cameraId} name={name} playbackStart={start} onFailed={onFailed} onTime={setPlayed} onPrepared={setStartedAt} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="tabular text-sm">
              Playing <strong>{position?.replace("T", " ")}</strong>
              <span className="text-ink-secondary"> · started at {clock(from!)}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {ends}
              {!day.data?.playsFromRecordingStart && (
                <>
                  <Button size="sm" icon={<Rewind className="h-4 w-4" />} onClick={() => jump(-60)}>1 min back</Button>
                  <Button size="sm" icon={<FastForward className="h-4 w-4" />} onClick={() => jump(60)}>1 min ahead</Button>
                </>
              )}
              <Button size="sm" icon={<Maximize2 className="h-4 w-4" />} onClick={() => void frame.current?.requestFullscreen?.()}>Full screen</Button>
              <Button size="sm" icon={<Square className="h-4 w-4" />} onClick={() => setStart(null)}>Stop</Button>
            </div>
          </div>
          {error && <ErrorMessage error={new Error(error)} />}
        </div>
      )}

      {error && !start && <ErrorMessage error={new Error(error)} />}

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
                  <td className="tabular px-3 py-1.5">{clock(s.start)} – {s.end.slice(0, 10) > date ? "24:00:00" : clock(s.end)}</td>
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
