import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronLeft, ChevronRight, Clock, Film, Gauge, Maximize2, Pause, Play, Rewind, FastForward, SkipBack, SkipForward } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { LiveVideo } from "./LiveVideo";
import { RecordingCalendar } from "./RecordingCalendar";
import { MilestoneTimeline, SPANS } from "./MilestoneTimeline";
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
/** Playback speeds: slower is the browser's, faster is asked of the camera. */
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16];
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
  const [speed, setSpeed] = useState(1);
  const [arrival, setArrival] = useState<number | null>(null);
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
  // Slower than normal changes at once; faster (asked of the camera) restarts from where it is.
  const changeSpeed = (v: number) => {
    setArrival(null);
    if (position && Math.max(v, 1) !== Math.max(speed, 1)) play(position);
    setSpeed(v);
  };
  // Playing past midnight (or back before it) moves the timeline to that day; playback goes on.
  const positionDay = position?.slice(0, 10);
  useEffect(() => {
    if (positionDay && positionDay !== date && positionDay <= today()) setDate(positionDay);
  }, [positionDay, date]);
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
  const shiftDay = (days: number) => {
    setStart(null);
    setCursor(null);
    setDate(text(dayStart + days * DAY).slice(0, 10));
  };
  // Milestone-style player: the time under the playhead is where playback is, or (paused) where it
  // will start; the recordings slide under it.
  const daySegs = day.data?.segments ?? [];
  const [cursor, setCursor] = useState<string | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const [span, setSpan] = useState(SPANS[1]!.ms);
  useEffect(() => {
    // A new day starts paused at its first recording.
    if (!start && day.data?.date === date && (!cursor || cursor.slice(0, 10) !== date)) setCursor(day.data.segments[0]?.start ?? `${date}T00:00:00`);
  }, [day.data, date, start, cursor]);
  const head = scrub ?? (position ? ms(position) : cursor ? ms(cursor) : dayStart);
  const segs = daySegs.map((x) => ({ start: ms(x.start), end: ms(x.end), title: `${clock(x.start)} – ${clock(x.end)}` }));
  // Playing from a time in a gap starts at the next recording.
  const seek = (at: number) => {
    const inside = segs.find((x) => x.start <= at && at < x.end);
    const next = segs.find((x) => x.start > at);
    const t = inside ? at : next?.start;
    if (t === undefined) return setError("No recordings after this time on this day.");
    play(text(t));
  };
  const pause = () => {
    if (position) setCursor(position);
    setStart(null);
  };
  const previousRecording = () => {
    const current = [...segs].reverse().find((x) => x.start <= head - 5000);
    if (current) play(text(current.start));
  };
  const nextRecording = () => {
    const next = segs.find((x) => x.start > head + 1000);
    if (next) play(text(next.start));
    else setError("This is the last recording of the day.");
  };
  const playing = Boolean(start);
  const fromStartOnly = day.data?.playsFromRecordingStart;
  const readout = text(head);

  if (video.data && !video.data.enabled) {
    return <ErrorMessage error={new Error("Playing recordings needs the live video service (go2rtc), which is not set up on this server.")} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" icon={<ChevronLeft className="h-4 w-4" />} onClick={() => shiftDay(-1)} aria-label="Previous day" />
        <RecordingCalendar cameraId={cameraId} value={date} max={today()} onChange={(d) => (setStart(null), setCursor(null), setDate(d))} />
        <Button size="sm" variant="ghost" icon={<ChevronRight className="h-4 w-4" />} onClick={() => shiftDay(1)} disabled={date >= today()} aria-label="Next day" />
        <Button size="sm" icon={<SkipBack className="h-4 w-4" />} onClick={() => void playOldest()} loading={finding} title="Play from the oldest recording on the camera">From start</Button>
        <Button size="sm" icon={<SkipForward className="h-4 w-4" />} onClick={playLatest} title="Play the newest recording on the camera">Latest</Button>
        <span className="text-xs text-ink-secondary">
          Times are the camera's clock{day.data ? ` (camera time now ${day.data.cameraNow.replace("T", " ")})` : ""}.
          {fromStartOnly && " This camera plays each recording from its beginning."}
        </span>
      </div>

      {/* The player: video, the time, the timeline and the controls, dark like a recorder's. */}
      <div ref={frame} className="space-y-2 rounded-lg bg-neutral-900 p-2 text-neutral-100 [&:fullscreen]:flex [&:fullscreen]:flex-col [&:fullscreen]:justify-end">
        <div className="relative mx-auto flex aspect-video max-h-[46vh] w-full items-center justify-center overflow-hidden rounded bg-black [:fullscreen_&]:max-h-none [:fullscreen_&]:flex-1">
          {playing ? (
            <LiveVideo
              key={`${start}|${Math.max(speed, 1)}`}
              cameraId={cameraId}
              name={name}
              playbackStart={start!}
              speed={speed}
              onFailed={onFailed}
              onTime={setPlayed}
              onPrepared={setStartedAt}
              onArrival={setArrival}
            />
          ) : (
            <button
              type="button"
              onClick={() => seek(head)}
              disabled={!daySegs.length}
              className="flex flex-col items-center gap-2 text-neutral-300 hover:text-white disabled:opacity-40"
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-current">
                <Play className="ml-1 h-8 w-8" aria-hidden />
              </span>
              <span className="text-sm">{daySegs.length ? `Play from ${clock(readout)}` : day.isLoading ? "Searching the camera's recordings…" : "No recordings on this day"}</span>
            </button>
          )}
        </div>

        <div className="flex items-baseline justify-center gap-3 tabular">
          <span className="text-sm text-neutral-400">{readout.slice(0, 10).split("-").reverse().join("-")}</span>
          <span className="text-2xl font-semibold tracking-wide">{clock(readout)}</span>
          <span className={clsx("rounded px-1.5 py-0.5 text-xs font-medium", playing ? "bg-red-600 text-white" : "bg-neutral-700 text-neutral-300")}>
            {scrub !== null ? "Moving" : playing ? `Playback${speed !== 1 ? ` ${speedLabel(speed)}` : ""}` : "Paused"}
          </span>
        </div>

        <MilestoneTimeline
          time={head}
          span={span}
          min={dayStart}
          max={Math.min(dayStart + DAY, day.data ? ms(day.data.cameraNow) : dayStart + DAY)}
          segments={segs}
          onSeek={seek}
          onScrub={setScrub}
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1" role="group" aria-label="Playback controls">
            <PlayerButton label="Previous recording" onClick={previousRecording} disabled={!segs.length}><SkipBack className="h-4 w-4" /></PlayerButton>
            {!fromStartOnly && <PlayerButton label="1 minute back" onClick={() => seek(head - 60_000)} disabled={!segs.length}><Rewind className="h-4 w-4" /></PlayerButton>}
            <PlayerButton label={playing ? "Pause" : "Play"} onClick={() => (playing ? pause() : seek(head))} disabled={!segs.length} primary>
              {playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
            </PlayerButton>
            {!fromStartOnly && <PlayerButton label="1 minute ahead" onClick={() => seek(head + 60_000)} disabled={!segs.length}><FastForward className="h-4 w-4" /></PlayerButton>}
            <PlayerButton label="Next recording" onClick={nextRecording} disabled={!segs.length}><SkipForward className="h-4 w-4" /></PlayerButton>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs text-neutral-400">
            <label className="flex items-center gap-1.5">
              <Gauge className="h-4 w-4" aria-hidden /> Speed
              <select value={speed} onChange={(e) => changeSpeed(Number(e.target.value))} className="rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-neutral-100">
                {SPEEDS.map((v) => <option key={v} value={v}>{speedLabel(v)}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5">
              <Clock className="h-4 w-4" aria-hidden /> Time span
              <select value={span} onChange={(e) => setSpan(Number(e.target.value))} className="rounded border border-neutral-700 bg-neutral-800 px-1.5 py-1 text-neutral-100">
                {SPANS.map((o) => <option key={o.ms} value={o.ms}>{o.label}</option>)}
              </select>
            </label>
            <PlayerButton label="Full screen" onClick={() => void frame.current?.requestFullscreen?.()}><Maximize2 className="h-4 w-4" /></PlayerButton>
          </div>
        </div>
        {speed > 1 && arrival !== null && arrival < speed * 0.6 && played > 8 && (
          <p className="text-xs text-amber-300">
            The camera is sending the recording at about {arrival < 1.3 ? "normal speed" : `${Math.round(arrival * 10) / 10}×`}: it may not support {speed}× playback.
          </p>
        )}
      </div>

      {error && <ErrorMessage error={new Error(error)} />}

      {day.isLoading ? (
        <Spinner label="Searching the camera's recordings" />
      ) : day.error ? (
        <ErrorMessage error={day.error} />
      ) : !daySegs.length ? (
        <EmptyState icon={<Film className="h-6 w-6" />} title="No recordings on this day" description="The camera's storage holds nothing recorded on this date." />
      ) : (
        <details className="rounded-md border border-line">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Recordings on this day ({daySegs.length})</summary>
          <div className="max-h-56 overflow-y-auto border-t border-line">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-surface text-xs text-ink-secondary">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Recorded</th>
                  <th scope="col" className="px-3 py-2 font-medium">Length</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium"><span className="sr-only">Play</span></th>
                </tr>
              </thead>
              <tbody>
                {daySegs.map((x) => (
                  <tr key={x.start} className={clsx("border-t border-line", head >= ms(x.start) && head < ms(x.end) && "bg-accent-soft/40")}>
                    <td className="tabular px-3 py-1.5">{clock(x.start)} – {x.end.slice(0, 10) > date ? "24:00:00" : clock(x.end)}</td>
                    <td className="px-3 py-1.5 text-ink-secondary">{duration(x.start, x.end)}</td>
                    <td className="px-3 py-1.5 text-right">
                      <Button size="sm" icon={<Play className="h-4 w-4" />} onClick={() => play(x.start)}>Play</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

const speedLabel = (v: number) => (v === 0.25 ? "¼×" : v === 0.5 ? "½×" : `${v}×`);

/** A round control on the dark player bar. */
function PlayerButton({ label, onClick, disabled, primary, children }: { label: string; onClick: () => void; disabled?: boolean; primary?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "flex items-center justify-center rounded-full transition-colors disabled:opacity-40",
        primary ? "h-10 w-10 bg-neutral-100 text-neutral-900 hover:bg-white" : "h-8 w-8 text-neutral-200 hover:bg-neutral-700",
      )}
    >
      {children}
    </button>
  );
}
