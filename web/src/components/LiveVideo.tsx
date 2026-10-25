import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { ErrorMessage, Spinner } from "./ui";

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
    if (typeof MediaSource === "undefined") {
      onFailed("This browser cannot play live video. Showing pictures instead.");
      return;
    }
    let stopped = false;
    let ws: WebSocket | null = null;
    let buffer: SourceBuffer | null = null;
    const queue: ArrayBuffer[] = [];
    let gotVideo = false;

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
      if (next) buffer.appendBuffer(next);
    };
    const fail = (message: string) => {
      if (stopped) return;
      stopped = true;
      ws?.close();
      setError(message);
      onFailed(message);
    };

    void (async () => {
      try {
        if (playbackStart) {
          const r = await api<{ start?: string }>(`/cameras/${cameraId}/playback/prepare`, { method: "POST", body: { start: playbackStart, ...(fast > 1 ? { speed: fast } : {}) } });
          if (r.start) prepared.current?.(r.start);
        }
        else await api(`/cameras/${cameraId}/live/prepare`, { method: "POST" });
      } catch (e) {
        return fail((e as Error).message);
      }
      if (stopped) return;
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${scheme}://${window.location.host}/api/cameras/${cameraId}/${playbackStart ? "playback" : "live"}/ws`);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => ws!.send(JSON.stringify({ type: "mse", value: CODECS.filter((c) => MediaSource.isTypeSupported(`video/mp4; codecs="${c}"`)).join() }));
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") {
          gotVideo = true;
          queue.push(ev.data as ArrayBuffer);
          return flush();
        }
        const msg = JSON.parse(ev.data) as { type: string; value: string };
        if (msg.type === "error") return fail(`The camera stream could not be opened: ${msg.value}`);
        if (msg.type !== "mse") return;
        const source = new MediaSource();
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
      ws.onclose = () =>
        fail(
          gotVideo
            ? playbackStart ? "Playback stopped (end of the recording, or the camera closed it)." : "The video stopped. Close and open the live view to try again."
            : playbackStart ? "The recording could not be opened. The camera user needs the Playback permission, and RTSP must be on (port 554)." : "The camera's video could not be opened. Check that RTSP is turned on in the camera (port 554).",
        );
    })();

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
      stopped = true;
      ws?.close();
      el.removeAttribute("src");
      el.load();
    };
  }, [cameraId, onFailed, playbackStart, fast]);

  return (
    <div className="relative flex h-full w-full items-center justify-center">
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
      {!playing && !error && <div className="absolute inset-0 flex items-center justify-center"><Spinner label="Starting video" /></div>}
      {error && <div className="absolute inset-x-3 bottom-3"><ErrorMessage error={new Error(error)} /></div>}
    </div>
  );
}
