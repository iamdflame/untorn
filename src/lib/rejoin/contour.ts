// Subpixel outline of a binary mask: marching squares on the lightly blurred mask (iso 0.5 between pixel centres),
// keep the largest loop, then smooth lightly and resample at about 1 px. Pure TypeScript.

import { resampleClosed, reverseClosed, signedArea, smoothClosed } from "./geom";
import type { Mask } from "./types";

export type ContourOptions = {
  /** Binomial pre-blur passes on the mask before tracing (0 = none; 1 ≈ σ 0.7 px). */
  blur?: number;
  /** Gaussian smoothing of the traced outline, in px (applied at 1 px spacing). */
  smooth?: number;
  /** Output spacing in px. */
  spacing?: number;
};

/**
 * The outer outline of the mask's largest region, in the coordinates of the mask's frame shifted by (x0, y0):
 * pixel (c, r) covers [x0 + c, x0 + c + 1) × [y0 + r, y0 + r + 1). Closed (no repeated point), positive signed area
 * (interior on the (−dy, dx) side of each step), points about `spacing` apart. Returns null for an empty mask.
 */
export function traceOutline(mask: Mask, x0 = 0, y0 = 0, opts: ContourOptions = {}): Float64Array | null {
  const { blur = 1, smooth = 1, spacing = 1 } = opts;
  const raw = largestLoop(mask, blur);
  if (!raw) return null;
  for (let i = 0; i < raw.length; i += 2) {
    raw[i] += x0;
    raw[i + 1] += y0;
  }
  let pts = resampleClosed(raw, 1);
  if (smooth > 0) pts = smoothClosed(pts, smooth);
  pts = resampleClosed(pts, spacing);
  return signedArea(pts) < 0 ? reverseClosed(pts) : pts;
}

/** The padded, blurred field: (W+2)×(H+2) samples at pixel centres, zero border so every loop closes. */
function field(mask: Mask, blur: number): { f: Float32Array; w: number; h: number } {
  const w = mask.width + 2;
  const h = mask.height + 2;
  let f = new Float32Array(w * h);
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) f[(y + 1) * w + x + 1] = mask.data[y * mask.width + x] ? 1 : 0;
  }
  const tmp = new Float32Array(w * h);
  for (let pass = 0; pass < blur; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const l = x > 0 ? f[y * w + x - 1] : 0;
        const r = x < w - 1 ? f[y * w + x + 1] : 0;
        tmp[y * w + x] = 0.25 * l + 0.5 * f[y * w + x] + 0.25 * r;
      }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = y > 0 ? tmp[(y - 1) * w + x] : 0;
        const d = y < h - 1 ? tmp[(y + 1) * w + x] : 0;
        out[y * w + x] = 0.25 * u + 0.5 * tmp[y * w + x] + 0.25 * d;
      }
    }
    f = out;
  }
  return { f, w, h };
}

// Edge ids: horizontal edge (i, j)–(i+1, j) → 2·(j·w + i); vertical edge (i, j)–(i, j+1) → 2·(j·w + i) + 1.
// Cell corners: a = (i, j) bit 1, b = (i+1, j) bit 2, c = (i+1, j+1) bit 4, d = (i, j+1) bit 8 (set when inside).
// Edge codes within a cell: 0 top (a–b), 1 right (b–c), 2 bottom (d–c), 3 left (a–d).
const CASES: number[][] = [
  [],
  [3, 0],
  [0, 1],
  [3, 1],
  [1, 2],
  [], // saddle 5, resolved below
  [0, 2],
  [3, 2],
  [2, 3],
  [0, 2],
  [], // saddle 10, resolved below
  [1, 2],
  [3, 1],
  [0, 1],
  [3, 0],
  [],
];

function largestLoop(mask: Mask, blur: number): Float64Array | null {
  const { f, w, h } = field(mask, blur);
  const iso = 0.5;
  const nEdges = 2 * w * h;
  // Each crossing joins exactly two cells' segments: store up to two neighbours per crossing.
  const nb0 = new Int32Array(nEdges).fill(-1);
  const nb1 = new Int32Array(nEdges).fill(-1);
  const link = (e1: number, e2: number) => {
    if (nb0[e1] < 0) nb0[e1] = e2;
    else nb1[e1] = e2;
    if (nb0[e2] < 0) nb0[e2] = e1;
    else nb1[e2] = e1;
  };
  const edgeId = (i: number, j: number, code: number) => {
    switch (code) {
      case 0:
        return 2 * (j * w + i);
      case 1:
        return 2 * (j * w + i + 1) + 1;
      case 2:
        return 2 * ((j + 1) * w + i);
      default:
        return 2 * (j * w + i) + 1;
    }
  };
  const starts: number[] = [];
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const a = f[j * w + i];
      const b = f[j * w + i + 1];
      const c = f[(j + 1) * w + i + 1];
      const d = f[(j + 1) * w + i];
      const k = (a > iso ? 1 : 0) | (b > iso ? 2 : 0) | (c > iso ? 4 : 0) | (d > iso ? 8 : 0);
      if (k === 0 || k === 15) continue;
      let pairs: number[];
      if (k === 5 || k === 10) {
        const centre = (a + b + c + d) / 4 > iso;
        // 5: a, c inside. Centre inside → cut off b and d; else cut off a and c. 10 mirrors it.
        if (k === 5) pairs = centre ? [0, 1, 2, 3] : [3, 0, 1, 2];
        else pairs = centre ? [3, 0, 1, 2] : [0, 1, 2, 3];
      } else pairs = CASES[k];
      for (let p = 0; p < pairs.length; p += 2) {
        const e1 = edgeId(i, j, pairs[p]);
        const e2 = edgeId(i, j, pairs[p + 1]);
        link(e1, e2);
        starts.push(e1);
      }
    }
  }
  const seen = new Uint8Array(nEdges);
  const point = (e: number, out: number[]) => {
    const cellIdx = e >> 1;
    const i = cellIdx % w;
    const j = (cellIdx - i) / w;
    if ((e & 1) === 0) {
      const v0 = f[j * w + i];
      const v1 = f[j * w + i + 1];
      const t = (iso - v0) / (v1 - v0);
      out.push(i + t - 0.5, j - 0.5);
    } else {
      const v0 = f[j * w + i];
      const v1 = f[(j + 1) * w + i];
      const t = (iso - v0) / (v1 - v0);
      out.push(i - 0.5, j + t - 0.5);
    }
  };
  let best: number[] | null = null;
  let bestArea = 0;
  for (const s of starts) {
    if (seen[s]) continue;
    const loop: number[] = [];
    let prev = -1;
    let cur = s;
    while (cur >= 0 && !seen[cur]) {
      seen[cur] = 1;
      point(cur, loop);
      const next = nb0[cur] !== prev ? nb0[cur] : nb1[cur];
      prev = cur;
      cur = next;
    }
    if (loop.length < 6) continue;
    const area = Math.abs(signedArea(Float64Array.from(loop)));
    if (area > bestArea) {
      bestArea = area;
      best = loop;
    }
  }
  // Padded sample (i, j) is the centre of mask pixel (i − 1, j − 1), i.e. at (i − 0.5, j − 0.5) in mask coordinates.
  return best ? Float64Array.from(best) : null;
}

/** Arc length between consecutive points of a closed outline, summed. */
export function perimeter(pts: Float64Array): number {
  const n = pts.length / 2;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += Math.hypot(pts[2 * j] - pts[2 * i], pts[2 * j + 1] - pts[2 * i + 1]);
  }
  return s;
}
