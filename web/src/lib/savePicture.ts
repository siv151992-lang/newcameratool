import { hhmm, ticks } from "../components/MilestoneTimeline";

/** "Lobby camera" + 2026-10-27T14:05:09 → "Lobby-camera_2026-10-27_14-05-09.png" */
export function pictureFileName(cameraName: string, time: string): string {
  const safe = cameraName.trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "camera";
  return `${safe}_${time.slice(0, 19).replace("T", "_").replace(/:/g, "-")}.png`;
}

/** Local wall-clock time as YYYY-MM-DDTHH:MM:SS. */
export function localTimeText(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** What goes in the strip under the saved picture. */
export interface PictureCaption {
  camera: string;
  /** Camera wall-clock time, YYYY-MM-DDTHH:MM:SS. */
  time: string;
  /** "Playback" or "Live". */
  label: string;
  /** The recording timeline as shown (times are camera wall-clock as UTC ms). */
  timeline?: { time: number; span: number; min: number; max: number; segments: { start: number; end: number }[] };
}

/** Draws the caption strip (camera, date and time, and the timeline) at y, `w` wide. */
export function drawCaption(ctx: CanvasRenderingContext2D, c: PictureCaption, y: number, w: number, unit: number) {
  const pad = 2 * unit;
  const textH = 9 * unit;
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(0, y, w, captionHeight(c, unit));
  ctx.textBaseline = "middle";
  ctx.font = `600 ${4.5 * unit}px system-ui, sans-serif`;
  ctx.fillStyle = "#f5f5f5";
  ctx.textAlign = "left";
  ctx.fillText(c.camera, pad, y + textH / 2);
  const [date = "", clock = ""] = c.time.split("T");
  const when = `${date.split("-").reverse().join("-")}  ${clock.slice(0, 8)}`;
  ctx.textAlign = "right";
  ctx.font = `700 ${5 * unit}px ui-monospace, monospace`;
  const labelW = ctx.measureText(` ${c.label} `).width;
  ctx.fillText(when, w - pad - labelW - unit * 2, y + textH / 2);
  ctx.fillStyle = c.label === "Live" ? "#16a34a" : "#dc2626";
  ctx.fillRect(w - pad - labelW, y + textH / 2 - 3.2 * unit, labelW, 6.4 * unit);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.font = `600 ${3.6 * unit}px system-ui, sans-serif`;
  ctx.fillText(c.label, w - pad - labelW / 2, y + textH / 2);
  const t = c.timeline;
  if (!t) return;
  // The timeline as on screen: the saved moment in the middle, recordings in red, the time scale.
  const top = y + textH;
  const from = t.time - t.span / 2;
  const x = (v: number) => ((v - from) / t.span) * w;
  ctx.fillStyle = "rgba(38,38,38,0.6)";
  if (from < t.min) ctx.fillRect(0, top, Math.max(0, x(t.min)), 20 * unit);
  if (from + t.span > t.max) ctx.fillRect(Math.min(w, x(t.max)), top, w, 20 * unit);
  ctx.fillStyle = "rgba(220,38,38,0.85)";
  for (const sg of t.segments) {
    if (sg.end <= from || sg.start >= from + t.span) continue;
    const a = Math.max(0, x(sg.start));
    ctx.fillRect(a, top + 3 * unit, Math.max(1, Math.min(w, x(sg.end)) - a), 7 * unit);
  }
  const scale = top + 11 * unit;
  ctx.fillStyle = "#404040";
  ctx.fillRect(0, scale, w, Math.max(1, unit / 4));
  ctx.font = `${3 * unit}px ui-monospace, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (const tk of ticks(from, from + t.span, t.span)) {
    ctx.fillStyle = tk.major ? "#a3a3a3" : "#525252";
    ctx.fillRect(x(tk.t), scale, Math.max(1, unit / 4), (tk.major ? 3 : 1.5) * unit);
    if (tk.major) ctx.fillText(tk.t % 86_400_000 === 0 ? new Date(tk.t).toISOString().slice(5, 10).split("-").reverse().join("-") : hhmm(tk.t), x(tk.t), scale + 3.5 * unit);
  }
  ctx.fillStyle = "#fbbf24";
  ctx.fillRect(w / 2 - unit / 4, top, Math.max(2, unit / 2), 20 * unit);
}

export const captionHeight = (c: PictureCaption, unit: number) => (c.timeline ? 29 : 9) * unit;

/**
 * Saves the picture shown in `frame` (its <video> or <img>) as a PNG at full camera resolution,
 * whatever the zoom, with a strip under it naming the camera and the time (and, in recordings,
 * the timeline). Returns false when there is no picture yet.
 */
export async function savePicture(frame: HTMLElement | null, fileName: string, caption?: PictureCaption): Promise<boolean> {
  const media = frame?.querySelector("video, img") as HTMLVideoElement | HTMLImageElement | null;
  if (!media) return false;
  const [w, h] = media instanceof HTMLVideoElement ? [media.videoWidth, media.videoHeight] : [media.naturalWidth, media.naturalHeight];
  if (!w || !h) return false;
  // Sizes in the strip follow the picture's width (1 unit = 1/320 of it), so it reads the same at any resolution.
  const unit = w / 320;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h + (caption ? Math.round(captionHeight(caption, unit)) : 0);
  const ctx = canvas.getContext("2d");
  ctx?.drawImage(media, 0, 0, w, h);
  if (ctx && caption) drawCaption(ctx, caption, h, w, unit);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
