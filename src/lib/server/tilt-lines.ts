// The camera's tilt from the pieces' own text lines, for photos that don't record it (most Android phones, and any
// copy a messaging app has re-encoded). Seen at an angle, far pieces look smaller and their text lines sit closer
// together; on a flat table every piece of one page has the same line spacing. So the rotation about the camera centre
// after which the spacing is the same everywhere is the tilt, and straightening with it is the same one-rotation warp
// as the phone's gravity reading (src/lib/server/rectify.ts).
//
// Measured on the user's photos (.apex/build/REAL-SET.md): on the iPhone photo shot 11.6° off straight down, the
// spacing spread 12.2% across the pieces; the lines alone put the tilt at 15°, about 3° from the phone's own reading,
// and left 3.5% (the phone's reading leaves 4.2%). A messaging-app copy of another page (no EXIF) spread 10.9% and fit
// a 15° tilt down to 4.0%. On photos taken nearly straight down (1.4° by the phone, and the 11.6° photo once
// straightened) a tilt of 4–6° also "fits", but only trims the spread from about 4% to 3%: noise. So it straightens only
// when the spread is large, one tilt explains most of it, nearly every piece agrees and no single piece makes the
// tilt. Those rules leave alone every flat photo we have: the four samples, the five flat real photos and the 56
// simulated photos of Bench-S with an estimate (scratchpad tilt-check.mts, tilt-bench.mts).

import type { Fragment } from "@/lib/rejoin/types";
import { focalPx, rotationMap } from "./rectify";

/** One piece's text lines: centroid (photo px), line direction (rad), line spacing (photo px), and trust (0–1). */
export type LineSample = { x: number; y: number; angle: number; period: number; weight: number };

/** The pieces whose text lines are clearly regular, in photo px (the solver analyses them at working scale `k`). */
export function lineSamples(fragments: Fragment[], k: number): LineSample[] {
  return fragments.flatMap((f) => {
    const t = f.text;
    if (!t?.grid || t.confidence < 0.5 || t.grid.regularity < 0.3) return [];
    return [{ x: f.centroid[0] / k, y: f.centroid[1] / k, angle: t.angle, period: t.grid.period / k, weight: t.confidence * t.grid.regularity }];
  });
}

export type LineTilt = {
  /** Gravity in the camera's axes (x across the photo, y down it, z out of the lens), for rotationMap. */
  gravity: [number, number, number];
  tiltDeg: number;
  /** Weighted RMS of the log line spacing across the pieces: as photographed, and once straightened. */
  spreadBefore: number;
  spreadAfter: number;
  /** Pieces that agree once straightened, of those measured. */
  pieces: number;
  measured: number;
  /** The spread is large, one tilt explains it, and the tilt matters... */
  evident: boolean;
  /** ...and it holds without any single piece: straighten the photo. */
  straighten: boolean;
};

/** A phone's main camera when the photo doesn't say (iPhones 24–26 mm, most Android phones 23–26 mm). */
export const DEFAULT_F35 = 26;
/** Fewest pieces with regular lines for an estimate, and fewest agreeing ones to act on it. */
export const MIN_PIECES = 5;
export const MIN_AGREEING = 6;
export const AGREE_SHARE = 0.85;
/**
 * With any one piece left out, the tilt found must stay within this (degrees between the two directions). A tilt one
 * piece makes moves by about its whole size without it (22° on a flat sample); a real one moves by a few degrees (on
 * the messaging-app copy, near 4°, so a tighter limit flipped between two runs of the same photo).
 */
const LOO_DEG = 6;
/** Straighten only when the spacing spreads at least this much as photographed (near-flat photos: about 4%)... */
export const MIN_SPREAD = 0.07;
/** ...one tilt removes at least half of it, and leaves no more than this... */
export const MAX_RESIDUAL = 0.05;
/** ...and the tilt is large enough to matter (the solver absorbs a few degrees). */
export const MIN_LINE_TILT_DEG = 6;
/** The search's limit: a phone held over a table is rarely further off; beyond it, fits are chance. */
export const MAX_LINE_TILT_DEG = 22;
/** A piece whose straightened spacing is this far from the others' (log, about 15%) is an outlier. */
const OUTLIER = Math.log(1.15);

const g3 = (thDeg: number, psDeg: number): [number, number, number] => {
  const th = (thDeg * Math.PI) / 180;
  const ps = (psDeg * Math.PI) / 180;
  return [Math.sin(th) * Math.cos(ps), Math.sin(th) * Math.sin(ps), Math.cos(th)];
};

export function tiltFromLines(samples: LineSample[], width: number, height: number, f35 = DEFAULT_F35): LineTilt | null {
  const pts = samples.filter((s) => s.period > 0 && s.weight > 0 && Number.isFinite(s.angle));
  if (pts.length < MIN_PIECES) return null;
  const f = focalPx(width, height, f35);
  // each piece's log line spacing seen straight down: the distance from its line to the next one, measured across the
  // straightened line direction (the warp is not a similarity, so both are mapped)
  const logsAt = (g: [number, number, number]) => {
    const m = rotationMap(width, height, f, g);
    return pts.map((s) => {
      const tx = Math.cos(s.angle);
      const ty = Math.sin(s.angle);
      const A = m.fwd(s.x, s.y);
      const N = m.fwd(s.x - s.period * ty, s.y + s.period * tx);
      const T = m.fwd(s.x + 50 * tx, s.y + 50 * ty);
      const tl = Math.hypot(T[0] - A[0], T[1] - A[1]);
      return Math.log(Math.abs(((T[0] - A[0]) * (N[1] - A[1]) - (T[1] - A[1]) * (N[0] - A[0])) / tl));
    });
  };
  // A piece can lock onto a harmonic of its lines (half or 1.5× the spacing) or carry a letterhead's: on the samples one
  // or two pieces in ten did, the rest agreeing within 1%. So the fit is robust: a piece more than OUTLIER off the
  // others' spacing counts as OUTLIER, whatever its error.
  const all = pts.map((_, i) => i);
  const cost = (logs: number[], idx: number[]) => {
    const mid = weightedMedian(idx.map((i) => logs[i]), idx.map((i) => pts[i].weight));
    let c = 0;
    let w = 0;
    for (const i of idx) {
      c += pts[i].weight * Math.min((logs[i] - mid) ** 2, OUTLIER ** 2);
      w += pts[i].weight;
    }
    return c / w;
  };
  const search = (idx: number[], step: number, fine: boolean) => {
    let best = { th: 0, ps: 0, c: cost(logsAt([0, 0, 1]), idx) };
    for (let th = step; th <= MAX_LINE_TILT_DEG; th += step) {
      for (let ps = 0; ps < 360; ps += 4 * step) {
        const c = cost(logsAt(g3(th, ps)), idx);
        if (c < best.c) best = { th, ps, c };
      }
    }
    if (fine && best.th > 0) {
      const s = { ...best };
      for (let th = s.th - step; th <= s.th + step; th += 0.05) {
        for (let ps = s.ps - 4 * step; ps <= s.ps + 4 * step; ps += 0.2) {
          const c = cost(logsAt(g3(th, ps)), idx);
          if (c < best.c) best = { th, ps, c };
        }
      }
    }
    return best;
  };
  const best = search(all, 0.5, true);
  // judged on the pieces that agree once straightened: how much they spread as photographed, and after
  const gravity = g3(best.th, best.ps);
  const after = logsAt(gravity);
  const mid = weightedMedian(after, pts.map((s) => s.weight));
  const inl = after.map((v, i) => i).filter((i) => Math.abs(after[i] - mid) <= OUTLIER);
  const flat = logsAt([0, 0, 1]);
  const rms = (logs: number[]) => {
    const w = inl.reduce((a, i) => a + pts[i].weight, 0);
    const mean = inl.reduce((a, i) => a + pts[i].weight * logs[i], 0) / w;
    return Math.sqrt(inl.reduce((a, i) => a + pts[i].weight * (logs[i] - mean) ** 2, 0) / w);
  };
  const spreadBefore = rms(flat);
  const spreadAfter = rms(after);
  // nearly every piece must agree: one page shares one spacing (the tilted photos: 9 of 9), while a tilt that "fits" a
  // stack of different documents leaves several out (a simulated stack of three: 10 of 13 at a chance 18.6°)
  const evident =
    inl.length >= MIN_AGREEING &&
    inl.length >= AGREE_SHARE * pts.length &&
    spreadBefore >= MIN_SPREAD &&
    spreadAfter <= spreadBefore / 2 &&
    spreadAfter <= MAX_RESIDUAL &&
    best.th >= MIN_LINE_TILT_DEG;
  // and no single piece makes the tilt: it must hold with any one of them left out (on a flat sample, one piece reading
  // 28 px lines among 19 px ones "fit" a 22° tilt that vanished without it)
  const stable =
    evident &&
    inl.every((drop) => {
      const b = search(all.filter((i) => i !== drop), 1, false);
      const g = g3(b.th, b.ps);
      return (Math.acos(Math.min(1, g[0] * gravity[0] + g[1] * gravity[1] + g[2] * gravity[2])) * 180) / Math.PI <= LOO_DEG;
    });
  return { gravity, tiltDeg: best.th, spreadBefore, spreadAfter, pieces: inl.length, measured: pts.length, evident, straighten: stable };
}

function weightedMedian(v: number[], w: number[]): number {
  const order = v.map((_, i) => i).sort((a, b) => v[a] - v[b]);
  const half = w.reduce((a, b) => a + b, 0) / 2;
  let acc = 0;
  for (const i of order) {
    acc += w[i];
    if (acc >= half) return v[i];
  }
  return v[order[order.length - 1]];
}
