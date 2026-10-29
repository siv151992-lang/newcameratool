import { createHash } from "node:crypto";
import jpeg from "jpeg-js";

/**
 * Picture health: whether a camera's picture is usable, from one snapshot compared with the
 * camera's own earlier ones. Finds a black picture (failed sensor, no image, IR out at night), a
 * blank one (lens covered, sprayed, pointing at a wall), a blurred one (out of focus, dirty or wet
 * lens), a frozen one (the same picture twice) and a moved view (turned or knocked away from where
 * it looked). Cameras differ, so blur and view are judged against the camera's own baseline, kept
 * apart for day and night (colour and infrared look very different).
 */

export type PictureState = "ok" | "black" | "blank" | "blurred" | "frozen" | "moved";
export const PICTURE_PROBLEMS: readonly PictureState[] = ["black", "blank", "blurred", "frozen", "moved"];

/** What one snapshot shows, reduced to a few numbers and a tiny picture (kept, never the snapshot). */
export interface PictureMetrics {
  width: number;
  height: number;
  /** Average brightness, 0–255. */
  mean: number;
  /** Spread of brightness: near 0 for a picture of one colour. */
  std: number;
  /** Detail (variance of edges at 160 × 90): low when blurred. */
  sharpness: number;
  /** Hash of the JPEG bytes: a live camera never sends the same picture twice. */
  hash: string;
  /** "day" (colour) or "night" (infrared, grey), by how much colour the picture has. */
  light: "day" | "night";
  /** 32 × 18 grey thumbnail, base64: to compare the view with the reference. */
  thumb: string;
}

/** The camera's normal picture, by light: its usual sharpness and its reference view. */
export interface PictureBaseline {
  day?: { sharpness: number; thumb: string; samples: number };
  night?: { sharpness: number; thumb: string; samples: number };
}

const THUMB_W = 32;
const THUMB_H = 18;
const SHARP_W = 160;
const SHARP_H = 90;

/** Thresholds, tuned to keep false alarms rare: a problem must also be seen on two checks in a row. */
export const PICTURE_LIMITS = {
  /** Black: very dark and nearly uniform. */
  blackMean: 12,
  blackStd: 10,
  /** Blank: nearly one colour, whatever its brightness. */
  blankStd: 5,
  /** Blurred: detail below this share of the camera's usual detail. */
  blurRatio: 0.3,
  /** Moved: the view's structure matches the reference less than this (correlation, -1–1). */
  movedCorrelation: 0.35,
  /** Good pictures needed before blur and view are judged (the baseline settles first). */
  baselineSamples: 3,
};

/** Reads a JPEG snapshot into its metrics. Throws when it is not a picture that can be read. */
export function analysePicture(data: Buffer): PictureMetrics {
  const img = jpeg.decode(data, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 256 });
  const { width, height } = img;
  if (!width || !height) throw new Error("The camera sent an empty picture");
  const rgba = img.data;
  // Grey (luma) and how much colour, sampled at the sharpness grid's size (area averages).
  const grey = new Float32Array(SHARP_W * SHARP_H);
  let colour = 0;
  for (let gy = 0; gy < SHARP_H; gy++) {
    const y0 = Math.floor((gy * height) / SHARP_H), y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / SHARP_H));
    for (let gx = 0; gx < SHARP_W; gx++) {
      const x0 = Math.floor((gx * width) / SHARP_W), x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / SHARP_W));
      let sum = 0, sat = 0, n = 0;
      // Sample a few pixels of each cell (enough for a 4K picture to stay fast).
      const sy = Math.max(1, Math.floor((y1 - y0) / 3)), sx = Math.max(1, Math.floor((x1 - x0) / 3));
      for (let y = y0; y < y1; y += sy) {
        for (let x = x0; x < x1; x += sx) {
          const i = (y * width + x) * 4;
          const r = rgba[i]!, g = rgba[i + 1]!, b = rgba[i + 2]!;
          sum += 0.299 * r + 0.587 * g + 0.114 * b;
          sat += Math.max(r, g, b) - Math.min(r, g, b);
          n++;
        }
      }
      grey[gy * SHARP_W + gx] = sum / n;
      colour += sat / n;
    }
  }
  colour /= SHARP_W * SHARP_H;
  let mean = 0;
  for (const v of grey) mean += v;
  mean /= grey.length;
  let variance = 0;
  for (const v of grey) variance += (v - mean) ** 2;
  const std = Math.sqrt(variance / grey.length);
  // Variance of the Laplacian: the usual measure of focus.
  const lap: number[] = [];
  for (let y = 1; y < SHARP_H - 1; y++) {
    for (let x = 1; x < SHARP_W - 1; x++) {
      const i = y * SHARP_W + x;
      lap.push(4 * grey[i]! - grey[i - 1]! - grey[i + 1]! - grey[i - SHARP_W]! - grey[i + SHARP_W]!);
    }
  }
  const lm = lap.reduce((a, b) => a + b, 0) / lap.length;
  const sharpness = lap.reduce((a, b) => a + (b - lm) ** 2, 0) / lap.length;
  // Thumbnail: 5 × 5 cells of the grey grid.
  const thumb = Buffer.alloc(THUMB_W * THUMB_H);
  for (let ty = 0; ty < THUMB_H; ty++) {
    for (let tx = 0; tx < THUMB_W; tx++) {
      let s = 0;
      for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) s += grey[(ty * 5 + y) * SHARP_W + tx * 5 + x]!;
      thumb[ty * THUMB_W + tx] = Math.round(s / 25);
    }
  }
  return {
    width, height,
    mean: round(mean), std: round(std), sharpness: round(sharpness),
    hash: createHash("sha256").update(data).digest("hex").slice(0, 32),
    light: colour < 6 ? "night" : "day",
    thumb: thumb.toString("base64"),
  };
}

/** How alike two views are: correlation of their edge structure (1 the same, 0 unrelated). */
export function viewSimilarity(a: string, b: string): number {
  const edges = (t: string) => {
    const p = Buffer.from(t, "base64");
    const out: number[] = [];
    for (let y = 0; y < THUMB_H - 1; y++) {
      for (let x = 0; x < THUMB_W - 1; x++) {
        const i = y * THUMB_W + x;
        out.push(p[i + 1]! - p[i]!, p[i + THUMB_W]! - p[i]!);
      }
    }
    return out;
  };
  const ea = edges(a), eb = edges(b);
  const ma = ea.reduce((s, v) => s + v, 0) / ea.length, mb = eb.reduce((s, v) => s + v, 0) / eb.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ea.length; i++) {
    const x = ea[i]! - ma, y = eb[i]! - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

export interface PictureJudgement {
  /** What this snapshot shows (before the two-in-a-row rule). */
  state: PictureState;
  detail: string;
  /** The baseline to keep: learnt from good pictures only. */
  baseline: PictureBaseline;
}

/** Judges one snapshot against the previous one and the camera's baseline. */
export function judgePicture(m: PictureMetrics, previousHash: string | null, baseline: PictureBaseline): PictureJudgement {
  const L = PICTURE_LIMITS;
  if (m.mean < L.blackMean && m.std < L.blackStd) {
    return { state: "black", detail: `The picture is black (brightness ${Math.round(m.mean)} of 255). The sensor or image may have failed, or the infrared light is off at night.`, baseline };
  }
  if (m.std < L.blankStd) {
    return { state: "blank", detail: `The picture is one flat colour (brightness ${Math.round(m.mean)} of 255, almost no detail). The lens may be covered, painted or facing a wall.`, baseline };
  }
  if (previousHash && previousHash === m.hash) {
    return { state: "frozen", detail: "The camera sent exactly the same picture as at the last check: its image is frozen.", baseline };
  }
  const ref = baseline[m.light];
  if (ref && ref.samples >= L.baselineSamples) {
    if (m.sharpness < ref.sharpness * L.blurRatio) {
      return {
        state: "blurred",
        detail: `The picture has ${Math.round((m.sharpness / ref.sharpness) * 100)}% of this camera's usual detail (${m.light === "night" ? "at night" : "by day"}). The lens may be dirty, wet, misted or out of focus.`,
        baseline,
      };
    }
    const similarity = viewSimilarity(m.thumb, ref.thumb);
    if (similarity < L.movedCorrelation) {
      return {
        state: "moved",
        detail: `The view no longer matches this camera's reference view (${Math.round(Math.max(0, similarity) * 100)}% alike). The camera may have been turned, knocked or obstructed. If it was moved on purpose, use the current view as the reference.`,
        baseline,
      };
    }
  }
  // A good picture: it teaches the baseline (detail slowly, the reference view only while it settles).
  const prev = baseline[m.light];
  const samples = (prev?.samples ?? 0) + 1;
  const sharpness = prev ? prev.sharpness + (m.sharpness - prev.sharpness) / Math.min(samples, 10) : m.sharpness;
  const thumb = !prev || prev.samples < L.baselineSamples ? m.thumb : prev.thumb;
  return { state: "ok", detail: "The picture looks normal.", baseline: { ...baseline, [m.light]: { sharpness: round(sharpness), thumb, samples: Math.min(samples, 1000) } } };
}

const round = (v: number) => Math.round(v * 100) / 100;
