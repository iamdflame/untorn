// Working scale. The solver's geometry (outline smoothing, straight-edge detection, seed windows, ICP bands, the
// fine-residual floor) is designed for pages about 1000 px wide with text lines about 40 px apart: the scale of
// Bench-S, and of a phone photo shrunk to about 1500 px. A full-resolution phone photo is 2–3× larger, and every
// pixel parameter would be off by that factor (and matching 6× slower). So the geometry runs on a downscaled copy of
// each piece, and the result's poses are converted back to photo pixels.

import type { FragmentInput } from "./types";

/** Median piece area (photo px²) above which photos are downscaled, and the area a piece is brought to. */
const AREA_TRIGGER = 250_000;
const AREA_TARGET = 160_000;
/** Median text pitch (px) above which photos are downscaled, and the pitch they are brought to. */
const PITCH_TRIGGER = 64;
const PITCH_TARGET = 40;

/**
 * The working scale for a set of pieces: 1 for photos already near the design point (every Bench-S case), less for
 * larger ones. Uses the median piece area and, when known, the median text-line pitch (photo px); the stronger
 * reduction wins. Never enlarges.
 */
export function autoScale(areas: number[], pitches: number[] = []): number {
  const med = (v: number[]) => {
    const s = [...v].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
  };
  let k = 1;
  const area = med(areas);
  if (area > AREA_TRIGGER) k = Math.min(k, Math.sqrt(AREA_TARGET / area));
  const pitch = med(pitches);
  if (pitch > PITCH_TRIGGER) k = Math.min(k, PITCH_TARGET / pitch);
  return Math.max(0.15, Math.min(1, k));
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
