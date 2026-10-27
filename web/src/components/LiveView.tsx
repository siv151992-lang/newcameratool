import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Camera, Image, Maximize2, Pause, Play, Video } from "lucide-react";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { localTimeText, pictureFileName, savePicture } from "../lib/savePicture";
import { LiveVideo } from "./LiveVideo";
import { ZoomPan } from "./ZoomPan";
import { Button, Dialog, ErrorMessage, Spinner } from "./ui";

/** Time between pictures, and before trying again after an error. */
const REFRESH_MS = 1000;
const RETRY_MS = 5000;

/**
 * The camera's picture, refreshed about once a second. Pictures come through the server with the
 * camera's stored credentials; the browser never talks to the camera. Paused while the tab is hidden.
 */
export function LiveViewDialog({ camera, onClose }: { camera: { id: string; name: string; channel?: number } | null; onClose: () => void }) {
  return (
    <Dialog open={!!camera} onClose={onClose} title={camera ? `Live view: ${camera.name}` : "Live view"} size="xl">
      {camera && <LiveViewBody key={`${camera.id}:${camera.channel ?? ""}`} cameraId={camera.id} name={camera.name} channel={camera.channel} />}
    </Dialog>
  );
}

/** Smooth video when the server has the video service (go2rtc), else, or on request, pictures. */
function LiveViewBody({ cameraId, name, channel }: { cameraId: string; name: string; channel?: number }) {
  const option = useQuery({ queryKey: ["live-video"], queryFn: () => api<{ enabled: boolean }>("/cameras/live-video"), staleTime: 5 * 60_000 });
  const [chosen, setChosen] = useState<"video" | "picture" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const onFailed = useCallback((message: string) => {
    setNotice(message);
    setChosen("picture");
  }, []);
  const mode = chosen ?? (option.isLoading ? null : option.data?.enabled ? "video" : "picture");
  if (!mode) return <Spinner />;

  return (
    <div className="space-y-3">
      {option.data?.enabled && (
        <div className="inline-flex rounded-md border border-line p-0.5" role="group" aria-label="Live view type">
          {(["video", "picture"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => {
                setNotice(null);
                setChosen(m);
              }}
              className={clsx("inline-flex items-center gap-1.5 rounded px-3 py-1 text-sm", mode === m ? "bg-accent text-white" : "text-ink-secondary hover:text-ink")}
            >
              {m === "video" ? <Video className="h-4 w-4" aria-hidden /> : <Image className="h-4 w-4" aria-hidden />}
              {m === "video" ? "Video" : "Pictures"}
            </button>
          ))}
        </div>
      )}
      {notice && mode === "picture" && <p className="text-sm text-warn">{notice}</p>}
      {mode === "video" ? <VideoFrame cameraId={cameraId} name={name} channel={channel} onFailed={onFailed} /> : <LivePicture cameraId={cameraId} name={name} channel={channel} />}
    </div>
  );
}

function VideoFrame({ cameraId, name, channel, onFailed }: { cameraId: string; name: string; channel?: number; onFailed: (message: string) => void }) {
  const frame = useRef<HTMLDivElement>(null);
  return (
    <div className="space-y-3">
      <div ref={frame} className="relative mx-auto flex aspect-video max-h-[55vh] items-center justify-center overflow-hidden rounded-md bg-black">
        <LiveVideo cameraId={cameraId} name={name} channel={channel} onFailed={onFailed} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-secondary">Live video from the camera's second stream, without sound.</p>
        <div className="flex gap-2">
          <SavePictureButton frame={frame} name={name} />
          <Button size="sm" icon={<Maximize2 className="h-4 w-4" />} onClick={() => void frame.current?.requestFullscreen?.()}>
            Full screen
          </Button>
        </div>
      </div>
    </div>
  );
}

function LivePicture({ cameraId, name, channel }: { cameraId: string; name: string; channel?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [paused, setPaused] = useState(false);
  const frame = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (paused) return;
    let stopped = false;
    let timer: number | undefined;
    let first = !updatedAt;
    let current: string | null = null;
    const next = (ms: number) => {
      if (!stopped) timer = window.setTimeout(load, ms);
    };
    async function load() {
      if (document.hidden) return next(REFRESH_MS);
      try {
        const res = await fetch(`/api/cameras/${cameraId}/snapshot?${new URLSearchParams({ ...(first ? { start: "1" } : {}), ...(channel ? { channel: String(channel) } : {}) })}`, { credentials: "same-origin", cache: "no-store" });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
          throw new Error(body?.error?.message ?? `The picture could not be loaded (${res.status})`);
        }
        const url = URL.createObjectURL(await res.blob());
        if (stopped) return URL.revokeObjectURL(url);
        first = false;
        if (current) URL.revokeObjectURL(current);
        current = url;
        setSrc(url);
        setError(null);
        setUpdatedAt(new Date());
        next(REFRESH_MS);
      } catch (e) {
        if (stopped) return;
        setError((e as Error).message);
        next(RETRY_MS);
      }
    }
    void load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      if (current) URL.revokeObjectURL(current);
    };
    // updatedAt only marks the first picture of a viewing; it must not restart the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId, paused, channel]);

  return (
    <div className="space-y-3">
      <div ref={frame} className="relative mx-auto flex aspect-video max-h-[55vh] items-center justify-center overflow-hidden rounded-md bg-black">
        {src ? (
          <ZoomPan>
            <img src={src} alt={`Live picture from ${name}`} className="h-full w-full object-contain" draggable={false} />
          </ZoomPan>
        ) : error ? (
          <Video className="h-10 w-10 text-white/40" aria-hidden />
        ) : (
          <Spinner label="Connecting to the camera" />
        )}
        {paused && <span className="absolute left-3 top-3 rounded bg-black/70 px-2 py-0.5 text-xs font-medium text-white">Paused</span>}
      </div>
      {error && <ErrorMessage error={new Error(`${error}${src ? " Showing the last picture; trying again." : " Trying again."}`)} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-secondary">
          {updatedAt ? `Picture from ${updatedAt.toLocaleTimeString()}. ` : ""}Refreshes about once a second.
        </p>
        <div className="flex gap-2">
          <Button size="sm" icon={paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />} onClick={() => setPaused(!paused)}>
            {paused ? "Resume" : "Pause"}
          </Button>
          <SavePictureButton frame={frame} name={name} disabled={!src} />
          <Button size="sm" icon={<Maximize2 className="h-4 w-4" />} disabled={!src} onClick={() => void frame.current?.requestFullscreen?.()}>
            Full screen
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Saves the picture on screen as a PNG named after the camera and the time. */
function SavePictureButton({ frame, name, disabled }: { frame: RefObject<HTMLDivElement | null>; name: string; disabled?: boolean }) {
  const [failed, setFailed] = useState(false);
  return (
    <Button
      size="sm" icon={<Camera className="h-4 w-4" />} disabled={disabled}
      title={failed ? "No picture yet; try again once the video shows" : "Save the current picture as a PNG file"}
      onClick={() => void savePicture(frame.current, pictureFileName(name, localTimeText())).then((ok) => setFailed(!ok))}
    >
      Save picture
    </Button>
  );
}
