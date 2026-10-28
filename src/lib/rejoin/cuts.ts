// Straight cuts (scissors, guillotines, the Voronoi cuts of ShredBench) have no ragged shape to match: two cut edges
// fit any other two of the same direction. What pins a cut join is where its ends fall: a cut edge runs from corner to
// corner, so equal-length edges align end to end, and a shorter edge that ends at a T-junction aligns at one end.
// Every hypothesis is checked for seam length and overlap; the content clue settles what geometry leaves ambiguous.

import { fitLine } from "./edges";
import { interpenetration, measureSeam, type MatchData, type MatchOptions } from "./match";
import type { Pose } from "./geom";
import type { Candidate } from "./types";

export type CutEdge = {
  frag: number;
  /** Outline indices of its ends, in travel order. */
  start: number;
  end: number;
  p0: [number, number];
  p1: [number, number];
  dir: [number, number];
  length: number;
  rms: number;
};

export type CutOptions = { tolerance: number; minLength: number; maxRms: number; maxDev: number };
export const CUT_DEFAULTS: CutOptions = { tolerance: 2.5, minLength: 40, maxRms: 1.6, maxDev: 4 };

/** Douglas–Peucker vertices of a closed outline (outline indices, ascending). */
function simplifyClosed(X: Float64Array, Y: Float64Array, eps: number): number[] {
  const n = X.length;
  let far = 0;
  let fd = -1;
  for (let i = 0; i < n; i++) {
    const d = (X[i] - X[0]) ** 2 + (Y[i] - Y[0]) ** 2;
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const keep = new Set<number>([0, far]);
  const rec = (a: number, b: number) => {
    // indices a < b in unrolled coordinates (mod n)
    if (b - a < 2) return;
    const ax = X[a % n];
    const ay = Y[a % n];
    const dx = X[b % n] - ax;
    const dy = Y[b % n] - ay;
    const L = Math.hypot(dx, dy) || 1;
    let best = -1;
    let bd = eps;
    for (let k = a + 1; k < b; k++) {
      const d = Math.abs((X[k % n] - ax) * dy - (Y[k % n] - ay) * dx) / L;
      if (d > bd) {
        bd = d;
        best = k;
      }
    }
    if (best < 0) return;
    keep.add(best % n);
    rec(a, best);
    rec(best, b);
  };
  rec(0, far);
  rec(far, n);
  return [...keep].sort((a, b) => a - b);
}

/** The straight edges of a fragment: polygon sides that are long and fit a line closely. */
export function cutEdges(d: MatchData, o: CutOptions = CUT_DEFAULTS): CutEdge[] {
  const n = d.n;
  const v = simplifyClosed(d.X, d.Y, o.tolerance);
  const out: CutEdge[] = [];
  for (let k = 0; k < v.length; k++) {
    const a = v[k];
    const b = v[(k + 1) % v.length];
    const count = ((b - a + n) % n) + 1;
    if (count < o.minLength) continue;
    // fit away from the rounded corners
    const trim = Math.min(4, Math.floor(count / 6));
    const f = fitLine(d.X, d.Y, (a + trim) % n, count - 2 * trim, n);
    if (f.rms > o.maxRms || f.maxDev > o.maxDev) continue;
    const c = Math.cos(f.angle);
    const s = Math.sin(f.angle);
    const proj = (i: number): [number, number] => {
      const t = (d.X[i] - f.cx) * c + (d.Y[i] - f.cy) * s;
      return [f.cx + t * c, f.cy + t * s];
    };
    const p0 = proj(a);
    const p1 = proj(b);
    const length = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (length < o.minLength) continue;
    out.push({ frag: d.f.index, start: a, end: b, p0, p1, dir: [c, s], length, rms: f.rms });
  }
  return out;
}

/** Rigid pose (B → A) that maps point pb to pa with B's direction reversed onto A's. */
function alignAt(ea: CutEdge, eb: CutEdge, pa: [number, number], pb: [number, number]): Pose {
  const theta = Math.atan2(ea.dir[1], ea.dir[0]) - Math.atan2(-eb.dir[1], -eb.dir[0]);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return { theta, tx: pa[0] - (c * pb[0] - s * pb[1]), ty: pa[1] - (s * pb[0] + c * pb[1]) };
}

/** Candidate joins along straight cuts between every pair of fragments. */
export function matchCuts(data: MatchData[], o: MatchOptions, co: CutOptions = CUT_DEFAULTS): Candidate[] {
  const edges = data.map((d) => cutEdges(d, co));
  const out: Candidate[] = [];
  for (let i = 0; i < data.length; i++) {
    for (let j = i + 1; j < data.length; j++) {
      const A = data[i];
      const B = data[j];
      let k = 0;
      for (const ea of edges[i]) {
        for (const eb of edges[j]) {
          const tol = Math.max(5, 0.04 * Math.max(ea.length, eb.length));
          const dl = Math.abs(ea.length - eb.length);
          const hyps: { pose: Pose; full: boolean }[] = [];
          if (dl <= tol) {
            const ma: [number, number] = [(ea.p0[0] + ea.p1[0]) / 2, (ea.p0[1] + ea.p1[1]) / 2];
            const mb: [number, number] = [(eb.p0[0] + eb.p1[0]) / 2, (eb.p0[1] + eb.p1[1]) / 2];
            hyps.push({ pose: alignAt(ea, eb, ma, mb), full: true });
          } else {
            // a T-junction: the shorter edge shares one end with the longer one (B reversed: its end meets A's start)
            hyps.push({ pose: alignAt(ea, eb, ea.p0, eb.p1), full: false });
            hyps.push({ pose: alignAt(ea, eb, ea.p1, eb.p0), full: false });
          }
          for (const h of hyps) {
            const area = interpenetration(A, B, h.pose, o.deepPx, o.step);
            if (area > 150 + 0.01 * Math.min(A.f.area, B.f.area)) continue;
            const m = measureSeam(A, B, h.pose, { ...o, minOverlap: Math.max(o.minOverlap, 0.5 * Math.min(ea.length, eb.length)) });
            if (!m) continue;
            const quality = h.full ? Math.exp(-0.5 * (dl / 5) ** 2) : 0.5;
            const score = m.overlap * quality - area / 10;
            if (score <= 20) continue;
            out.push({
              id: `${A.f.id}~${B.f.id}#cut${k++}`,
              a: A.f.id,
              b: B.f.id,
              pose: h.pose,
              overlap: m.overlap,
              rms: m.rms,
              fineRms: m.fineRms,
              shapeRms: m.shapeRms,
              areaOverlap: area,
              conditioning: m.conditioning,
              score,
              confidence: 0,
              margin: Infinity,
              segmentsA: [],
              segmentsB: [],
              seamA: m.seamA,
              seamB: m.seamB,
              appearance: null,
              twinGroup: null,
              edge: "cut",
            });
          }
        }
      }
    }
  }
  return out;
}
