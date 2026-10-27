import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { Spinner } from "./ui";
import { ZoomPan } from "./ZoomPan";

/** Codecs go2rtc may send; the browser says which it can play (H.265 only where supported). */
const CODECS = ["avc1.640029", "avc1.64002A", "avc1.640033", "hvc1.1.6.L153.B0", "mp4a.40.2", "mp4a.40.5", "flac", "opus"];

/**
 * Smooth video over a WebSocket (go2rtc's MSE stream, relayed by the server) into a <video>.
 * Stays near the live edge and drops old video so memory does not grow.
 */
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
}) {
  const video = useRef<HTMLVideoElement>(null);
  // Read at call time, so a new callback does not restart the stream.
  const prepared = useRef(onPrepared);
  prepared.current = onPrepared;
  const rate = useRef({ speed, onArrival });
  rate.current = { speed, onArrival };
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

    const flush = () => {
      if (!buffer || buffer.updating) return;
      const ranges = buffer.buffered;
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

    const connect = async () => {
      if (stopped) return;
      buffer = null;
      queue = [];
      gotVideo = false;
      try {
        if (playbackStart) {
          const r = await api<{ start?: string }>(`/cameras/${cameraId}/playback/prepare`, { method: "POST", body: { start: playbackStart, ...(fast > 1 ? { speed: fast } : {}), ...(channel ? { channel } : {}) } });
          if (r.start) prepared.current?.(r.start);
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
      socket.onopen = () => socket.send(JSON.stringify({ type: "mse", value: CODECS.filter((c) => Source.isTypeSupported(`video/mp4; codecs="${c}"`)).join() }));
      socket.onmessage = (ev) => {
        if (ws !== socket) return;
        if (typeof ev.data !== "string") {
          gotVideo = true;
          everPlayed = true;
          lastData = performance.now();
          queue.push(ev.data as ArrayBuffer);
          return flush();
        }
        const msg = JSON.parse(ev.data) as { type: string; value: string };
        if (msg.type === "error") {
          if (gotVideo) return dropped(`The video stopped: ${msg.value}`);
          if (!playbackStart) return fail(`The camera stream could not be opened: ${msg.value}`);
          // go2rtc only says "wrong response on SETUP": add what the camera actually answered.
          void api<{ refusal: { request: string; status: string } | null }>(`/cameras/${cameraId}/playback/problem`)
            .then((p) => p.refusal, () => null)
            .then((r) => fail(`The camera stream could not be opened: ${msg.value}.${r ? ` The camera answered "${r.status}" to ${r.request}.` : ""}`));
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
        fail(playbackStart ? "The recording could not be opened. The camera user needs the Playback permission, and RTSP must be on (port 554)." : "The camera's video could not be opened. Check that RTSP is turned on in the camera (port 554).");
      };
    };
    void connect();

    // Watchdog: video that never starts, or stops arriving while the connection stays open.
    const watchdog = setInterval(() => {
      if (stopped || !ws) return;
      const quiet = performance.now() - lastData;
      if (!gotVideo && quiet > 25_000) fail(playbackStart ? "The camera did not send the recording. Try another time, or check the camera's playback settings." : "The camera did not send video. Check that RTSP is turned on in the camera (port 554), or use pictures.");
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
      const { speed: wanted, onArrival: report } = rate.current;
      if (wanted <= 1 || fast <= 1) {
        el.playbackRate = Math.min(wanted, 1);
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
          autoPlay
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
