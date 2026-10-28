// Seam appearance: does the paper and the ink continue across a join? Two cheap pixel clues, reported with every
// candidate: the paper tone on both sides, and whether dark runs (text lines, rulings, strokes) meet at the same places
// along the seam. They are weak next to geometry and reading, but free: no model call.

import { poseApply, poseInvert } from "./geom";
import { sampleRgba } from "./raster";
import type { Appearance, Candidate, Fragment } from "./types";

const lum = (p: Float64Array) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];

/** Ink darkness at a photo point of a fragment (0 outside its paper), relative to its own paper tone. */
function inkAt(f: Fragment, x: number, y: number, px: Float64Array): number | null {
  const { mask, x0, y0, rgba } = f.input;
  if (!rgba) return null;
  const c = Math.floor(x - x0);
  const r = Math.floor(y - y0);
  if (c < 0 || r < 0 || c >= mask.width || r >= mask.height || f.depth[r * mask.width + c] < 2) return null;
  sampleRgba(rgba, x - x0, y - y0, px);
  const paper = f.paper ? 0.299 * f.paper[0] + 0.587 * f.paper[1] + 0.114 * f.paper[2] : 220;
  return Math.max(0, Math.min(1, (paper - lum(px) - 20) / 60));
}

/**
 * Appearance of a candidate join: paper tone distance, and the correlation of the ink profiles sampled 4–12 px inside
 * each piece along the seam (past the fibre rim and the mask noise). `ink` is null when either side is blank there.
 */
export function seamAppearance(A: Fragment, B: Fragment, c: Candidate): Appearance | null {
  if (!A.input.rgba || !B.input.rgba) return null;
  const n = A.outline.length / 2;
  const inv = poseInvert(c.pose);
  const px = new Float64Array(4);
  const ia: number[] = [];
  const ib: number[] = [];
  for (let q = 0; q < c.seamA[1]; q += 2) {
    const i = (c.seamA[0] + q) % n;
    const a = (i - 3 + n) % n;
    const b = (i + 3) % n;
    const tx = A.outline[2 * b] - A.outline[2 * a];
    const ty = A.outline[2 * b + 1] - A.outline[2 * a + 1];
    const l = Math.hypot(tx, ty) || 1;
    const nx = ty / l; // outward from A, towards B
    const ny = -tx / l;
    const x = A.outline[2 * i];
    const y = A.outline[2 * i + 1];
    let da = 0;
    let db = 0;
    let ok = true;
    for (const d of [4, 6, 8, 10, 12]) {
      const va = inkAt(A, x - d * nx, y - d * ny, px);
      const [bx, by] = poseApply(inv, x + d * nx, y + d * ny);
      const vb = inkAt(B, bx, by, px);
      if (va === null || vb === null) {
        ok = false;
        break;
      }
      da = Math.max(da, va);
      db = Math.max(db, vb);
    }
    if (!ok) continue;
    ia.push(da);
    ib.push(db);
  }
  const tone = A.paper && B.paper ? Math.hypot(A.paper[0] - B.paper[0], A.paper[1] - B.paper[1], A.paper[2] - B.paper[2]) : 0;
  let ink: number | null = null;
  if (ia.length >= 10) {
    const sm = (v: number[]) => v.map((_, k) => (v[Math.max(0, k - 1)] + v[k] + v[Math.min(v.length - 1, k + 1)]) / 3);
    const a = sm(ia);
    const b = sm(ib);
    const ma = a.reduce((s, v) => s + v, 0) / a.length;
    const mb = b.reduce((s, v) => s + v, 0) / b.length;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let k = 0; k < a.length; k++) {
      sab += (a[k] - ma) * (b[k] - mb);
      saa += (a[k] - ma) ** 2;
      sbb += (b[k] - mb) ** 2;
    }
    // both sides need some ink along the seam for the profiles to say anything
    if (ma > 0.02 && mb > 0.02 && saa > 1e-6 && sbb > 1e-6) ink = sab / Math.sqrt(saa * sbb);
  }
  const tonePenalty = Math.max(0, Math.min(1, (tone - 12) / 40));
  return { ink, tone, score: Math.max(-1, Math.min(1, (ink ?? 0) - tonePenalty)) };
}
