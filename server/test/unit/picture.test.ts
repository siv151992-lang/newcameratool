import jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";
import { analysePicture, judgePicture, type PictureBaseline, viewSimilarity } from "../../src/monitoring/picture.js";
import { MOCK_PICTURE } from "../../src/testing/mockPicture.js";

const W = 640, H = 360;
/** A scene with shapes, edges and colour, like a corridor; `shift` moves the camera's view. */
function scene(opts: { grey?: boolean; blur?: number; shiftX?: number; flip?: boolean; seed?: number } = {}): Buffer {
  const px = Buffer.alloc(W * H * 4);
  let s = opts.seed ?? 1;
  const noise = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 12;
  for (let y = 0; y < H; y++) {
    for (let x0 = 0; x0 < W; x0++) {
      const x = (opts.flip ? W - 1 - x0 : x0) + (opts.shiftX ?? 0);
      const door = x > 200 && x < 300 && y > 60 ? 1 : 0;
      const stripes = Math.floor(x / 40) % 2;
      const floor = y > 260 ? 1 : 0;
      const window = x > 420 && x < 560 && y > 40 && y < 160 ? 1 : 0;
      let r = 90 + 60 * stripes + 70 * window - 40 * door + 30 * floor;
      let g = 80 + 40 * stripes + 80 * window - 20 * door + 50 * floor;
      let b = 70 + 30 * stripes + 100 * window + 10 * door - 20 * floor;
      if (opts.grey) r = g = b = (r + g + b) / 3;
      const n = noise();
      const i = (y * W + x0) * 4;
      px[i] = clamp(r + n); px[i + 1] = clamp(g + n); px[i + 2] = clamp(b + n); px[i + 3] = 255;
    }
  }
  if (opts.blur) boxBlur(px, opts.blur);
  return Buffer.from(jpeg.encode({ data: px, width: W, height: H }, 85).data);
}
const flat = (v: number, n = 0) => {
  const px = Buffer.alloc(W * H * 4);
  let s = 7;
  for (let i = 0; i < px.length; i += 4) {
    const d = n ? ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * n : 0;
    px[i] = px[i + 1] = px[i + 2] = clamp(v + d); px[i + 3] = 255;
  }
  return Buffer.from(jpeg.encode({ data: px, width: W, height: H }, 85).data);
};
const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
function boxBlur(px: Buffer, r: number) {
  for (let pass = 0; pass < 2; pass++) {
    const src = Buffer.from(px);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0, n = 0;
          for (let d = -r; d <= r; d++) {
            const xx = pass === 0 ? Math.min(W - 1, Math.max(0, x + d)) : x;
            const yy = pass === 1 ? Math.min(H - 1, Math.max(0, y + d)) : y;
            sum += src[(yy * W + xx) * 4 + c]!;
            n++;
          }
          px[(y * W + x) * 4 + c] = sum / n;
        }
      }
    }
  }
}

/** A camera's baseline after a few normal pictures. */
function learnt(pictures: Buffer[]): { baseline: PictureBaseline; last: string } {
  let baseline: PictureBaseline = {};
  let last = "";
  for (const p of pictures) {
    const m = analysePicture(p);
    const j = judgePicture(m, last || null, baseline);
    expect(j.state).toBe("ok");
    baseline = j.baseline;
    last = m.hash;
  }
  return { baseline, last };
}

describe("picture health", () => {
  const day = [1, 2, 3, 4].map((seed) => scene({ seed }));
  const { baseline, last } = learnt(day);

  it("reads a real camera's snapshot (the simulated camera's) as normal", () => {
    const m = analysePicture(MOCK_PICTURE);
    expect([m.width, m.height]).toEqual([640, 360]);
    expect(judgePicture(m, null, {}).state).toBe("ok");
  });

  it("finds a black picture and a blank (covered) one", () => {
    expect(judgePicture(analysePicture(flat(3, 4)), last, baseline)).toMatchObject({ state: "black" });
    expect(judgePicture(analysePicture(flat(140, 2)), last, baseline)).toMatchObject({ state: "blank" });
    expect(judgePicture(analysePicture(flat(25, 3)), last, baseline).detail).toMatch(/covered/);
  });

  it("finds a frozen picture: the same bytes as at the last check", () => {
    const m = analysePicture(day[3]!);
    expect(judgePicture(m, m.hash, baseline).state).toBe("frozen");
  });

  it("finds a blurred picture against the camera's own usual detail", () => {
    const j = judgePicture(analysePicture(scene({ seed: 9, blur: 6 })), last, baseline);
    expect(j.state).toBe("blurred");
    expect(j.detail).toMatch(/% of this camera's usual detail/);
    // Slightly softer (compression, light) is still fine.
    expect(judgePicture(analysePicture(scene({ seed: 10, blur: 1 })), last, baseline).state).toBe("ok");
  });

  it("finds a moved view, but not a little shake or another light", () => {
    expect(judgePicture(analysePicture(scene({ seed: 11, flip: true })), last, baseline).state).toBe("moved");
    expect(judgePicture(analysePicture(scene({ seed: 12, shiftX: 3 })), last, baseline).state).toBe("ok");
    expect(viewSimilarity(analysePicture(scene({ seed: 13 })).thumb, baseline.day!.thumb)).toBeGreaterThan(0.8);
  });

  it("keeps day and night apart: the first infrared pictures teach the night baseline, not an alarm", () => {
    const night = analysePicture(scene({ seed: 20, grey: true, blur: 2 }));
    expect(night.light).toBe("night");
    const j = judgePicture(night, last, baseline);
    expect(j.state).toBe("ok");
    expect(j.baseline.night?.samples).toBe(1);
    expect(j.baseline.day).toEqual(baseline.day);
  });

  it("learns nothing from a bad picture", () => {
    expect(judgePicture(analysePicture(flat(3, 4)), last, baseline).baseline).toBe(baseline);
  });
});
