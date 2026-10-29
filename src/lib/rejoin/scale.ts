// Working scale. The solver's geometry (outline smoothing, straight-edge detection, seed windows, ICP bands, the
// fine-residual floor) works in pixels, and real tears have a physical scale: fibre rims and raggedness of a fraction
// of a millimetre, shapes of centimetres. So the geometry runs at a scale where text lines are a fixed number of
// pixels apart (the text-line pitch is the one length every printed page carries), and the result's poses are
// converted back to photo pixels. Pages without text fall back to the pieces' size.

import { depthMap } from "./raster";
import { textOrientation } from "./orientation";
import type { FragmentInput } from "./types";

export type ScaleOptions = {
  /** Text-line pitch (working px) the geometry runs at. */
  targetPitch: number;
  /** …but never so small that the median piece covers less than this (working px²): small pieces lose their shape. */
  minPieceArea: number;
  /** Without text: median piece area (photo px²) above which photos are shrunk, and the area they are brought to. */
  areaTrigger: number;
  areaTarget: number;
};

export const SCALE_DEFAULTS: ScaleOptions = { targetPitch: 32, minPieceArea: 60_000, areaTrigger: 400_000, areaTarget: 160_000 };

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

export const maskArea = (inp: FragmentInput) => {
  let a = 0;
  for (let i = 0; i < inp.mask.data.length; i++) if (inp.mask.data[i]) a++;
  return a;
};

/**
 * The working scale for a set of pieces (≤ 1: geometry never runs above photo resolution), and the median text-line
 * pitch it was taken from (photo px; null without text). The pitch is measured on copies at most ~550 px across.
 */
export function workingScale(inputs: FragmentInput[], options: Partial<ScaleOptions> = {}): { scale: number; pitch: number | null } {
  const o = { ...SCALE_DEFAULTS, ...options };
  const area = median(inputs.map(maskArea));
  if (!area) return { scale: 1, pitch: null };
  const k0 = Math.min(1, Math.sqrt(300_000 / area));
  const pitches: number[] = [];
  for (const inp of inputs) {
    if (!inp.rgba) continue;
    const small = downscaleInput(inp, k0);
    const t = textOrientation(small.rgba!, small.mask, depthMap(small.mask));
    if (!t || t.confidence < 0.5) continue;
    const p = t.grid && t.grid.regularity >= 0.3 ? t.grid.period : t.pitch;
    if (p) pitches.push(p / k0);
  }
  // the pitch of most pieces: a heading or a stray reading on one piece does not move it
  if (pitches.length >= Math.min(3, inputs.length)) {
    const pitch = median(pitches);
    const floor = Math.sqrt(o.minPieceArea / area);
    return { scale: Math.max(0.12, Math.min(1, Math.max(floor, o.targetPitch / pitch))), pitch };
  }
  return { scale: area > o.areaTrigger ? Math.max(0.12, Math.sqrt(o.areaTarget / area)) : 1, pitch: null };
}

/**
 * A piece resampled by k (≤ 1) on the photo's working grid: working pixel (i, j) covers photo
 * [i/k, (i+1)/k) × [j/k, (j+1)/k). The mask keeps pixels at least half covered; the colours are box-averaged.
 */
export function downscaleInput(input: FragmentInput, k: number): FragmentInput {
  if (k >= 1) return input;
  const { mask, x0, y0, rgba } = input;
  const X0 = Math.floor(x0 * k);
  const Y0 = Math.floor(y0 * k);
  const W = Math.max(1, Math.ceil((x0 + mask.width) * k) - X0);
  const H = Math.max(1, Math.ceil((y0 + mask.height) * k) - Y0);
  const count = new Float32Array(W * H);
  const inside = new Float32Array(W * H);
  const sum = rgba ? new Float32Array(3 * W * H) : null;
  const colOf = new Int32Array(mask.width);
  for (let c = 0; c < mask.width; c++) colOf[c] = Math.min(W - 1, Math.max(0, Math.floor((x0 + c + 0.5) * k) - X0));
  for (let r = 0; r < mask.height; r++) {
    const row = Math.min(H - 1, Math.max(0, Math.floor((y0 + r + 0.5) * k) - Y0));
    for (let c = 0; c < mask.width; c++) {
      const o = row * W + colOf[c];
      const i = r * mask.width + c;
      count[o]++;
      if (mask.data[i]) inside[o]++;
      if (sum && rgba) {
        sum[3 * o] += rgba.data[4 * i];
        sum[3 * o + 1] += rgba.data[4 * i + 1];
        sum[3 * o + 2] += rgba.data[4 * i + 2];
      }
    }
  }
  const data = new Uint8Array(W * H);
  const px = sum ? new Uint8ClampedArray(4 * W * H) : null;
  for (let o = 0; o < W * H; o++) {
    if (!count[o]) continue;
    data[o] = inside[o] >= 0.5 * count[o] ? 1 : 0;
    if (px && sum) {
      px[4 * o] = sum[3 * o] / count[o];
      px[4 * o + 1] = sum[3 * o + 1] / count[o];
      px[4 * o + 2] = sum[3 * o + 2] / count[o];
      px[4 * o + 3] = 255;
    }
  }
  return { id: input.id, mask: { width: W, height: H, data }, x0: X0, y0: Y0, rgba: px ? { width: W, height: H, data: px } : undefined };
}
