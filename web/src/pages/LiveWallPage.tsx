import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Grid2x2, Grid3x3, LayoutGrid, Maximize2, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";
import type { Camera, CameraDetail, Page } from "../api/types";
import { LiveVideo } from "../components/LiveVideo";
import { Button, PageHeader } from "../components/ui";

/** A tile's camera: a camera, or one channel of an NVR. */
interface Tile { id: string; name: string; channel?: number }
interface Wall { size: 2 | 3 | 4; tiles: (Tile | null)[] }

const WALL_KEY = "cctv-live-wall";
const LAYOUTS = [
  { size: 2, label: "2 × 2", icon: Grid2x2 },
  { size: 3, label: "3 × 3", icon: Grid3x3 },
  { size: 4, label: "4 × 4", icon: LayoutGrid },
] as const;
/** A tile that cannot play video shows a picture this often (16 such tiles stay within the live view limit). */
const PICTURE_MS = 5000;

function savedWall(): Wall {
  try {
    const v = JSON.parse(localStorage.getItem(WALL_KEY) ?? "null") as Wall | null;
    if (v && [2, 3, 4].includes(v.size) && Array.isArray(v.tiles)) return v;
  } catch {
    // Not readable: start empty.
  }
  return { size: 2, tiles: [] };
}

/**
 * Several cameras' live video at once (2 × 2, 3 × 3 or 4 × 4), for watching an area. Each tile plays
 * the camera's second stream; a tile whose video cannot play shows a picture every few seconds.
 * The layout and cameras are kept in this browser.
 */
export function LiveWallPage() {
  const [wall, setWall] = useState<Wall>(savedWall);
  const [picking, setPicking] = useState<number | null>(null);
  const video = useQuery({ queryKey: ["live-video"], queryFn: () => api<{ enabled: boolean }>("/cameras/live-video"), staleTime: 5 * 60_000 });
  const update = (next: Wall) => {
    setWall(next);
    try {
      localStorage.setItem(WALL_KEY, JSON.stringify(next));
    } catch {
      // Not kept (private window): this visit only.
    }
  };
  const count = wall.size * wall.size;
  const tiles = Array.from({ length: count }, (_, i) => wall.tiles[i] ?? null);
  const setTile = (i: number, t: Tile | null) => {
    const next = [...tiles];
    next[i] = t;
    update({ ...wall, tiles: next });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Live"
        description="Several cameras at once. Choose a camera for each tile; the layout is kept in this browser."
        actions={
          <div className="flex items-center gap-1 rounded-md border border-line p-0.5" role="group" aria-label="Layout">
            {LAYOUTS.map(({ size, label, icon: Icon }) => (
              <Button key={size} size="sm" variant={wall.size === size ? "primary" : "ghost"} icon={<Icon className="h-4 w-4" />} aria-pressed={wall.size === size} onClick={() => update({ ...wall, size })}>
                {label}
              </Button>
            ))}
          </div>
        }
      />
      {/* As wide as fits the window's height, so the whole wall is on screen (16:9 tiles). */}
      <div
        className={clsx("mx-auto grid gap-1.5 rounded-lg bg-black p-1.5", { 2: "grid-cols-1 sm:grid-cols-2", 3: "grid-cols-2 lg:grid-cols-3", 4: "grid-cols-2 lg:grid-cols-4" }[wall.size])}
        style={{ maxWidth: "max(32rem, calc((100vh - 12rem) * 16 / 9))" }}
      >
        {tiles.map((t, i) => (
          <WallTile key={`${i}:${t?.id ?? ""}:${t?.channel ?? ""}`} tile={t} smooth={video.data?.enabled ?? false} onPick={() => setPicking(i)} onClear={() => setTile(i, null)} />
        ))}
      </div>
      {picking !== null && <CameraPicker onClose={() => setPicking(null)} onPick={(t) => { setTile(picking, t); setPicking(null); }} />}
    </div>
  );
}

function WallTile({ tile, smooth, onPick, onClear }: { tile: Tile | null; smooth: boolean; onPick: () => void; onClear: () => void }) {
  const frame = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const onFailed = useCallback((m: string) => setFailed(m), []);
  if (!tile) {
    return (
      <button type="button" onClick={onPick} className="flex aspect-video items-center justify-center rounded bg-neutral-900 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200">
        + Choose a camera
      </button>
    );
  }
  return (
    <div ref={frame} className="group relative aspect-video overflow-hidden rounded bg-neutral-950" onDoubleClick={() => void frame.current?.requestFullscreen?.()}>
      {smooth && !failed ? (
        <LiveVideo key={attempt} cameraId={tile.id} name={tile.name} channel={tile.channel} onFailed={onFailed} />
      ) : (
        <TilePicture tile={tile} note={failed} />
      )}
      {/* Along the bottom: cameras put their own name and time at the top, and the zoom buttons are top right. */}
      <div className="pointer-events-none absolute inset-x-1 bottom-1 flex items-end gap-1 text-xs text-white">
        <Link to={`/cameras/${tile.id}`} className="pointer-events-auto max-w-[70%] truncate rounded bg-black/75 px-1.5 py-0.5 font-medium hover:underline" title="Open the camera's page">{tile.name}</Link>
        <span className="ml-auto flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {failed && smooth && (
            <TileButton label="Try video again" onClick={() => { setFailed(null); setAttempt((a) => a + 1); }}><RefreshCw className="h-3.5 w-3.5" /></TileButton>
          )}
          <TileButton label="Change camera" onClick={onPick}><Search className="h-3.5 w-3.5" /></TileButton>
          <TileButton label="Full screen (or double-click)" onClick={() => void frame.current?.requestFullscreen?.()}><Maximize2 className="h-3.5 w-3.5" /></TileButton>
          <TileButton label="Empty this tile" onClick={onClear}><X className="h-3.5 w-3.5" /></TileButton>
        </span>
      </div>
    </div>
  );
}

function TileButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="pointer-events-auto rounded bg-black/50 p-1 hover:bg-black/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white">
      {children}
    </button>
  );
}

/** A picture every few seconds: for tiles whose video cannot play, or without the live video service. */
function TilePicture({ tile, note }: { tile: Tile; note: string | null }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let stopped = false;
    let current: string | null = null;
    let timer: number | undefined;
    let first = true;
    const load = async () => {
      if (!document.hidden) {
        try {
          const q = new URLSearchParams({ ...(first ? { start: "1" } : {}), ...(tile.channel ? { channel: String(tile.channel) } : {}) });
          const res = await fetch(`/api/cameras/${tile.id}/snapshot?${q}`, { credentials: "same-origin", cache: "no-store" });
          if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? `No picture (${res.status})`);
          const url = URL.createObjectURL(await res.blob());
          if (stopped) return URL.revokeObjectURL(url);
          first = false;
          if (current) URL.revokeObjectURL(current);
          current = url;
          setSrc(url);
          setError(null);
        } catch (e) {
          if (!stopped) setError((e as Error).message);
        }
      }
      if (!stopped) timer = window.setTimeout(() => void load(), PICTURE_MS);
    };
    void load();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      if (current) URL.revokeObjectURL(current);
    };
  }, [tile.id, tile.channel]);
  return (
    <div className="relative flex h-full w-full items-center justify-center">
      {src && <img src={src} alt={`Live picture from ${tile.name}`} className="h-full w-full object-contain" />}
      {(error || note) && (
        <p className="absolute inset-x-2 top-2 rounded bg-black/70 px-2 py-1 text-xs text-neutral-200" title={note ?? undefined}>
          {error ?? `Pictures every ${PICTURE_MS / 1000} s: ${note}`}
        </p>
      )}
    </div>
  );
}

/** Find a camera (or an NVR channel) by name, address or location. */
function CameraPicker({ onPick, onClose }: { onPick: (t: Tile) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [nvr, setNvr] = useState<Camera | null>(null);
  const found = useQuery({
    queryKey: ["wall-pick", q],
    queryFn: () => api<Page<Camera>>(`/cameras?pageSize=20${q.trim() ? `&search=${encodeURIComponent(q.trim())}` : ""}`),
    staleTime: 30_000,
  });
  const channels = useQuery({ queryKey: ["camera", nvr?.id], queryFn: () => api<CameraDetail>(`/cameras/${nvr!.id}`), enabled: !!nvr });
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[10vh]" onClick={onClose} role="presentation">
      <div role="dialog" aria-modal="true" aria-label="Choose a camera" className="w-full max-w-lg rounded-lg bg-surface p-4 shadow-xl" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        {nvr ? (
          <>
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-semibold">{nvr.name}: choose a channel</h2>
              <Button size="sm" variant="ghost" onClick={() => setNvr(null)}>Back</Button>
            </div>
            <ul className="max-h-80 divide-y divide-line overflow-y-auto text-sm">
              {(channels.data?.channelList ?? []).map((c) => (
                <li key={c.channel}>
                  <button type="button" className="flex w-full items-center gap-2 px-2 py-2 text-left hover:bg-surface-muted" onClick={() => onPick({ id: nvr.id, name: `${nvr.name} · ${c.name ?? `D${c.channel}`}`, channel: c.channel })}>
                    <span className="w-10 text-ink-muted">D{c.channel}</span>
                    <span className="flex-1">{c.name ?? `Channel ${c.channel}`}</span>
                    {c.online === false && <span className="text-xs text-red-600">no video</span>}
                  </button>
                </li>
              ))}
              {channels.isLoading && <li className="px-2 py-2 text-ink-muted">Loading channels…</li>}
            </ul>
          </>
        ) : (
          <>
            <label className="flex items-center gap-2 rounded-md border border-line px-2">
              <Search className="h-4 w-4 text-ink-muted" aria-hidden />
              <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search cameras by name, address or location" aria-label="Search cameras" className="w-full bg-transparent py-2 text-sm focus:outline-none" />
            </label>
            <ul className="mt-2 max-h-80 divide-y divide-line overflow-y-auto text-sm">
              {(found.data?.items ?? []).map((c) => (
                <li key={c.id}>
                  <button type="button" className="flex w-full items-center gap-2 px-2 py-2 text-left hover:bg-surface-muted" onClick={() => (c.deviceType === "nvr" ? setNvr(c) : onPick({ id: c.id, name: c.name }))}>
                    <span className="flex-1 truncate font-medium">{c.name}</span>
                    <span className="truncate text-xs text-ink-muted">{c.deviceType === "nvr" ? "NVR: choose a channel" : c.location ?? c.host}</span>
                  </button>
                </li>
              ))}
              {found.data && !found.data.items.length && <li className="px-2 py-2 text-ink-muted">No camera matches.</li>}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
