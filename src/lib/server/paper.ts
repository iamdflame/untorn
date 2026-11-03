// The paper finder: the pieces' rough masks without SAM 3.1, for a run that goes on when Meta's API turns our key
// away. Torn paper laid on a darker table is what differs most from the table: the table's colour is the median of a
// band along the frame's edge, each pixel's distance from it (CIELAB) is split with Otsu's threshold, specks are
// opened away and each blob is a piece. A rough mask only: segment.ts snaps each one to the paper's edge at full
// resolution, exactly as it does SAM's pass-1 masks.
// Measured against SAM 3.1's outlines on recorded runs (scripts/eval/paper-finder.ts, IoU in the finder's frame): the
// 54 pieces of the four sample photos, 53 above 0.9 (medians 0.984–0.990); all 6 pieces of the real 6-piece tear above
// 0.95, plus one stray blob. Pieces that touch come out as one blob, where SAM keeps them apart (the real 10-piece photo:
// 6 blobs); a table about as light as the paper gives no clean split, and the finder then finds nothing.

import type { Rgb } from "./images";
import type { PlacedMask } from "./mask-geometry";

export type PaperFind = {
  /** The frame the masks are in (the photo scaled to `longSide`), and photo px per frame px. */
  width: number;
  height: number;
  scale: number;
  masks: PlacedMask[];
  /** The Otsu split (CIELAB distance from the table's colour) and the table's colour; null split when none was clean. */
  split: number | null;
  table: [number, number, number];
};

/** Below this distance between paper and table (CIELAB ΔE), the split is noise and nothing is found. */
export const MIN_SPLIT = 10;
/** A blob smaller than this share of the frame is a speck. */
const MIN_BLOB = 0.0008;
/** More of the frame than this "paper" means the table isn't darker than the paper. */
const MAX_PAPER = 0.7;
/** Each blob is closed with a (2r+1)² square of this radius (frame px). */
const CLOSE = 2;

const LIN = Float32Array.from({ length: 256 }, (_, c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});
const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

export function toLab(r: number, g: number, b: number): [number, number, number] {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const fx = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const fy = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const fz = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Box-average the photo down to `longSide` (no larger than the photo). */
function shrink(rgb: Rgb, longSide: number): { width: number; height: number; data: Uint8Array; scale: number } {
  const { width: W, height: H, data } = rgb;
  const s = Math.min(1, longSide / Math.max(W, H));
  const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * H) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * H) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * W) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * W) / w));
      let r = 0, g = 0, b = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * W + xx) * 3;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
      const n = (y1 - y0) * (x1 - x0);
      const o = (y * w + x) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return { width: w, height: h, data: out, scale: W / w };
}

/** Otsu's threshold over values in [0, max): the middle of the run of bins that split the two classes best. */
export function otsu(values: Float32Array, max = 160, bins = 256): number {
  const hist = new Float64Array(bins);
  for (const v of values) hist[Math.min(bins - 1, Math.max(0, Math.floor((v / max) * bins)))]++;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, first = 0, last = 0;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = values.length - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2;
    if (between > best * (1 + 1e-9)) {
      best = between;
      first = last = i;
    } else if (between >= best * (1 - 1e-9)) last = i;
  }
  return (((first + last) / 2 + 0.5) / bins) * max;
}

/** One pass of a (2r+1)² square erosion or dilation, separable. Outside the frame counts as background. */
function morph(m: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array<ArrayBuffer> {
  const pass = (src: Uint8Array, horizontal: boolean): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 1;
        for (let k = -r; k <= r && v === (dilate ? 0 : 1); k++) {
          const xx = horizontal ? x + k : x, yy = horizontal ? y : y + k;
          const p = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : src[yy * w + xx];
          if (dilate ? p : !p) v = dilate ? 1 : 0;
        }
        out[y * w + x] = v;
      }
    return out;
  };
  return pass(pass(m, true), false);
}

export function findPaper(rgb: Rgb, longSide = 1280): PaperFind {
  const fr = shrink(rgb, longSide);
  const { width: w, height: h, data } = fr;
  const n = w * h;
  // the table: the median colour of a band along the frame's edge
  const band = Math.max(4, Math.round(0.03 * Math.min(w, h)));
  const L: number[] = [], A: number[] = [], B: number[] = [];
  for (let y = 0; y < h; y += 2)
    for (let x = 0; x < w; x += 2) {
      if (x >= band && y >= band && x < w - band && y < h - band) continue;
      const i = (y * w + x) * 3;
      const c = toLab(data[i], data[i + 1], data[i + 2]);
      L.push(c[0]);
      A.push(c[1]);
      B.push(c[2]);
    }
  const median = (v: number[]) => v.sort((p, q) => p - q)[v.length >> 1];
  const table: [number, number, number] = [median(L), median(A), median(B)];
  const dist = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const c = toLab(data[i * 3], data[i * 3 + 1], data[i * 3 + 2]);
    dist[i] = Math.hypot(c[0] - table[0], c[1] - table[1], c[2] - table[2]);
  }
  const t = otsu(dist);
  let m = new Uint8Array(n);
  let paper = 0;
  for (let i = 0; i < n; i++)
    if (dist[i] > t) {
      m[i] = 1;
      paper++;
    }
  const empty: PaperFind = { width: w, height: h, scale: fr.scale, masks: [], split: null, table };
  if (t < MIN_SPLIT || paper > MAX_PAPER * n) return empty;
  // open: specks of grain or glare go; text is inside the paper and the masks' holes are filled downstream
  m = morph(morph(m, w, h, 1, false), w, h, 1, true);
  // 4-connected blobs, each with its box
  const label = new Int32Array(n).fill(-1);
  const blobs: { area: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!m[i] || label[i] >= 0) continue;
    const id = blobs.length;
    const bl = { area: 0, x0: w, y0: h, x1: -1, y1: -1 };
    label[i] = id;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w, y = (p - x) / w;
      bl.area++;
      if (x < bl.x0) bl.x0 = x;
      if (x > bl.x1) bl.x1 = x;
      if (y < bl.y0) bl.y0 = y;
      if (y > bl.y1) bl.y1 = y;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q < 0 || !m[q] || label[q] >= 0) continue;
        label[q] = id;
        stack.push(q);
      }
    }
    blobs.push(bl);
  }
  // each blob closed on its own (text cut by a torn edge leaves notches), so two pieces near each other never merge
  const masks: PlacedMask[] = [];
  blobs.forEach((bl, id) => {
    if (bl.area < MIN_BLOB * n) return;
    const r = CLOSE;
    const mw = bl.x1 - bl.x0 + 1 + 2 * r, mh = bl.y1 - bl.y0 + 1 + 2 * r;
    let d = new Uint8Array(mw * mh);
    for (let y = bl.y0; y <= bl.y1; y++) for (let x = bl.x0; x <= bl.x1; x++) if (label[y * w + x] === id) d[(y - bl.y0 + r) * mw + (x - bl.x0 + r)] = 1;
    d = morph(morph(d, mw, mh, r, true), mw, mh, r, false);
    masks.push({ x: bl.x0 - r, y: bl.y0 - r, width: mw, height: mh, data: d });
  });
  return { width: w, height: h, scale: fr.scale, masks, split: Math.round(t * 10) / 10, table };
}
