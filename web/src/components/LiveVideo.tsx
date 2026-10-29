import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { Spinner } from "./ui";
import { ZoomPan } from "./ZoomPan";

/** Codecs go2rtc may send; the browser says which it can play (H.265 only where supported). */
/**
 * Video formats offered to go2rtc. No audio: the player is always muted, and an audio track (which
 * go2rtc converts from the camera's G.711 to FLAC) holds the picture back until audio for the same
 * moment arrives, which in recordings is often late; it also costs go2rtc the conversion.
 */
const CODECS = ["avc1.640029", "avc1.64002A", "avc1.640033", "hvc1.1.6.L153.B0"];

/**
 * Smooth video over a WebSocket (go2rtc's MSE stream, relayed by the server) into a <video>.
 * Stays near the live edge and drops old video so memory does not grow.
 */
/**
 * Recordings keep a reserve of video in hand (the buffer), so a network hiccup or a camera that
 * sends unevenly does not freeze the picture:
 * - start: seconds in hand before playing starts (kept short, so playback starts quickly);
 * - target: the reserve built up while playing, by playing a little slower (unnoticeably) while
 *   below it: 0.9x under half the target, 0.96x under the target;
 * - refill: seconds in hand before playing on after running dry.
 */
export const PLAYBACK_BUFFERS = {
  small: { label: "Small 2 s", start: 0.5, target: 2, refill: 1 },
  normal: { label: "Normal 5 s", start: 0.5, target: 5, refill: 2.5 },
  large: { label: "Large 10 s", start: 3, target: 10, refill: 5 },
} as const;
export type PlaybackBuffer = keyof typeof PLAYBACK_BUFFERS;
/** Milliseconds from pressing play: the server prepared it, the video connection opened, video arrived, the picture played. */
export interface StartTimings { prepared: number; opened: number; firstVideo: number; playing: number }
/** Never wait longer than this for the start reserve (a slow camera still plays). */
const START_WAIT_MS = 6000;

export function LiveVideo({
  cameraId,
  name,
  onFailed,
  playbackStart,
  onTime,
  onPrepared,
  speed = 1,
  onArrival,
  channel,
  buffer: bufferLevel = "normal",
  onBuffer,
  onStarted,
}: {
  cameraId: string;
  name: string;
  onFailed: (message: string) => void;
  /** Play the camera's recordings from this camera time (YYYY-MM-DDTHH:MM:SS) instead of live. */
  playbackStart?: string;
  /** Seconds played so far. */
  onTime?: (seconds: number) => void;
  /** The time playback really starts at (cameras that play a recording from its start). */
  onPrepared?: (start: string) => void;
  /**
   * Playback speed. Slower than normal is done here; faster is asked of the camera when the stream
   * is opened, and played at the pace the camera really sends.
   */
  speed?: number;
  /** How fast (× normal) the camera is sending the recording, measured while playing faster. */
  onArrival?: (rate: number) => void;
  /** An NVR channel to play instead of the device's own video. */
  channel?: number;
  /** Recordings: how much video to keep in hand. */
  buffer?: PlaybackBuffer;
  /** Recordings: seconds of video in hand, about once a second. */
  onBuffer?: (seconds: number) => void;
  /** Recordings: how long the start took in the browser (ms): prepare, video connection open, first video, picture. */
  onStarted?: (t: StartTimings) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  // Read at call time, so a new callback does not restart the stream.
  const prepared = useRef(onPrepared);
  prepared.current = onPrepared;
  const rate = useRef({ speed, onArrival, reserve: PLAYBACK_BUFFERS[bufferLevel], onBuffer, onStarted });
  rate.current = { speed, onArrival, reserve: PLAYBACK_BUFFERS[bufferLevel], onBuffer, onStarted };
  const fast = speed > 1 ? speed : 1;
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const el = video.current;
    if (!el) return;
    // iPhone and iPad Safari have ManagedMediaSource instead of MediaSource.
    const Source: typeof MediaSource | undefined =
      (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ?? (typeof MediaSource === "undefined" ? undefined : MediaSource);
    if (!Source) {
      onFailed("This browser cannot play live video. Showing pictures instead.");
      return;
    }
    if (Source !== window.MediaSource) el.disableRemotePlayback = true; // ManagedMediaSource needs it
    let stopped = false;
    let ws: WebSocket | null = null;
    let buffer: SourceBuffer | null = null;
    let queue: ArrayBuffer[] = [];
    let gotVideo = false;
    /** Video arrived at least once in this viewing (any connection). */
    let everPlayed = false;
    /** When video last arrived, and when this connection opened (for the stall and first-video checks). */
    let lastData = 0;
    let openedAt = 0;
    /** Live reconnects in a row without steady video in between. */
    let reconnects = 0;
    let retryTimer: number | undefined;

    /**
     * Recordings start (and start again after running dry) only with some video in hand: cameras send
     * them at real-time pace, so playing each frame as it arrives freezes at every network hiccup.
     */
    let cushioned = false;
    let firstDataAt = 0;
    const cushion = (ranges: TimeRanges) => {
      if (!playbackStart || ranges.length === 0) return;
      const start = ranges.start(0);
      if (el.currentTime < start) el.currentTime = start;
      const ahead = ranges.end(ranges.length - 1) - el.currentTime;
      firstDataAt ||= performance.now();
      const { reserve } = rate.current;
      if (el.paused && (ahead >= (cushioned ? reserve.refill : reserve.start) || performance.now() - firstDataAt > Math.max(START_WAIT_MS, reserve.refill * 1500))) {
        cushioned = true;
        void el.play().catch(() => undefined);
      }
    };
    const onWaiting = () => {
      // Ran out of video: wait for a little in hand rather than stutter frame by frame. Only when
      // really out of video: the browser also says "waiting" while it moves to the start of the
      // video at the beginning, which must not hold playback back for a refill.
      const ranges = buffer?.buffered;
      const ahead = ranges && ranges.length > 0 ? ranges.end(ranges.length - 1) - el.currentTime : 0;
      if (playbackStart && cushioned && !stopped && !el.seeking && ahead < 0.3) {
        el.pause();
        firstDataAt = performance.now();
      }
    };
    el.addEventListener("waiting", onWaiting);

    const flush = () => {
      if (!buffer || buffer.updating) return;
      const ranges = buffer.buffered;
      cushion(ranges);
      if (ranges.length > 0) {
        const end = ranges.end(ranges.length - 1);
        if (!playbackStart && end - el.currentTime > 3) el.currentTime = end - 0.5; // fell behind: jump to live
        // Drop what has been played (recordings may be played slowly, so not what is still ahead).
        const keepFrom = playbackStart ? el.currentTime - 10 : end - 15;
        if (keepFrom - ranges.start(0) > 15) return buffer.remove(ranges.start(0), keepFrom);
      }
      const next = queue.shift();
      if (!next) return;
      try {
        buffer.appendBuffer(next);
      } catch (e) {
        // The browser's video memory is full: drop what has been played and try again.
        if ((e as DOMException).name === "QuotaExceededError" && ranges.length > 0 && el.currentTime - 1 > ranges.start(0)) {
          queue.unshift(next);
          buffer.remove(ranges.start(0), el.currentTime - 1);
        }
      }
    };
    const fail = (message: string) => {
      if (stopped) return;
      stopped = true;
      ws?.close();
      setError(message);
      onFailed(message);
    };
    /**
     * The connection ended or went quiet. Live video reconnects by itself (a camera restart or a
     * network blink); a recording is resumed by the player around it, from where it was.
     */
    const dropped = (message: string) => {
      if (stopped) return;
      const ranForAnHour = openedAt > 0 && performance.now() - openedAt > 55 * 60_000;
      if (!playbackStart && everPlayed && reconnects < 5 && !ranForAnHour) {
        reconnects += 1;
        const old = ws;
        ws = null;
        old?.close();
        setPlaying(false);
        retryTimer = window.setTimeout(() => void connect(), Math.min(1000 * 2 ** (reconnects - 1), 8000));
        return;
      }
      fail(ranForAnHour ? "Live video stops after an hour. Open it again to go on watching." : message);
    };

    /**
     * A recording that did not open. A camera with all its connections in use (453: often the
     * playback just replaced by a seek, which it frees a moment later) is asked again by itself,
     * a few times, before saying so.
     */
    let busyRetries = 0;
    const playbackFailed = (problem: string | null, otherwise: string) => {
      if (stopped) return;
      if (problem && /\b453\b|connections are in use/.test(problem) && busyRetries < 3) {
        busyRetries += 1;
        const old = ws;
        ws = null;
        old?.close();
        retryTimer = window.setTimeout(() => void connect(), 2500 * busyRetries);
        return;
      }
      fail(problem ? `The recording could not be played. ${problem}` : otherwise);
    };

    /** Live video that did not open: says so at once, then why (tested from the server and from go2rtc). */
    const liveFailed = (message: string) => {
      if (stopped) return;
      fail(`${message} Checking why…`);
      void api<{ problem: string }>(`/cameras/${cameraId}/live/problem${channel ? `?channel=${channel}` : ""}`)
        .then((p) => setError(`The camera's video could not be opened. ${p.problem}`), () => setError(message));
    };

    const playbackProblem = () =>
      api<{ problem: string | null }>(`/cameras/${cameraId}/playback/problem`).then((p) => p.problem, () => null);

    // When each step of the (first) start happened, from pressing play.
    const began = performance.now();
    const steps = { prepared: 0, opened: 0, firstVideo: 0, playing: 0 };
    const onPlayingOnce = () => {
      if (!playbackStart || steps.playing || !steps.firstVideo) return;
      steps.playing = performance.now() - began;
      rate.current.onStarted?.({ ...steps });
    };
    el.addEventListener("playing", onPlayingOnce);

    const connect = async () => {
      if (stopped) return;
      buffer = null;
      queue = [];
      gotVideo = false;
      try {
        if (playbackStart) {
          const r = await api<{ start?: string }>(`/cameras/${cameraId}/playback/prepare`, { method: "POST", body: { start: playbackStart, ...(fast > 1 ? { speed: fast } : {}), ...(channel ? { channel } : {}) } });
          if (r.start) prepared.current?.(r.start);
          steps.prepared ||= performance.now() - began;
        }
        else await api(`/cameras/${cameraId}/live/prepare${channel ? `?channel=${channel}` : ""}`, { method: "POST" });
      } catch (e) {
        // While reconnecting (the video service restarting, say), try again a little later.
        return everPlayed ? dropped((e as Error).message) : fail((e as Error).message);
      }
      if (stopped) return;
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      const socket = new WebSocket(`${scheme}://${window.location.host}/api/cameras/${cameraId}/${playbackStart ? "playback" : "live"}/ws${!playbackStart && channel ? `?channel=${channel}` : ""}`);
      ws = socket;
      openedAt = openedAt || performance.now();
      lastData = performance.now();
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        steps.opened ||= performance.now() - began;
        socket.send(JSON.stringify({ type: "mse", value: CODECS.filter((c) => Source.isTypeSupported(`video/mp4; codecs="${c}"`)).join() }));
      };
      socket.onmessage = (ev) => {
        if (ws !== socket) return;
        if (typeof ev.data !== "string") {
          gotVideo = true;
          steps.firstVideo ||= performance.now() - began;
          everPlayed = true;
          lastData = performance.now();
          queue.push(ev.data as ArrayBuffer);
          return flush();
        }
        const msg = JSON.parse(ev.data) as { type: string; value: string };
        if (msg.type === "error") {
          if (gotVideo) return dropped(`The video stopped: ${msg.value}`);
          if (!playbackStart) return liveFailed(`The camera stream could not be opened: ${msg.value}.`);
          // go2rtc only says "wrong response on SETUP": add what the camera actually answered.
          void playbackProblem().then((p) => playbackFailed(p, `The camera stream could not be opened: ${msg.value}.`));
          return;
        }
        if (msg.type !== "mse") return;
        const source = new Source();
        el.src = URL.createObjectURL(source);
        source.addEventListener("sourceopen", () => {
          URL.revokeObjectURL(el.src);
          try {
            buffer = source.addSourceBuffer(msg.value);
          } catch {
            return fail("This browser cannot play the camera's video format (often H.265). Set the camera's second stream to H.264, or use pictures.");
          }
          buffer.mode = "segments";
          buffer.addEventListener("updateend", flush);
          flush();
        }, { once: true });
      };
      socket.onclose = () => {
        if (ws !== socket) return;
        if (gotVideo) {
          return dropped(playbackStart ? "Playback stopped (end of the recording, or the camera closed it)." : "The video stopped. Close and open the live view to try again.");
        }
        if (!playbackStart) return liveFailed("The camera's video could not be opened.");
        // What the camera actually did (the server's relay saw it), rather than a guess.
        void playbackProblem().then((p) => playbackFailed(p, "The recording could not be opened. Check that the camera user has the Playback permission and that RTSP is on (port 554)."));
      };
    };
    void connect();

    // Watchdog: video that never starts, or stops arriving while the connection stays open.
    const watchdog = setInterval(() => {
      if (stopped || !ws) return;
      const quiet = performance.now() - lastData;
      if (!gotVideo && quiet > 25_000) {
        if (!playbackStart) liveFailed("The camera did not send video.");
        else {
          lastData = performance.now(); // ask once
          void playbackProblem().then((p) => playbackFailed(p, "The camera did not send the recording. Try another time, or check the camera's playback settings."));
        }
      }
      else if (gotVideo && quiet > 12_000) dropped(playbackStart ? "Playback stopped: the camera stopped sending the recording." : "The video stopped: the camera stopped sending.");
      // Steady video again: a later drop may reconnect again.
      else if (gotVideo && quiet < 2000 && performance.now() - openedAt > 30_000) reconnects = 0;
      // Live: a browser that paused the video (hidden tab, power saving) plays on at the live edge.
      if (!playbackStart && gotVideo && el.paused && !document.hidden) void el.play().catch(() => undefined);
    }, 1000);

    // Playback speed: slower is the browser's; faster plays at the pace the camera sends, which is
    // measured from how quickly video arrives, keeping a few seconds in hand.
    let last: { at: number; end: number } | null = null;
    let arrival = 1;
    const pace = setInterval(() => {
      if (!playbackStart || !buffer || buffer.buffered.length === 0) return;
      const end = buffer.buffered.end(buffer.buffered.length - 1);
      const { speed: wanted, onArrival: report, reserve, onBuffer: showBuffer } = rate.current;
      showBuffer?.(Math.max(0, end - el.currentTime));
      if (wanted <= 1 || fast <= 1) {
        // Build the reserve up while playing, a little slower; normal speed once it is there.
        const ahead = end - el.currentTime;
        const build = ahead < reserve.target / 2 ? 0.9 : ahead < reserve.target ? 0.96 : 1;
        el.playbackRate = wanted < 1 ? wanted * build : build;
        return;
      }
      const now = performance.now();
      if (last && now - last.at > 900) {
        arrival = arrival * 0.6 + ((end - last.end) / ((now - last.at) / 1000)) * 0.4;
        report?.(arrival);
      }
      if (!last || now - last.at > 900) last = { at: now, end };
      const ahead = end - el.currentTime;
      const target = arrival * (ahead > 4 ? 1.15 : ahead < 1 ? 0.8 : 1);
      el.playbackRate = Math.min(16, Math.max(0.5, target));
    }, 1000);

    return () => {
      el.removeEventListener("waiting", onWaiting);
      el.removeEventListener("playing", onPlayingOnce);
      clearInterval(pace);
      clearInterval(watchdog);
      window.clearTimeout(retryTimer);
      stopped = true;
      ws?.close();
      el.removeAttribute("src");
      el.load();
    };
  }, [cameraId, onFailed, playbackStart, fast, channel]);

  return (
    <div className="relative flex h-full w-full items-center justify-center">
      <ZoomPan>
        <video
          ref={video}
          className="h-full w-full object-contain"
          autoPlay={!playbackStart}
          muted
          playsInline
          aria-label={`Live video from ${name}`}
          onPlaying={() => setPlaying(true)}
          onTimeUpdate={(e) => onTime?.(e.currentTarget.currentTime)}
        />
      </ZoomPan>
      {!playing && !error && <div className="absolute inset-0 flex items-center justify-center"><Spinner label="Starting video" /></div>}
    </div>
  );
}
