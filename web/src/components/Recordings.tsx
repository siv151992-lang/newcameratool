import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Camera, ChevronLeft, Download, Layers, ChevronRight, Clock, Film, Gauge, Maximize2, Pause, Play, Rewind, FastForward, Search, SkipBack, SkipForward, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { localTimeText, pictureFileName, savePicture } from "../lib/savePicture";
import { LiveVideo, PLAYBACK_BUFFERS, type PlaybackBuffer, type StartTimings } from "./LiveVideo";
import { RecordingCalendar } from "./RecordingCalendar";
import { MilestoneTimeline, SPANS, zoomSpan } from "./MilestoneTimeline";
import { Button, Dialog, EmptyState, ErrorMessage, Field, Input, Select, Spinner } from "./ui";

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
interface CameraTimings {
  connect?: number; describe?: number; setup?: number; play?: number; firstVideo?: number; total?: number;
  /** After the first video, the first full picture (key frame); and how often the camera sends one. */
  firstPicture?: number; pictureInterval?: number;
}
const sec = (ms: number) => `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)} s`;

/**
 * "Started in 2.5 s: server 0.05 s · camera 1.9 s (connect 0.01 s, describe 0.20 s, setup 0.10 s,
 * play 1.2 s, first video 0.40 s) · picture 0.3 s after the video arrived".
 */
export function describeStart(t: StartTimings, cam: CameraTimings | null): string {
  const parts = [`server ${sec(t.prepared)}`];
  if (cam?.total !== undefined) {
    const steps = ([["connect", cam.connect], ["describe", cam.describe], ["setup", cam.setup], ["play", cam.play], ["first video", cam.firstVideo]] as const)
      .filter(([, v]) => v !== undefined).map(([k, v]) => `${k} ${sec(v!)}`);
    parts.push(`camera ${sec(cam.total)}${steps.length ? ` (${steps.join(", ")})` : ""}`);
  }
  const picture = Math.max(0, t.playing - t.firstVideo);
  parts.push(`picture ${sec(picture)} after the video arrived`);
  // A picture can only start at a full frame (I-frame); cameras send recordings at real-time pace, so
  // a long wait here is the camera's I-frame interval (the relay measures it).
  const frames = [
    cam?.firstPicture !== undefined ? `the camera's first full picture (I-frame) came ${sec(cam.firstPicture)} after its video began` : "",
    cam?.pictureInterval !== undefined ? `it sends one every ${sec(cam.pictureInterval)}` : "",
  ].filter(Boolean).join(", and ");
  // Advice only when the start really waited: a camera that starts on a full picture starts quickly
  // whatever its interval.
  const slow = picture > 1500;
  const hint = slow
    ? `. ${frames ? `${frames[0]!.toUpperCase()}${frames.slice(1)}: ` : "Most of this is waiting for the camera's next full picture (I-frame): "}set the camera's I-frame interval to its frame rate (one per second) and turn off H.264+ / Smart Codec to start faster`
    : frames ? `. ${frames[0]!.toUpperCase()}${frames.slice(1)}` : "";
  return `Started in ${sec(t.playing)}: ${parts.join(" · ")}${hint}`;
}

const CLIP_LENGTHS = [
  { seconds: 30, label: "30 seconds" }, { seconds: 60, label: "1 minute" }, { seconds: 120, label: "2 minutes" },
  { seconds: 300, label: "5 minutes" }, { seconds: 600, label: "10 minutes" }, { seconds: 900, label: "15 minutes" }, { seconds: 1800, label: "30 minutes" },
];

/**
 * Download a clip of the recording as an MP4 file (evidence). The camera sends recordings at normal
 * speed, so the download takes about as long as the clip; the browser shows it as it comes in.
 */
function ClipDialog({ cameraId, channel, from, onClose }: { cameraId: string; channel?: number; from: string | null; onClose: () => void }) {
  const [start, setStart] = useState("");
  const [seconds, setSeconds] = useState(120);
  useEffect(() => {
    if (from) setStart(from.slice(0, 19));
  }, [from]);
  const valid = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(start);
  const download = () => {
    const at = start.length === 16 ? `${start}:00` : start;
    const a = document.createElement("a");
    a.href = `/api/cameras/${cameraId}/recordings/clip?start=${encodeURIComponent(at)}&seconds=${seconds}${channel ? `&channel=${channel}` : ""}`;
    a.download = "";
    document.body.append(a);
    a.click();
    a.remove();
    onClose();
  };
  const length = CLIP_LENGTHS.find((l) => l.seconds === seconds)?.label ?? `${seconds} s`;
  return (
    <Dialog
      open={!!from}
      onClose={onClose}
      title="Download a clip"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" icon={<Download className="h-4 w-4" />} disabled={!valid} onClick={download}>Download MP4</Button></>}
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="From (camera time)">
            {(id) => <Input id={id} type="datetime-local" step={1} value={start} onChange={(e) => setStart(e.target.value)} />}
          </Field>
          <Field label="Length">
            {(id) => (
              <Select id={id} value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
                {CLIP_LENGTHS.map((l) => <option key={l.seconds} value={l.seconds}>{l.label}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <p className="text-sm text-ink-secondary">
          The camera sends its recordings at normal speed, so this download takes about {length}; it appears in the browser&apos;s downloads as it
          comes in. The file plays in VLC, Windows Media Player and browsers. The clip starts at the camera&apos;s first full picture from that time,
          and the download is recorded in the audit log.
        </p>
      </div>
    </Dialog>
  );
}

const BUFFER_KEY = "cctv-playback-buffer";
function savedBuffer(): PlaybackBuffer {
  try {
    const v = localStorage.getItem(BUFFER_KEY);
    if (v && v in PLAYBACK_BUFFERS) return v as PlaybackBuffer;
  } catch {
    // Storage blocked: the default.
  }
  return "normal";
}

export function RecordingsDialog({ camera, onClose }: { camera: { id: string; name: string; channel?: number } | null; onClose: () => void }) {
  return (
    <Dialog open={!!camera} onClose={onClose} title={camera ? `Recordings: ${camera.name}` : "Recordings"} size="full">
      {camera && <RecordingsBody key={`${camera.id}:${camera.channel ?? ""}`} cameraId={camera.id} name={camera.name} channel={camera.channel} />}
    </Dialog>
  );
}

function RecordingsBody({ cameraId, name, channel }: { cameraId: string; name: string; channel?: number }) {
  const ch = channel ? `&channel=${channel}` : "";
  const [date, setDate] = useState(today);
  const [start, setStart] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);
  const [bufferLevel, setBufferLevel] = useState<PlaybackBuffer>(savedBuffer);
  const [inHand, setInHand] = useState<number | null>(null);
  /** The clip being chosen for download (its start, camera time), or null. */
  const [clipFrom, setClipFrom] = useState<string | null>(null);
  /** Where the last start's time went: the browser's steps and the camera's (seen by the server's relay). */
  const [startInfo, setStartInfo] = useState<string | null>(null);
  /** Which start the line is about: a later start's line is not overwritten by an earlier one. */
  const startId = useRef(0);
  const started = useCallback((t: StartTimings) => {
    const id = ++startId.current;
    const read = () => api<{ timings: CameraTimings | null }>(`/cameras/${cameraId}/playback/problem`)
      .then((p) => p.timings, () => null)
      .then((c) => id === startId.current && setStartInfo(describeStart(t, c)));
    void read();
    // How often the camera sends a full picture is known once two have come: ask again a little later.
    window.setTimeout(() => void read(), 8000);
  }, [cameraId]);
  const chooseBuffer = (v: PlaybackBuffer) => {
    setBufferLevel(v);
    try {
      localStorage.setItem(BUFFER_KEY, v);
    } catch {
      // Not remembered (private window): applies to this viewing only.
    }
  };
  const [arrival, setArrival] = useState<number | null>(null);
  const [played, setPlayed] = useState(0);
  const [startedAt, setStartedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const video = useQuery({ queryKey: ["live-video"], queryFn: () => api<{ enabled: boolean }>("/cameras/live-video"), staleTime: 5 * 60_000 });
  const fetchDay = (d: string) => api<Day>(`/cameras/${cameraId}/recordings?date=${d}${ch}`);
  const day = useQuery({ queryKey: ["recordings", cameraId, channel, date], queryFn: () => fetchDay(date) });
  // The days either side too (once this one is in), so the timeline runs on across midnight.
  const prevDate = text(ms(`${date}T00:00:00`) - DAY).slice(0, 10);
  const nextDate = text(ms(`${date}T00:00:00`) + DAY).slice(0, 10);
  const prevDay = useQuery({ queryKey: ["recordings", cameraId, channel, prevDate], queryFn: () => fetchDay(prevDate), enabled: !!day.data, staleTime: 60_000 });
  const nextDay = useQuery({ queryKey: ["recordings", cameraId, channel, nextDate], queryFn: () => fetchDay(nextDate), enabled: !!day.data && nextDate <= today(), staleTime: 60_000 });
  // A stream that drops while playing (the camera closed it, the network blinked, or the stretch of
  // recording it was asked for ended) goes on by itself from where it was, at the next recording if
  // that one ended; only a stream that will not play is reported.
  // A resume that fails at once (the video service restarting, say) is tried again a little later.
  const resume = useRef({ position: null as string | null, played: 0, seek: (_at: number) => undefined as void, tries: 0, resuming: false, timer: 0, active: false });
  const onFailed = useCallback((m: string) => {
    const r = resume.current;
    if (r.position && (r.played > 2 || r.resuming) && r.tries < 4) {
      const at = ms(r.position) + (r.resuming ? 0 : 1000);
      r.tries += 1;
      r.resuming = true;
      window.clearTimeout(r.timer);
      // Not if playback was stopped meanwhile (paused, another day chosen).
      r.timer = window.setTimeout(() => r.active && r.seek(at), [0, 1500, 3000, 6000][r.tries - 1]);
      return;
    }
    r.resuming = false;
    setError(m);
  }, []);
  const onTime = useCallback((t: number) => {
    setPlayed(t);
    if (t > 2) resume.current.resuming = false;
    if (t > 20) resume.current.tries = 0;
  }, []);
  useEffect(() => () => window.clearTimeout(resume.current.timer), []);

  const dayStart = ms(`${date}T00:00:00`);
  /** Counts play requests, so playing the same time again (a retry) still restarts the stream. */
  const [attempt, setAttempt] = useState(0);
  const play = (t: string) => {
    window.clearTimeout(resume.current.timer);
    setAttempt((a) => a + 1);
    setError(null);
    setPlayed(0);
    setStartedAt(null);
    setStartInfo(null);
    startId.current += 1;
    setStart(t);
  };
  // Only while playing: once stopped (another day chosen, paused), the old position must not pull the timeline back.
  const from = start ? (startedAt ?? start) : null;
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
      const { oldest } = await api<{ oldest: string | null }>(`/cameras/${cameraId}/recordings/oldest${channel ? `?channel=${channel}` : ""}`);
      if (oldest) goTo({ kind: "oldest", at: oldest });
      else setError("The camera has no recordings.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setFinding(false);
    }
  };
  // Go to: a date and time typed in plays from there (or the next recording after it).
  const [search, setSearch] = useState("");
  const goToTime = (value: string) => {
    setError(null);
    // datetime-local leaves seconds out when they are 0.
    const t = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(t)) return setError("Enter a date and time.");
    if (day.data && t > day.data.cameraNow) return setError("That time is still to come on the camera's clock.");
    setCursor(t);
    goTo({ kind: "oldest", at: t });
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
      else setError("No recordings after this time.");
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
  const [span, setSpan] = useState(3_600_000); // 1 hour
  useEffect(() => {
    // A new day starts paused at its first recording.
    if (!start && day.data?.date === date && (!cursor || cursor.slice(0, 10) !== date)) setCursor(day.data.segments[0]?.start ?? `${date}T00:00:00`);
  }, [day.data, date, start, cursor]);
  const head = scrub ?? (position ? ms(position) : cursor ? ms(cursor) : dayStart);
  // The timeline's recordings: this day and the days either side.
  const segs = [...(prevDay.data?.segments ?? []), ...daySegs, ...(nextDay.data?.segments ?? [])]
    .map((x) => ({ start: ms(x.start), end: ms(x.end), title: `${x.start.slice(5, 10).split("-").reverse().join("-")} ${clock(x.start)} – ${clock(x.end)}` }))
    .sort((a, b) => a.start - b.start);
  const timelineMin = prevDay.data ? dayStart - DAY : dayStart;
  const latest = day.data ? ms(nextDay.data?.cameraNow ?? day.data.cameraNow) : dayStart + DAY;
  const timelineMax = Math.min(dayStart + (nextDay.data ? 2 : 1) * DAY, latest);
  /** Moves the playing video to a time it has already loaded (set by the player). */
  const seekWithin = useRef<((seconds: number) => boolean) | null>(null);
  // Playing from a time in a gap starts at the next recording.
  const seek = (at: number) => {
    // Already loaded (a little back, or ahead in the reserve): straight there, no new connection.
    if (from && speed <= 1 && seekWithin.current?.((at - ms(from)) / 1000)) {
      setError(null);
      return;
    }
    const inside = segs.find((x) => x.start <= at && at < x.end);
    const next = segs.find((x) => x.start > at);
    const t = inside ? at : next?.start;
    if (t !== undefined) return play(text(t));
    // Nothing more in the days loaded: go on with the first recording of the day after them.
    const after = text(dayStart + (nextDay.data ? 2 : 1) * DAY).slice(0, 10);
    if (after <= today()) return goTo({ kind: "oldest", at: `${after}T00:00:00` });
    setError("No recordings after this time.");
  };
  const pause = () => {
    window.clearTimeout(resume.current.timer);
    resume.current.resuming = false;
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
    else setError("No later recordings.");
  };
  resume.current.position = position;
  resume.current.played = played;
  resume.current.seek = seek;
  resume.current.active = Boolean(start);
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
        <RecordingCalendar cameraId={cameraId} channel={channel} value={date} max={today()} onChange={(d) => (setStart(null), setCursor(null), setDate(d))} />
        <Button size="sm" variant="ghost" icon={<ChevronRight className="h-4 w-4" />} onClick={() => shiftDay(1)} disabled={date >= today()} aria-label="Next day" />
        <Button size="sm" icon={<SkipBack className="h-4 w-4" />} onClick={() => void playOldest()} loading={finding} title="Play from the oldest recording on the camera">From start</Button>
        <Button size="sm" icon={<SkipForward className="h-4 w-4" />} onClick={playLatest} title="Play the newest recording on the camera">Latest</Button>
        <form
          className="flex items-center gap-1.5"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            goToTime(search);
          }}
        >
          <label htmlFor="recordings-go-to" className="text-xs text-ink-secondary">Go to</label>
          <input
            id="recordings-go-to"
            type="datetime-local"
            step={1}
            value={search}
            max={(day.data?.cameraNow ?? "").slice(0, 19) || undefined}
            onFocus={() => !search && setSearch(readout)}
            onChange={(e) => setSearch(e.target.value)}
            className="tabular rounded-md border border-line bg-surface px-2 py-1 text-sm"
            aria-label="Date and time to play from"
          />
          <Button size="sm" type="submit" icon={<Search className="h-4 w-4" />} disabled={!search}>Go</Button>
        </form>
        <span className="text-xs text-ink-secondary">
          Times are the camera's clock{day.data ? ` (camera time now ${day.data.cameraNow.replace("T", " ")})` : ""}.
          {fromStartOnly && " This camera plays each recording from its beginning."}
        </span>
      </div>

      {/* The player: video, the time, the timeline and the controls, dark like a recorder's. */}
      <div ref={frame} className="space-y-2 rounded-lg bg-neutral-900 p-2 text-neutral-100 [&:fullscreen]:flex [&:fullscreen]:flex-col [&:fullscreen]:justify-end">
        <div className="relative mx-auto flex aspect-video max-h-[calc(96vh-20.5rem)] w-full items-center justify-center overflow-hidden rounded bg-black [:fullscreen_&]:max-h-none [:fullscreen_&]:flex-1">
          {playing ? (
            <LiveVideo
              key={`${start}|${Math.max(speed, 1)}|${attempt}`}
              cameraId={cameraId}
              channel={channel}
              name={name}
              playbackStart={start!}
              speed={speed}
              onFailed={onFailed}
              onTime={onTime}
              onPrepared={setStartedAt}
              onArrival={setArrival}
              buffer={bufferLevel}
              onBuffer={setInHand}
              onStarted={started}
              seekWithin={seekWithin}
            />
          ) : (
            <button
              type="button"
              onClick={() => seek(head)}
              disabled={!segs.length}
              className="flex flex-col items-center gap-2 text-neutral-300 hover:text-white disabled:opacity-40"
            >
              <span className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-current">
                <Play className="ml-1 h-8 w-8" aria-hidden />
              </span>
              <span className="text-sm">{daySegs.length ? `Play from ${clock(readout)}` : day.isLoading ? "Searching the camera's recordings…" : "No recordings on this day"}</span>
            </button>
          )}
        </div>

        <MilestoneTimeline
          time={head}
          span={span}
          min={timelineMin}
          max={timelineMax}
          segments={segs}
          onSeek={seek}
          onScrub={setScrub}
          onZoom={(d) => setSpan((v) => zoomSpan(v, d))}
        />

        {/* Controls, the time in the middle (on its own line only when the window is narrow), the settings. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-1" role="group" aria-label="Playback controls">
            <PlayerButton label="Previous recording" onClick={previousRecording} disabled={!segs.length}><SkipBack className="h-4 w-4" /></PlayerButton>
            {!fromStartOnly && <PlayerButton label="1 minute back" onClick={() => seek(head - 60_000)} disabled={!segs.length}><Rewind className="h-4 w-4" /></PlayerButton>}
            <PlayerButton label={playing ? "Pause" : "Play"} onClick={() => (playing ? pause() : seek(head))} disabled={!segs.length} primary>
              {playing ? <Pause className="h-5 w-5" /> : <Play className="ml-0.5 h-5 w-5" />}
            </PlayerButton>
            {!fromStartOnly && <PlayerButton label="1 minute ahead" onClick={() => seek(head + 60_000)} disabled={!segs.length}><FastForward className="h-4 w-4" /></PlayerButton>}
            <PlayerButton label="Next recording" onClick={nextRecording} disabled={!segs.length}><SkipForward className="h-4 w-4" /></PlayerButton>
          </div>
          <div className="order-first flex w-full items-baseline justify-center gap-3 tabular lg:order-none lg:w-auto">
            <span className="text-sm text-neutral-400">{readout.slice(0, 10).split("-").reverse().join("-")}</span>
            <span className="text-2xl font-semibold tracking-wide">{clock(readout)}</span>
            <span className={clsx("rounded px-1.5 py-0.5 text-xs font-medium", playing ? "bg-red-600 text-white" : "bg-neutral-700 text-neutral-300")}>
              {scrub !== null ? "Moving" : playing ? `Playback${speed !== 1 ? ` ${speedLabel(speed)}` : ""}` : "Paused"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
            {/* Speed */}
            <label className="flex h-8 items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-800/60 pl-2.5 pr-1" title="Playback speed">
              <Gauge className="h-4 w-4" aria-hidden />
              <span className="sr-only">Speed</span>
              <select value={speed} onChange={(e) => changeSpeed(Number(e.target.value))} className="rounded-full bg-transparent px-1 py-0.5 text-neutral-100 focus:outline-none">
                {SPEEDS.map((v) => <option key={v} value={v} className="bg-neutral-800">{speedLabel(v)}</option>)}
              </select>
            </label>
            {/* Buffer: how much video is kept in hand, and how much is now */}
            <label className="flex h-8 items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-800/60 pl-2.5 pr-1" title="Buffer: video kept in hand so playback does not freeze on a slow or uneven network. Larger is smoother on slow networks; it builds up while playing (a little slower than real time until full).">
              <Layers className="h-4 w-4" aria-hidden />
              <span className="sr-only">Buffer</span>
              <select value={bufferLevel} onChange={(e) => chooseBuffer(e.target.value as PlaybackBuffer)} className="rounded-full bg-transparent px-1 py-0.5 text-neutral-100 focus:outline-none">
                {(Object.keys(PLAYBACK_BUFFERS) as PlaybackBuffer[]).map((k) => <option key={k} value={k} className="bg-neutral-800">{PLAYBACK_BUFFERS[k].label}</option>)}
              </select>
              {start && inHand !== null && <span className="min-w-[2.5rem] pr-1.5 tabular text-neutral-300" aria-label={`${inHand.toFixed(1)} seconds of video in hand`}>{inHand.toFixed(1)} s</span>}
            </label>
            {/* Timeline zoom: − / span / + (also Ctrl + wheel and the + / - keys on the timeline) */}
            <div className="flex h-8 items-center rounded-full border border-neutral-700 bg-neutral-800/60" role="group" aria-label="Timeline zoom">
              <PlayerButton label="Zoom out (show more time)" onClick={() => setSpan((v) => zoomSpan(v, 1))} disabled={span >= SPANS.at(-1)!.ms}>
                <ZoomOut className="h-4 w-4" />
              </PlayerButton>
              <span className="flex min-w-[4.75rem] items-center justify-center gap-1 tabular text-neutral-200" aria-live="polite">
                <Clock className="h-3.5 w-3.5 text-neutral-400" aria-hidden />
                {SPANS.find((o) => o.ms === span)?.label ?? ""}
              </span>
              <PlayerButton label="Zoom in (show less time)" onClick={() => setSpan((v) => zoomSpan(v, -1))} disabled={span <= SPANS[0]!.ms}>
                <ZoomIn className="h-4 w-4" />
              </PlayerButton>
            </div>
            <PlayerButton label="Save picture (camera time in the file name)" onClick={() => {
                const at = position ?? localTimeText();
                void savePicture(frame.current, pictureFileName(name, at), {
                  camera: name, time: at, label: "Playback",
                  timeline: { time: head, span, min: timelineMin, max: timelineMax, segments: segs },
                });
              }} disabled={!position}>
              <Camera className="h-4 w-4" />
            </PlayerButton>
            <PlayerButton label="Download a clip (MP4)" onClick={() => setClipFrom(text(head))} disabled={!segs.length}>
              <Download className="h-4 w-4" />
            </PlayerButton>
            <PlayerButton label="Full screen" onClick={() => void frame.current?.requestFullscreen?.()}><Maximize2 className="h-4 w-4" /></PlayerButton>
          </div>
        </div>
        <ClipDialog cameraId={cameraId} channel={channel} from={clipFrom} onClose={() => setClipFrom(null)} />
        {start && startInfo && <p className="text-xs text-neutral-400 tabular" title="Where the time to start went, to find what is slow">{startInfo}</p>}
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
