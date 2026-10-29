// Text lines across a seam. On a printed or typed page, the lines of two pieces that belong together continue into
// each other: the same direction, the same pitch, and the same phase (a line on one side meets a line on the other,
// not the gap between two). Each piece's line grid is measured once (orientation.ts); a candidate join (pose b → a)
// then predicts where b's lines land in a's frame, and the mismatch is cheap to compute.

import { axialDiff, poseApply, poseInvert, type Pose } from "./geom";
import type { Fragment } from "./types";

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
 * How well the text lines of b, placed by `pose` (b's photo → a's photo), continue a's at the point `at` (a's photo
 * coordinates, normally the seam's middle). Null when either piece has no trusted line grid.
 */
export function textAgreement(a: Fragment, b: Fragment, pose: Pose, at: [number, number]): TextAgreement | null {
  const ga = photoGrid(a);
  const gb = photoGrid(b);
  if (!ga || !gb || !ga.weight || !gb.weight) return null;
  const angle = axialDiff(ga.angle, gb.angle + pose.theta);
  // fractional line position of the seam point on each side
  const ra = -at[0] * Math.sin(ga.angle) + at[1] * Math.cos(ga.angle);
  const fa = (ra - ga.offset) / ga.period;
  const [bx, by] = poseApply(poseInvert(pose), at[0], at[1]);
  const rb = -bx * Math.sin(gb.angle) + by * Math.cos(gb.angle);
  const fb = (rb - gb.offset) / gb.period;
  // b's normal, turned into a's frame, may point the other way along a's normal: then b's r runs backwards
  const nbx = -Math.sin(gb.angle + pose.theta);
  const nby = Math.cos(gb.angle + pose.theta);
  const sign = nbx * -Math.sin(ga.angle) + nby * Math.cos(ga.angle) >= 0 ? 1 : -1;
  let phase = fa - sign * fb;
  phase -= Math.round(phase);
  return { angle, phase, pitchRatio: gb.period / ga.period, weight: Math.min(ga.weight, gb.weight) };
}
