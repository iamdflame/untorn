// Text lines across a seam. On a printed or typed page, the lines of two pieces that belong together continue into
// each other: the same direction, the same pitch, and the same phase (a line on one side meets a line on the other,
// not the gap between two). Each piece's line grid is measured once (orientation.ts); a candidate join (pose b → a)
// then predicts where b's lines land in a's frame, and the mismatch is cheap to compute.

import { axialDiff, poseApply, poseInvert, type Pose } from "./geom";
import type { Fragment, TextCheck } from "./types";

export type TextAgreement = {
  /** Angle between the two pieces' text lines once joined (rad, axial). */
  angle: number;
  /** Line phase mismatch at the seam, as a fraction of the line pitch (−0.5…0.5). */
  phase: number;
  /** b's line pitch over a's (photo px): ≠ 1 when the pieces were photographed at different scales. */
  pitchRatio: number;
  /** 0–1: how far both line grids can be trusted. */
  weight: number;
};

/**
 * The line pitch most pieces of the photo agree on (median of the clear, regular grids), or null. A piece whose grid
 * is off it has locked onto something else (typewriter columns, every other line, a heading), and its text angle is
 * then not to be trusted: on Bench-S, 58 of 63 wrong text angles are caught this way, 64% of right ones kept.
 */
export function lineConsensus(frags: Fragment[]): number | null {
  const ps = frags
    .map((f) => f.text)
    .filter((t) => !!t && !!t.grid && t.confidence >= 0.5 && t.grid.regularity >= 0.3)
    .map((t) => t!.grid!.period)
    .sort((a, b) => a - b);
  return ps.length >= 2 ? ps[Math.floor(ps.length / 2)] : null;
}

/** May a piece's text angle and line grid be relied on for the text-line test? */
export function gridTrusted(f: Fragment, consensus: number | null): boolean {
  const t = f.text;
  return !!t && !!t.grid && consensus !== null && t.confidence >= 0.5 && t.grid.regularity >= 0.35 && Math.abs(t.grid.period / consensus - 1) < 0.12;
}

/** The piece's line grid in photo coordinates: lines at r = offset + j·period, r = −x·sin(angle) + y·cos(angle). */
export function photoGrid(f: Fragment): { angle: number; period: number; offset: number; weight: number } | null {
  const t = f.text;
  if (!t || !t.grid) return null;
  const s = Math.sin(t.angle);
  const c = Math.cos(t.angle);
  const offset = t.grid.offset + (-f.input.x0 * s + f.input.y0 * c);
  // trust needs a clear text angle and a regular line period
  const weight = Math.max(0, Math.min(1, (t.confidence - 0.3) / 0.5)) * Math.max(0, Math.min(1, (t.grid.regularity - 0.2) / 0.25));
  return { angle: t.angle, period: t.grid.period, offset, weight };
}

/**
 * The line offset (photo coordinates, as in photoGrid) measured locally: from the ink within `radius` px of (x, y),
 * at the piece's own direction and period. Paragraph gaps and a period a few percent off shift the piece's global
 * grid by up to half a line a few lines away; the lines right at the seam are what must continue. Null when the
 * lines there are not clear (too little ink, or no regular lines within reach).
 */
export function localLineOffset(f: Fragment, x: number, y: number, radius: number): number | null {
  const t = f.text;
  const img = f.input.rgba;
  if (!t || !t.grid || !img) return null;
  const { mask, x0, y0 } = f.input;
  const level = f.paper ? 0.299 * f.paper[0] + 0.587 * f.paper[1] + 0.114 * f.paper[2] : null;
  if (level === null) return null;
  const s = Math.sin(t.angle);
  const c = Math.cos(t.angle);
  const w = (2 * Math.PI) / t.grid.period;
  let re = 0;
  let im = 0;
  let tot = 0;
  const c0 = Math.max(0, Math.floor(x - x0 - radius));
  const c1 = Math.min(mask.width - 1, Math.ceil(x - x0 + radius));
  const r0 = Math.max(0, Math.floor(y - y0 - radius));
  const r1 = Math.min(mask.height - 1, Math.ceil(y - y0 + radius));
  for (let r = r0; r <= r1; r++) {
    for (let col = c0; col <= c1; col++) {
      const i = r * mask.width + col;
      if (!mask.data[i] || f.depth[i] < 3) continue;
      const px = x0 + col + 0.5;
      const py = y0 + r + 0.5;
      if ((px - x) ** 2 + (py - y) ** 2 > radius * radius) continue;
      const lum = 0.299 * img.data[4 * i] + 0.587 * img.data[4 * i + 1] + 0.114 * img.data[4 * i + 2];
      const dark = Math.min(1, (level - lum - 28) / 60);
      if (dark <= 0) continue;
      const rr = -px * s + py * c;
      re += dark * Math.cos(w * rr);
      im -= dark * Math.sin(w * rr);
      tot += dark;
    }
  }
  // enough ink for a line or two, and clearly periodic
  if (tot < 0.15 * t.grid.period * t.grid.period || Math.hypot(re, im) < 0.25 * tot) return null;
  let off = (-Math.atan2(im, re) * t.grid.period) / (2 * Math.PI);
  off -= t.grid.period * Math.floor(off / t.grid.period);
  return off;
}

/**
 * How well the text lines of b, placed by `pose` (b's photo → a's photo), continue a's at the point `at` (a's photo
 * coordinates, normally the seam's middle). Null when either piece has no trusted line grid. The line phase is taken
 * from the ink near the seam on each side when that is clear, else from the pieces' whole grids.
 */
export function textAgreement(a: Fragment, b: Fragment, pose: Pose, at: [number, number]): TextAgreement | null {
  const ga = photoGrid(a);
  const gb = photoGrid(b);
  if (!ga || !gb || !ga.weight || !gb.weight) return null;
  const angle = axialDiff(ga.angle, gb.angle + pose.theta);
  // fractional line position of the seam point on each side
  const [bx, by] = poseApply(poseInvert(pose), at[0], at[1]);
  const offA = localLineOffset(a, at[0], at[1], 2.5 * ga.period) ?? ga.offset;
  const offB = localLineOffset(b, bx, by, 2.5 * gb.period) ?? gb.offset;
  const ra = -at[0] * Math.sin(ga.angle) + at[1] * Math.cos(ga.angle);
  const fa = (ra - offA) / ga.period;
  const rb = -bx * Math.sin(gb.angle) + by * Math.cos(gb.angle);
  const fb = (rb - offB) / gb.period;
  // b's normal, turned into a's frame, may point the other way along a's normal: then b's r runs backwards
  const nbx = -Math.sin(gb.angle + pose.theta);
  const nby = Math.cos(gb.angle + pose.theta);
  const sign = nbx * -Math.sin(ga.angle) + nby * Math.cos(ga.angle) >= 0 ? 1 : -1;
  let phase = fa - sign * fb;
  phase -= Math.round(phase);
  return { angle, phase, pitchRatio: gb.period / ga.period, weight: Math.min(ga.weight, gb.weight) };
}

/** Spread of the line direction (rad) and phase (pitch fractions) on true joins of real photos (S7: ≤ 2.7°, ≤ 0.18). */
const SIGMA_ANGLE = (1.5 * Math.PI) / 180;
const SIGMA_PHASE = 0.1;

/**
 * The text-line test of a candidate join: direction, phase, pitch, whether the join turns a piece upside down, and the
 * evidence as a log-likelihood ratio against a chance alignment (direction uniform over 90°, phase uniform), scaled by
 * how far both line grids can be trusted. The direction and phase count only when both grids sit on the photo's line
 * pitch (`consensus`; a grid locked onto columns or a harmonic says nothing), the turn only when both up votes are
 * clear. Null without line grids.
 */
export function textCheck(a: Fragment, b: Fragment, pose: Pose, at: [number, number], consensus: number | null): TextCheck | null {
  const t = textAgreement(a, b, pose, at);
  if (!t) return null;
  const ta = a.text!;
  const tb = b.text!;
  // both grids on the photo's line pitch: the direction and the phase count
  const angleValid = gridTrusted(a, consensus) && gridTrusted(b, consensus);
  const phaseValid = angleValid && t.pitchRatio >= 0.87 && t.pitchRatio <= 1.15;
  let flipped = false;
  let upTerm = 0;
  if (ta.up !== 0 && tb.up !== 0 && ta.upConfidence >= 0.75 && tb.upConfidence >= 0.75) {
    const ra = ta.angle + (ta.up === -1 ? Math.PI : 0);
    const rb = tb.angle + (tb.up === -1 ? Math.PI : 0) + pose.theta;
    flipped = Math.cos(ra - rb) < 0;
    upTerm = flipped ? -4 : 0.6;
  }
  const angleTerm = angleValid
    ? Math.max(-6, Math.log(2 / (SIGMA_ANGLE * Math.sqrt(2 * Math.PI))) - (t.angle * t.angle) / (2 * SIGMA_ANGLE * SIGMA_ANGLE) - Math.log(2 / Math.PI))
    : 0;
  const phaseTerm = phaseValid ? Math.max(-5, Math.log(1 / (SIGMA_PHASE * Math.sqrt(2 * Math.PI))) - (t.phase * t.phase) / (2 * SIGMA_PHASE * SIGMA_PHASE)) : 0;
  return { ...t, angleValid, phaseValid, flipped, logLR: t.weight * (angleTerm + phaseTerm + upTerm) };
}
