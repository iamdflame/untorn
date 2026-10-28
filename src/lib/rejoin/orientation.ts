// Text-line orientation of a fragment from its pixels: a projection-profile search over angles (lines of ink make the
// profile peaky when projected along them). The angle is ambiguous by 180°; an ascender/descender asymmetry vote
// (Latin script has more ascenders than descenders) says which way is up when the evidence is clear.

import { luminance, paperTone } from "./raster";
import type { Mask, Rgba } from "./types";

export type TextOrientation = {
  /** Direction of the text lines (rad, axial: angle and angle + π are the same lines), in the crop/photo frame. */
  angle: number;
  /** Projection criterion at the best angle ÷ its median over all angles (1 = no lines). */
  strength: number;
  /** 0–1. */
  confidence: number;
  /** Line pitch (px) when the profile is periodic. */
  pitch: number | null;
  /** +1: reading direction is `angle` (ascenders toward −perpendicular); −1: it is angle + π; 0: unknown. */
  up: -1 | 0 | 1;
  upConfidence: number;
  /** Ink pixels used. */
  ink: number;
};

export type OrientationOptions = {
  /** Ignore pixels closer than this to the piece's edge (px): shadows, fibre rims. */
  margin?: number;
  /** Fewest ink pixels for an estimate. */
  minInk?: number;
  /** Most ink pixels sampled. */
  maxSamples?: number;
};

export function textOrientation(
  img: Rgba,
  mask: Mask,
  depth: Float32Array,
  opts: OrientationOptions = {},
): TextOrientation | null {
  const { margin = 6, minInk = 120, maxSamples = 40000 } = opts;
  const lum = luminance(img);
  const tone = paperTone(img, lum, depth, margin);
  if (!tone) return null;
  const w = mask.width;
  const h = mask.height;
  // Ink: pixels clearly darker than the paper, weighted by how much darker.
  const xs: number[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (depth[i] < margin) continue;
      const dark = tone.level - lum[i] - 28;
      if (dark <= 0) continue;
      xs.push(x + 0.5);
      ys.push(y + 0.5);
      ws.push(Math.min(1, dark / 60));
    }
  }
  if (xs.length < minInk) return null;
  const stride = Math.max(1, Math.ceil(xs.length / maxSamples));
  const n = Math.ceil(xs.length / stride);
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  const W = new Float64Array(n);
  let cx = 0;
  let cy = 0;
  for (let k = 0, i = 0; i < xs.length; i += stride, k++) {
    X[k] = xs[i];
    Y[k] = ys[i];
    W[k] = ws[i];
    cx += xs[i];
    cy += ys[i];
  }
  cx /= n;
  cy /= n;
  for (let k = 0; k < n; k++) {
    X[k] -= cx;
    Y[k] -= cy;
  }
  const R = Math.ceil(Math.hypot(w, h)) + 2;
  const hist = new Float64Array(2 * R + 1);
  const crit = (theta: number) => {
    hist.fill(0);
    const s = Math.sin(theta);
    const c = Math.cos(theta);
    let tot = 0;
    for (let k = 0; k < n; k++) {
      const r = -X[k] * s + Y[k] * c;
      hist[Math.round(r) + R] += W[k];
      tot += W[k];
    }
    let ss = 0;
    for (let b = 0; b < hist.length; b++) ss += hist[b] * hist[b];
    return ss / (tot * tot);
  };
  const coarse = new Float64Array(180);
  let best = 0;
  for (let d = 0; d < 180; d++) {
    coarse[d] = crit((d * Math.PI) / 180);
    if (coarse[d] > coarse[best]) best = d;
  }
  let bestAngle = (best * Math.PI) / 180;
  let bestVal = coarse[best];
  for (let t = -1; t <= 1.0001; t += 0.1) {
    const a = ((best + t) * Math.PI) / 180;
    const v = crit(a);
    if (v > bestVal) {
      bestVal = v;
      bestAngle = a;
    }
  }
  const sorted = Array.from(coarse).sort((a, b) => a - b);
  const median = sorted[90];
  const strength = bestVal / median;
  // Profile at the best angle, for the pitch and the up/down vote.
  hist.fill(0);
  const s = Math.sin(bestAngle);
  const c = Math.cos(bestAngle);
  for (let k = 0; k < n; k++) hist[Math.round(-X[k] * s + Y[k] * c) + R] += W[k];
  const pitch = linePitch(hist);
  const { up, conf } = upDown(hist, pitch);
  let angle = bestAngle % Math.PI;
  if (angle < 0) angle += Math.PI;
  const confidence = Math.max(0, Math.min(1, (strength - 1.25) / 1.0)) * Math.min(1, n / (3 * minInk));
  return { angle, strength, confidence, pitch, up, upConfidence: conf, ink: xs.length };
}

/**
 * The dominant period (px) of a projection profile, from its autocorrelation, or null: the first autocorrelation peak
 * that comes close to the strongest one. (At high resolution a text line's own structure, the top and foot of the
 * x-height band, makes early minor peaks; a later peak at twice the pitch is a harmonic.)
 */
function linePitch(p: Float64Array): number | null {
  const n = p.length;
  let lo = 0;
  let hi = n - 1;
  while (lo < n && p[lo] === 0) lo++;
  while (hi > lo && p[hi] === 0) hi--;
  if (hi - lo < 30) return null;
  const q = new Float64Array(hi - lo + 1);
  let m = 0;
  for (let i = lo; i <= hi; i++) m += p[i];
  m /= q.length;
  for (let i = lo; i <= hi; i++) q[i - lo] = p[i] - m;
  let a0 = 0;
  for (let i = 0; i < q.length; i++) a0 += q[i] * q[i];
  if (a0 <= 0) return null;
  const maxLag = Math.min(320, Math.floor(q.length / 2));
  const ac = new Float64Array(maxLag + 2);
  for (let lag = 6; lag <= maxLag + 1 && lag < q.length; lag++) {
    let a = 0;
    for (let i = 0; i + lag < q.length; i++) a += q[i] * q[i + lag];
    ac[lag] = a / a0;
  }
  // local maxima after the autocorrelation first stops falling
  const peaks: number[] = [];
  let lag = 7;
  while (lag <= maxLag && ac[lag] <= ac[lag - 1]) lag++;
  for (; lag <= maxLag; lag++) if (ac[lag] > 0.15 && ac[lag] >= ac[lag - 1] && ac[lag] > ac[lag + 1]) peaks.push(lag);
  if (!peaks.length) return null;
  const top = Math.max(...peaks.map((k) => ac[k]));
  return peaks.find((k) => ac[k] >= 0.8 * top) ?? null;
}

/** Ascender vs descender ink around each text line: more ink just above the x-height band means upright. */
function upDown(profile: Float64Array, pitch: number | null): { up: -1 | 0 | 1; conf: number } {
  if (!pitch || pitch < 8) return { up: 0, conf: 0 };
  const n = profile.length;
  const sm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    let w = 0;
    for (let d = -1; d <= 1; d++) {
      const j = i + d;
      if (j < 0 || j >= n) continue;
      const k = d === 0 ? 2 : 1;
      s += k * profile[j];
      w += k;
    }
    sm[i] = s / w;
  }
  let gmax = 0;
  for (let i = 0; i < n; i++) gmax = Math.max(gmax, sm[i]);
  if (gmax <= 0) return { up: 0, conf: 0 };
  const sep = Math.max(4, Math.round(0.6 * pitch));
  let low = 0;
  let high = 0;
  let lines = 0;
  for (let i = 1; i < n - 1; i++) {
    const v = sm[i];
    if (v < 0.3 * gmax) continue;
    let isPeak = true;
    for (let d = -sep; d <= sep && isPeak; d++) {
      const j = i + d;
      if (d && j >= 0 && j < n && (sm[j] > v || (sm[j] === v && d < 0))) isPeak = false;
    }
    if (!isPeak) continue;
    let v1 = i;
    let v2 = i;
    while (v1 > 0 && sm[v1 - 1] >= 0.5 * v) v1--;
    while (v2 < n - 1 && sm[v2 + 1] >= 0.5 * v) v2++;
    const x = v2 - v1 + 1;
    const z = Math.max(2, Math.min(Math.round(0.9 * x), Math.floor(pitch / 2 - x / 2)));
    let a = 0;
    let b = 0;
    for (let d = 1; d <= z; d++) {
      if (v1 - d >= 0) a += sm[v1 - d];
      if (v2 + d < n) b += sm[v2 + d];
    }
    low += a;
    high += b;
    lines++;
  }
  if (lines < 1 || low + high <= 0) return { up: 0, conf: 0 };
  const score = (low - high) / (low + high);
  const conf = Math.min(1, Math.abs(score) / 0.3) * Math.min(1, lines / 3);
  if (Math.abs(score) < 0.08) return { up: 0, conf };
  return { up: score > 0 ? 1 : -1, conf };
}
