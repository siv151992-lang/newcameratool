import { Maximize2, Pause, Play, Video } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, ErrorMessage, Spinner } from "./ui";

/** Time between pictures, and before trying again after an error. */
const REFRESH_MS = 1000;
const RETRY_MS = 5000;

/**
 * The camera's picture, refreshed about once a second. Pictures come through the server with the
 * camera's stored credentials; the browser never talks to the camera. Paused while the tab is hidden.
 */
export function LiveViewDialog({ camera, onClose }: { camera: { id: string; name: string } | null; onClose: () => void }) {
  return (
    <Dialog open={!!camera} onClose={onClose} title={camera ? `Live view: ${camera.name}` : "Live view"} size="xl">
      {camera && <LivePicture key={camera.id} cameraId={camera.id} name={camera.name} />}
    </Dialog>
  );
}

function LivePicture({ cameraId, name }: { cameraId: string; name: string }) {
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
        const res = await fetch(`/api/cameras/${cameraId}/snapshot${first ? "?start=1" : ""}`, { credentials: "same-origin", cache: "no-store" });
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
  }, [cameraId, paused]);

  return (
    <div className="space-y-3">
      <div ref={frame} className="relative mx-auto flex aspect-video max-h-[55vh] items-center justify-center overflow-hidden rounded-md bg-black">
        {src ? (
          <img src={src} alt={`Live picture from ${name}`} className="h-full w-full object-contain" />
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
          {updatedAt ? `Picture from ${updatedAt.toLocaleTimeString()}. ` : ""}Refreshes about once a second. For smooth video and sound, use the camera's or NVR's own software.
        </p>
        <div className="flex gap-2">
          <Button size="sm" icon={paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />} onClick={() => setPaused(!paused)}>
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button size="sm" icon={<Maximize2 className="h-4 w-4" />} disabled={!src} onClick={() => void frame.current?.requestFullscreen?.()}>
            Full screen
          </Button>
        </div>
      </div>
    </div>
  );
}
