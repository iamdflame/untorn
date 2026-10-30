// Text-line orientation of a fragment from its pixels: a projection-profile search over angles (lines of ink make the
// profile peaky when projected along them). The angle is ambiguous by 180°; an ascender/descender asymmetry vote
// (Latin script has more ascenders than descenders) says which way is up when the evidence is clear.

import { localPaperLevel, luminance, paperTone } from "./raster";
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
  /**
   * The line grid at sub-pixel precision, when the profile is periodic: text lines are centred at r = offset + j·period,
   * r = −x·sin(angle) + y·cos(angle) in the crop's pixel coordinates (crop pixel (c, r) covers [c, c+1) × [r, r+1)).
   * `regularity` is the strength of that period in the ink profile (0–1).
   */
  grid: { period: number; offset: number; regularity: number } | null;
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
  /**
   * Measure ink against the local paper level within this radius (px) instead of one level per piece, so shadows,
   * curl and vignetting are not read as ink (0: one level per piece).
   */
  localPaper?: number;
};

export function textOrientation(
  img: Rgba,
  mask: Mask,
  depth: Float32Array,
  opts: OrientationOptions = {},
): TextOrientation | null {
  const { margin = 6, localPaper = 6 } = opts;
  const lum = luminance(img);
  const tone = paperTone(img, lum, depth, margin);
  if (!tone) return null;
  const plain = orientationWith(lum, tone.level, null, mask, depth, opts);
  // Shadows, curl and vignetting read as ink against one paper level per piece. When that reading is weak, measure ink
  // against the local paper level instead; switch only when that is clearly stronger and its lines clearly regular
  // (on small pieces the local level can also lock onto a confident wrong angle with irregular lines).
  if (localPaper > 0 && (!plain || plain.confidence < 0.6)) {
    const local = orientationWith(lum, tone.level, localPaperLevel(lum, mask.data, mask.width, mask.height, localPaper), mask, depth, opts);
    if (local && local.confidence >= (plain?.confidence ?? 0) + 0.3 && (local.grid?.regularity ?? 0) >= 0.35) return local;
  }
  return plain;
}

function orientationWith(
  lum: Float32Array,
  paperLevel: number,
  local: Float32Array | null,
  mask: Mask,
  depth: Float32Array,
  opts: OrientationOptions,
): TextOrientation | null {
  const { margin = 6, minInk = 120, maxSamples = 40000 } = opts;
  const tone = { level: paperLevel };
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
      const level = local && Number.isFinite(local[i]) ? Math.min(local[i], tone.level + 25) : tone.level;
      const dark = level - lum[i] - 28;
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
  const refineAt = (deg: number): [number, number] => {
    let angle = (deg * Math.PI) / 180;
    let val = coarse[deg];
    for (let t = -1; t <= 1.0001; t += 0.1) {
      const a = ((deg + t) * Math.PI) / 180;
      const v = crit(a);
      if (v > val) {
        val = v;
        angle = a;
      }
    }
    return [angle, val];
  };
  const profileAt = (a: number) => {
    hist.fill(0);
    const s = Math.sin(a);
    const c = Math.cos(a);
    for (let k = 0; k < n; k++) hist[Math.round(-X[k] * s + Y[k] * c) + R] += W[k];
  };
  let [bestAngle, bestVal] = refineAt(best);
  // A narrow piece projected along its length can be as peaky as along its short text lines; only text lines are
  // periodic at the line pitch. Among the strong peaks, prefer the one whose profile has a regular line period.
  const rivals: number[] = [];
  for (let d = 0; d < 180; d++) {
    const v = coarse[d];
    if (d === best || v < 0.4 * coarse[best] || v < coarse[(d + 179) % 180] || v < coarse[(d + 1) % 180]) continue;
    if (Math.min(Math.abs(d - best), 180 - Math.abs(d - best)) <= 3) continue;
    rivals.push(d);
  }
  if (rivals.length) {
    const regularityAt = (a: number) => {
      profileAt(a);
      const p = linePitch(hist);
      return p ? (lineGrid(hist, R, p)?.regularity ?? 0) : 0;
    };
    let bestScore = bestVal * (0.1 + regularityAt(bestAngle));
    for (const d of rivals.sort((x, y) => coarse[y] - coarse[x]).slice(0, 3)) {
      const [a, v] = refineAt(d);
      const score = v * (0.1 + regularityAt(a));
      if (score > bestScore) {
        bestScore = score;
        bestAngle = a;
        bestVal = v;
      }
    }
  }
  const sorted = Array.from(coarse).sort((a, b) => a - b);
  const median = sorted[90];
  const strength = bestVal / median;
  // Profile at the chosen angle, for the pitch and the up/down vote.
  profileAt(bestAngle);
  const s = Math.sin(bestAngle);
  const c = Math.cos(bestAngle);
  const pitch = linePitch(hist);
  const { up, conf } = upDown(hist, pitch);
  let angle = bestAngle % Math.PI;
  if (angle < 0) angle += Math.PI;
  const confidence = Math.max(0, Math.min(1, (strength - 1.25) / 1.0)) * Math.min(1, n / (3 * minInk));
  let grid: TextOrientation["grid"] = null;
  if (pitch) {
    const g = lineGrid(hist, R, pitch);
    if (g) {
      // centred r → crop r: add the centroid's r. Folding bestAngle into [0, π) flips the normal, and r with it.
      const sgn = Math.abs(angle - bestAngle) < 1e-9 ? 1 : -1;
      let offset = sgn * (g.offset + (-cx * s + cy * c));
      offset -= g.period * Math.floor(offset / g.period);
      grid = { period: g.period, offset, regularity: g.regularity };
    }
  }
  return { angle, strength, confidence, pitch, grid, up, upConfidence: conf, ink: xs.length };
}

/**
 * The strongest Fourier component of an ink profile (bins at integer r, centred at index R) near a coarse pitch:
 * the line period at sub-pixel precision, and the offset of the line centres (in the profile's centred r).
 */
export function lineGrid(profile: Float64Array, R: number, pitch0: number): { period: number; offset: number; regularity: number } | null {
  let total = 0;
  for (let b = 0; b < profile.length; b++) total += profile[b];
  if (total <= 0) return null;
  const component = (p: number): [number, number] => {
    const w = (2 * Math.PI) / p;
    let re = 0;
    let im = 0;
    for (let b = 0; b < profile.length; b++) {
      const v = profile[b];
      if (!v) continue;
      re += v * Math.cos(w * (b - R));
      im -= v * Math.sin(w * (b - R));
    }
    return [re, im];
  };
  let best = pitch0;
  let bestMag = -1;
  const scan = (from: number, to: number, step: number) => {
    for (let p = from; p <= to + 1e-9; p += step) {
      const [re, im] = component(p);
      const mag = re * re + im * im;
      if (mag > bestMag) {
        bestMag = mag;
        best = p;
      }
    }
  };
  // the autocorrelation pitch is biased low (fewer overlapping terms at longer lags): search −8% … +15%
  const step = 0.002 * pitch0;
  scan(Math.max(4, 0.92 * pitch0), 1.15 * pitch0, step);
  scan(best - step, best + step, step / 10);
  const [re, im] = component(best);
  // F = Σ v·e^(−iωr): ink concentrated at r0 + j·p gives arg F = −ω·r0
  let offset = (-Math.atan2(im, re) * best) / (2 * Math.PI);
  offset -= best * Math.floor(offset / best);
  return { period: best, offset, regularity: Math.sqrt(bestMag) / total };
}

/** The dominant period (px) of a projection profile, from its autocorrelation, or null. */
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
  const maxLag = Math.min(160, Math.floor(q.length / 2));
  let bestLag = 0;
  let bestVal = 0.15;
  let prev = 1;
  let falling = true;
  for (let lag = 6; lag <= maxLag; lag++) {
    let a = 0;
    for (let i = 0; i + lag < q.length; i++) a += q[i] * q[i + lag];
    a /= a0;
    if (falling && a > prev) falling = false;
    if (!falling && a > bestVal) {
      bestVal = a;
      bestLag = lag;
    }
    if (!falling && bestLag && a < bestVal - 0.15) break;
    prev = a;
  }
  return bestLag || null;
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
