// Straighten a tilted photo: the image a camera looking straight down at the table would have taken from the same
// spot. The phone's gravity reading gives the tilt exactly (src/lib/run/tilt.ts), so this is one rotation about the
// camera centre (H = K R K⁻¹, K from the 35 mm-equivalent focal length), nothing estimated. On the user's 11.6° photo
// the pieces' line spacing went from 63–90 px across the table to 80–87 px, and the page came back as one sheet of 9
// pieces instead of three fragments; the intact page's keystone (top edge 20% narrower) became a rectangle.

import { tiltDegrees, upDegFor, type CameraTilt } from "@/lib/run/tilt";
import type { Rgb } from "./images";

/** Below this the size spread is under ~4%, which the solver absorbs (the real page at 1.4°); above it, straighten. */
export const MIN_TILT_DEG = 2;
/** Beyond this the table is seen too obliquely for one rotation to give it back. */
export const MAX_TILT_DEG = 30;
/** 35 mm film's diagonal (mm): the reference of a 35 mm-equivalent focal length. */
const FILM_DIAGONAL = 43.27;

type V3 = [number, number, number];

/** The rotation that turns the camera to look straight down, and the maps between the photo and the straight view. */
export function tiltMap(width: number, height: number, tilt: CameraTilt) {
  const up = upDegFor(tilt.orientation);
  if (up === null) return null;
  const f = (tilt.f35 / FILM_DIAGONAL) * Math.hypot(width, height);
  const phi = (up * Math.PI) / 180;
  // the camera's axes in the phone's: x across the photo, y down it, z out of the lens (the phone's back)
  const [gx, gy, gz] = tilt.gravity;
  const g: V3 = [gx * Math.sin(phi) - gy * Math.cos(phi), -gx * Math.cos(phi) - gy * Math.sin(phi), -gz];
  const n = Math.hypot(...g);
  const u: V3 = [g[0] / n, g[1] / n, g[2] / n];
  // rotate gravity onto the lens axis: about u × z, by the angle between them
  const s = Math.hypot(u[1], u[0]);
  const ax: V3 = s > 1e-12 ? [u[1] / s, -u[0] / s, 0] : [1, 0, 0];
  const th = Math.acos(Math.max(-1, Math.min(1, u[2])));
  const c = Math.cos(th);
  const sn = Math.sin(th);
  const [x, y, z] = ax;
  const R = [
    [c + x * x * (1 - c), x * y * (1 - c) - z * sn, x * z * (1 - c) + y * sn],
    [y * x * (1 - c) + z * sn, c + y * y * (1 - c), y * z * (1 - c) - x * sn],
    [z * x * (1 - c) - y * sn, z * y * (1 - c) + x * sn, c + z * z * (1 - c)],
  ];
  /** Photo pixel → straight view (pixels about the view's centre). */
  const fwd = (px: number, py: number): [number, number] => {
    const d = [px - width / 2, py - height / 2, f];
    const r = R.map((row) => row[0] * d[0] + row[1] * d[1] + row[2] * d[2]);
    return [(f * r[0]) / r[2], (f * r[1]) / r[2]];
  };
  /** Straight view → photo pixel. */
  const inv = (qx: number, qy: number): [number, number] => {
    const d = [qx, qy, f];
    const r = [0, 1, 2].map((k) => R[0][k] * d[0] + R[1][k] * d[1] + R[2][k] * d[2]);
    return [width / 2 + (f * r[0]) / r[2], height / 2 + (f * r[1]) / r[2]];
  };
  return { f, tiltDeg: tiltDegrees(tilt), fwd, inv };
}

/**
 * The photo straightened, or null when it needs no straightening (under MIN_TILT_DEG) or can't be (over MAX_TILT_DEG,
 * or an orientation no phone writes). The frame grows to hold every warped corner, capped at `maxPixels` (the photo
 * is then scaled down to fit); where no photo pixel lands, the table's mean border colour fills in, so no hard edge is
 * added for SAM to find.
 */
export function rectifyRgb(rgb: Rgb, tilt: CameraTilt, maxPixels = 1.3 * rgb.width * rgb.height): { rgb: Rgb; tiltDeg: number } | null {
  const W = rgb.width;
  const H = rgb.height;
  const m = tiltMap(W, H, tilt);
  if (!m || m.tiltDeg < MIN_TILT_DEG || m.tiltDeg > MAX_TILT_DEG) return null;
  const cs = [m.fwd(0, 0), m.fwd(W, 0), m.fwd(0, H), m.fwd(W, H)];
  const x0 = Math.min(...cs.map((p) => p[0]));
  const y0 = Math.min(...cs.map((p) => p[1]));
  const bw = Math.max(...cs.map((p) => p[0])) - x0;
  const bh = Math.max(...cs.map((p) => p[1])) - y0;
  const k = Math.min(1, Math.sqrt(maxPixels / (bw * bh)));
  const OW = Math.max(1, Math.round(bw * k));
  const OH = Math.max(1, Math.round(bh * k));
  const src = rgb.data;
  // the table's colour: the mean of the photo's outer 2% frame
  const fill = [0, 0, 0];
  let cnt = 0;
  const bx = Math.max(1, Math.round(0.02 * W));
  const by = Math.max(1, Math.round(0.02 * H));
  for (let yy = 0; yy < H; yy += 4) {
    for (let xx = 0; xx < W; xx += 4) {
      if (xx >= bx && xx < W - bx && yy >= by && yy < H - by) continue;
      const i = 3 * (yy * W + xx);
      fill[0] += src[i];
      fill[1] += src[i + 1];
      fill[2] += src[i + 2];
      cnt++;
    }
  }
  const fc = fill.map((v) => Math.round(v / Math.max(1, cnt)));
  const out = new Uint8Array(OW * OH * 3);
  for (let v = 0; v < OH; v++) {
    for (let uu = 0; uu < OW; uu++) {
      const [sx, sy] = m.inv(x0 + (uu + 0.5) / k, y0 + (v + 0.5) / k);
      const X = sx - 0.5;
      const Y = sy - 0.5;
      const o = 3 * (v * OW + uu);
      if (!(X >= 0 && Y >= 0 && X < W - 1 && Y < H - 1)) {
        out[o] = fc[0];
        out[o + 1] = fc[1];
        out[o + 2] = fc[2];
        continue;
      }
      const xi = X | 0;
      const yi = Y | 0;
      const fx = X - xi;
      const fy = Y - yi;
      const i = 3 * (yi * W + xi);
      const j = i + 3 * W;
      for (let ch = 0; ch < 3; ch++) {
        const a = src[i + ch] + (src[i + 3 + ch] - src[i + ch]) * fx;
        const b = src[j + ch] + (src[j + 3 + ch] - src[j + ch]) * fx;
        out[o + ch] = Math.round(a + (b - a) * fy);
      }
    }
  }
  return { rgb: { width: OW, height: OH, data: out }, tiltDeg: m.tiltDeg };
}
