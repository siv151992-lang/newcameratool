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

/**
 * Saves the picture shown in `frame` (its <video> or <img>) as a PNG at full camera resolution,
 * whatever the zoom. Returns false when there is no picture yet.
 */
export async function savePicture(frame: HTMLElement | null, fileName: string): Promise<boolean> {
  const media = frame?.querySelector("video, img") as HTMLVideoElement | HTMLImageElement | null;
  if (!media) return false;
  const [w, h] = media instanceof HTMLVideoElement ? [media.videoWidth, media.videoHeight] : [media.naturalWidth, media.naturalHeight];
  if (!w || !h) return false;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")?.drawImage(media, 0, 0, w, h);
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
