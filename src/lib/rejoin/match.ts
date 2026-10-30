// Pairwise matching of torn edges. For every pair of torn segments on different fragments:
//   1. seed: compare turning functions (tangent angle along the edge, one edge reversed) on sliding windows; a window
//      where the angle difference is nearly constant is a candidate alignment, and that constant is the rotation;
//   2. fit: a rigid transform from the window's corresponding points (2D Kabsch), screened in one pass;
//   3. refine: point-to-line ICP over the contiguous seam, which may run beyond the segments (partial matches);
//   4. score: seam length × fine-residual quality × conditioning (a straight seam can slide) − area overlap.
// The fine residual (seam residual minus its 18 px moving average) is the sharp clue: on a true seam it is mask noise
// only; two different tears can be bent into coarse agreement by the fit, but their fine raggedness never agrees.
// Candidates are then ranked per stretch of edge; geometrically indistinguishable alternatives from different
// fragments (stack tears) form twin groups.

import { axialDiff, fitRigid, PointGrid, poseCompose, poseInvert, solveSPD, type Pose } from "./geom";
import { seamAppearance } from "./appearance";
import { matchCuts } from "./cuts";
import { gridTrusted, lineConsensus, photoGrid, textCheck, UP_CONFIDENCE } from "./textlines";
import type { Candidate, Fragment, TwinGroup } from "./types";

export type MatchOptions = {
  /** Signature sampling step along the outline (px). */
  step: number;
  /** Half-length of the chord that defines the tangent angle (px). */
  chord: number;
  /** Seed window length (samples) and the shortest window allowed for short segments. */
  window: number;
  minWindow: number;
  /** Largest std (rad) of the turning-function difference over a seed window… */
  seedStd: number;
  /** …and largest ratio of that variance to the window's own tangent variance (the shape it explains). */
  seedRatio: number;
  /** Smallest std (rad) of the tangent angle inside the window: straight windows carry no shape. */
  minShapeStd: number;
  /** Seeds refined per fragment pair. */
  seedsPerPair: number;
  icpIters: number;
  /** Seam inlier distance (px). */
  inlier: number;
  /** Shortest seam (px) and largest RMS (px) for a candidate. */
  minOverlap: number;
  maxRms: number;
  /** Fine-residual noise floor (px) and tolerance (px): seam quality falls off above the floor. */
  fineFloor: number;
  fineScale: number;
  /** Depth (px) beyond which overlapping paper counts as interpenetration. */
  deepPx: number;
  /**
   * Fibre rim: a hand tear leaves a white fringe of fibres protruding on one side, so at the true join the two
   * outlines overlap by its width. With this > 0 the edge fit allows a per-seam overlap up to it (px), estimated as
   * the median overlap of the seam. Off by default: measured (S7), the overlap the outline fit recovers is small on
   * the real photo (median 0.6 working px; the rim's offset curve fits the partner worse than a smaller overlap) and
   * just as large on rim-less simulations (Bench-S large p90 1.7 px), where enforcing it in assembly cost 3 px
   * precision on 50 of 271 pieces.
   */
  rimMax: number;
  /** When both fragments have a confident text angle, their lines must be parallel within this (rad) to seed. */
  textTol: number;
  textConfidence: number;
  /** Score ratio and footprint coincidence that make two alternatives twins, and the score both need. */
  twinRatio: number;
  twinFootprint: number;
  twinMinScore: number;
  /**
   * Also propose joins along straight cuts (scissors, shredders, ShredBench's Voronoi cuts). Opt-in: on torn pages every
   * cut candidate is a coincidence of straight page edges, and only the content clue can accept one.
   */
  cuts: boolean;
  /**
   * Drop candidates whose text lines contradict the join (both line grids trusted at `textPruneWeight`): directions
   * more than `textMaxAngle` apart (rad), lines more than `textMaxPhase` of a pitch out of phase, or a piece turned
   * upside down. On printed pages this removes most chance fits before they compete with true ones.
   */
  textPrune: boolean;
  textPruneWeight: number;
  textMaxAngle: number;
  textMaxAngleLoose: number;
  textMaxPhase: number;
  /** Up votes this sure count for a join turning a piece upside down (textlines.UP_CONFIDENCE). */
  textUpConfidence: number;
  /**
   * Also seed pairs whose text lines are both trusted from the lines themselves: the lines fix the rotation (the up
   * votes the turn), and outline points with facing normals vote for the translation, weighted by line phase. Finds
   * seams the turning functions miss when fibre rims and curl blur the edge's fine shape.
   */
  textSeeds: boolean;
  textSeedsPerPair: number;
};

export const MATCH_DEFAULTS: MatchOptions = {
  step: 2,
  chord: 8,
  window: 44,
  minWindow: 16,
  seedStd: 0.2,
  seedRatio: 0.25,
  minShapeStd: 0.12,
  seedsPerPair: 8,
  icpIters: 24,
  inlier: 3,
  minOverlap: 30,
  maxRms: 2.2,
  fineFloor: 0.6,
  fineScale: 0.16,
  deepPx: 3,
  rimMax: 0,
  textTol: (6 * Math.PI) / 180,
  textConfidence: 0.85,
  twinRatio: 0.5,
  twinFootprint: 0.8,
  twinMinScore: 40,
  cuts: false,
  textPrune: true,
  textPruneWeight: 0.5,
  textMaxAngle: (6 * Math.PI) / 180,
  textMaxAngleLoose: Math.PI,
  textMaxPhase: 0.3,
  textUpConfidence: UP_CONFIDENCE,
  textSeeds: true,
  textSeedsPerPair: 4,
};

/** Matching data for one fragment. */
export type MatchData = {
  f: Fragment;
  n: number;
  X: Float64Array;
  Y: Float64Array;
  NX: Float64Array;
  NY: Float64Array;
  torn: Uint8Array;
  grid: PointGrid;
  /** Torn outline indices every `step` px, in outline order; brk[k] = 1 when sample k does not follow k − 1. */
  sample: Int32Array;
  brk: Uint8Array;
  /** Interior samples (photo coordinates) at depth ≥ deepPx, every `step` px. */
  deep: Float64Array;
  sigs: Signature[];
};

type Signature = { seg: number; idx: Int32Array; phi: Float64Array; cs1: Float64Array; cs2: Float64Array };

export function matchData(f: Fragment, o: MatchOptions = MATCH_DEFAULTS): MatchData {
  const n = f.outline.length / 2;
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    X[i] = f.outline[2 * i];
    Y[i] = f.outline[2 * i + 1];
  }
  const NX = new Float64Array(n);
  const NY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 2 + n) % n;
    const b = (i + 2) % n;
    const tx = X[b] - X[a];
    const ty = Y[b] - Y[a];
    const l = Math.hypot(tx, ty) || 1;
    // positive area: the interior is on the (−dy, dx) side, so (dy, −dx) points out
    NX[i] = ty / l;
    NY[i] = -tx / l;
  }
  const torn = new Uint8Array(n);
  for (let i = 0; i < n; i++) torn[i] = f.straight[i] ? 0 : 1;
  // Seams are matched over the whole outline: a stretch of tear misread as straight still joins, and page edges
  // never pair up with each other because complementary edges must face each other.
  const grid = new PointGrid(f.outline, 4);
  const samp: number[] = [];
  for (let k = 0; k + o.step <= n; k += o.step) samp.push(k);
  const brk = new Array<number>(samp.length).fill(0);
  // Signatures run along continuous torn chains (maximal non-straight stretches), not corner-split segments, so
  // seed windows slide across the small corners a ragged tear is full of. A wholly torn outline is one cyclic chain.
  const sigs: Signature[] = [];
  const c = Math.max(1, Math.round(o.chord));
  const chains: [number, number, boolean][] = [];
  if (torn.every((t) => t === 1)) chains.push([0, n, true]);
  else {
    for (let i = 0; i < n; i++) {
      if (!torn[i] || torn[(i - 1 + n) % n]) continue;
      let len = 0;
      while (len < n && torn[(i + len) % n]) len++;
      chains.push([i, len, false]);
    }
  }
  for (const [start, len, cyclic] of chains) {
    if (len < o.minWindow * o.step) continue;
    const base = Math.floor((len - 1) / o.step) + 1;
    const m = cyclic ? base + o.window : base;
    const idx = new Int32Array(m);
    const phi = new Float64Array(m);
    let prev = 0;
    for (let k = 0; k < m; k++) {
      const i = (start + k * o.step) % n;
      idx[k] = i;
      const a = (i - c + n) % n;
      const b = (i + c) % n;
      let ang = Math.atan2(Y[b] - Y[a], X[b] - X[a]);
      if (k) {
        while (ang - prev > Math.PI) ang -= 2 * Math.PI;
        while (ang - prev < -Math.PI) ang += 2 * Math.PI;
      }
      phi[k] = ang;
      prev = ang;
    }
    const cs1 = new Float64Array(m + 1);
    const cs2 = new Float64Array(m + 1);
    for (let k = 0; k < m; k++) {
      cs1[k + 1] = cs1[k] + phi[k];
      cs2[k + 1] = cs2[k] + phi[k] * phi[k];
    }
    sigs.push({ seg: f.segmentOf[start], idx, phi, cs1, cs2 });
  }
  const deep: number[] = [];
  const { mask, x0, y0 } = f.input;
  for (let r = 1; r < mask.height; r += o.step) {
    for (let col = 1; col < mask.width; col += o.step) {
      if (f.depth[r * mask.width + col] >= o.deepPx) deep.push(x0 + col + 0.5, y0 + r + 0.5);
    }
  }
  return { f, n, X, Y, NX, NY, torn, grid, sample: Int32Array.from(samp), brk: Uint8Array.from(brk), deep: Float64Array.from(deep), sigs };
}

export type Seed = { a: number; b: number; sa: Signature; sb: Signature; d: number; jEnd: number; w: number; v: number; q: number };

/** Seeds for one segment pair: the best window per diagonal, then the best few diagonals far apart. */
export function seedPair(A: MatchData, B: MatchData, sa: Signature, sb: Signature, o: MatchOptions, out: Seed[]) {
  const na = sa.phi.length;
  const nb = sb.phi.length;
  const W = Math.min(o.window, na, nb);
  if (W < o.minWindow) return;
  const ta = A.f.text;
  const tb = B.f.text;
  const useText = !!ta && !!tb && ta.confidence >= o.textConfidence && tb.confidence >= o.textConfidence;
  const maxVar = o.seedStd * o.seedStd;
  const minShape = o.minShapeStd * o.minShapeStd;
  const pb = new Float64Array(nb);
  for (let j = 0; j < nb; j++) pb[j] = sb.phi[nb - 1 - j] + Math.PI;
  const best: Seed[] = [];
  for (let d = -(nb - W); d <= na - W; d++) {
    const j0 = Math.max(0, -d);
    const j1 = Math.min(nb, na - d);
    if (j1 - j0 < W) continue;
    const base = sa.phi[j0 + d] - pb[j0];
    let s1 = 0;
    let s2 = 0;
    let bq = o.seedRatio;
    let bj = -1;
    let bv = 0;
    for (let j = j0; j < j1; j++) {
      const D = sa.phi[j + d] - pb[j] - base;
      s1 += D;
      s2 += D * D;
      if (j - j0 >= W) {
        const Do = sa.phi[j - W + d] - pb[j - W] - base;
        s1 -= Do;
        s2 -= Do * Do;
      }
      if (j - j0 < W - 1) continue;
      const m = s1 / W;
      const v = s2 / W - m * m;
      if (v >= maxVar) continue;
      const i1 = j + d + 1;
      const i0 = i1 - W;
      const pm = (sa.cs1[i1] - sa.cs1[i0]) / W;
      const pv = (sa.cs2[i1] - sa.cs2[i0]) / W - pm * pm;
      if (pv < minShape) continue;
      const q = v / pv;
      if (q >= bq) continue;
      if (useText && axialDiff(ta!.angle, tb!.angle + m + base) > o.textTol) continue;
      bq = q;
      bv = v;
      bj = j;
    }
    if (bj < 0) continue;
    const seed: Seed = { a: A.f.index, b: B.f.index, sa, sb, d, jEnd: bj, w: W, v: bv, q: bq };
    let merged = false;
    for (let k = 0; k < best.length; k++) {
      if (Math.abs(best[k].d - d) < W / 2) {
        if (bq < best[k].q) best[k] = seed;
        merged = true;
        break;
      }
    }
    if (!merged) best.push(seed);
  }
  for (const s of best) out.push(s);
}

/** The rigid transform (B → A) from a seed window's corresponding points. */
function seedPose(A: MatchData, B: MatchData, s: Seed): { pose: Pose; rms: number } {
  const nb = s.sb.idx.length;
  const pa = new Float64Array(2 * s.w);
  const pbb = new Float64Array(2 * s.w);
  for (let k = 0; k < s.w; k++) {
    const j = s.jEnd - s.w + 1 + k;
    const ia = s.sa.idx[j + s.d];
    const ib = s.sb.idx[nb - 1 - j];
    pa[2 * k] = A.X[ia];
    pa[2 * k + 1] = A.Y[ia];
    pbb[2 * k] = B.X[ib];
    pbb[2 * k + 1] = B.Y[ib];
  }
  return fitRigid(pbb, pa);
}

type Matching = { ai: Int32Array; res: Float64Array; qx: Float64Array; qy: Float64Array; inl: Uint8Array };

/** Within this distance (px) a facing point counts as "near": it keeps a seam run going across a mask-noise blob. */
const NEAR = 7;

/**
 * Transform B's samples and match each to A's nearest outline point (facing it). inl = 1: within tau (an inlier);
 * inl = 2: within NEAR only (bridges a run); 0: no facing point near.
 */
export function correspond(A: MatchData, B: MatchData, pose: Pose, tau: number, w: Matching, delta = 0) {
  const c = Math.cos(pose.theta);
  const s = Math.sin(pose.theta);
  const m = B.sample.length;
  for (let k = 0; k < m; k++) {
    const i = B.sample[k];
    const x = c * B.X[i] - s * B.Y[i] + pose.tx;
    const y = s * B.X[i] + c * B.Y[i] + pose.ty;
    w.qx[k] = x;
    w.qy[k] = y;
    w.inl[k] = 0;
    const a = A.grid.nearest(x, y, Math.max(tau, NEAR) + delta);
    w.ai[k] = a;
    if (a < 0) continue;
    const r = A.NX[a] * (x - A.X[a]) + A.NY[a] * (y - A.Y[a]);
    w.res[k] = r;
    // complementary edges face each other: B's outward normal (rotated) must oppose A's
    const nbx = c * B.NX[i] - s * B.NY[i];
    const nby = s * B.NX[i] + c * B.NY[i];
    if (nbx * A.NX[a] + nby * A.NY[a] > -0.2) continue;
    const dx = x - A.X[a];
    const dy = y - A.Y[a];
    // an overlap of `delta` (fibre rim) is the seam's rest position: r = −delta
    w.inl[k] = Math.abs(r + delta) <= tau && dx * dx + dy * dy <= (tau + 1.5 + delta) ** 2 ? 1 : 2;
  }
}

/** The seam's overlap (fibre rim): the median of −r over the run's inliers, within [0, rimMax]. */
export function rimOverlap(w: Matching, run: [number, number, number], m: number, rimMax: number): number {
  if (rimMax <= 0) return 0;
  const v: number[] = [];
  forRun(run, m, (k) => {
    if (w.inl[k] === 1) v.push(-w.res[k]);
  });
  if (v.length < 8) return 0;
  v.sort((a, b) => a - b);
  return Math.max(0, Math.min(rimMax, v[Math.floor(v.length / 2)]));
}

type IcpResult = SeamStats & { pose: Pose; rim: number };

export function workspace(m: number): Matching {
  return { ai: new Int32Array(m), res: new Float64Array(m), qx: new Float64Array(m), qy: new Float64Array(m), inl: new Uint8Array(m) };
}

/** Point-to-line ICP of B's torn samples onto A's torn outline, restricted to the best contiguous seam. */
export function icp(A: MatchData, B: MatchData, pose0: Pose, o: MatchOptions, w: Matching): IcpResult | null {
  const m = B.sample.length;
  if (m < 4) return null;
  let pose = { ...pose0 };
  let run: [number, number, number] | null = null;
  const minSamples = Math.ceil(o.minOverlap / o.step);
  let delta = 0;
  for (let it = 0; it <= o.icpIters; it++) {
    const final = it === o.icpIters;
    const tau = final ? o.inlier : it < 3 ? 6 : it < 6 ? 4.5 : o.inlier + 0.5;
    correspond(A, B, pose, tau, w, delta);
    run = bestRun(w.inl, B.brk, 15);
    if (!run || run[2] < minSamples) return null;
    if (final) break;
    // once the coarse stages have settled the seam, let it rest at its rim overlap
    if (it >= 3) delta = rimOverlap(w, run, m, o.rimMax);
    let cx = 0;
    let cy = 0;
    let cnt = 0;
    let ss = 0;
    forRun(run, m, (k) => {
      if (w.inl[k] !== 1) return;
      cx += w.qx[k];
      cy += w.qy[k];
      ss += (w.res[k] + delta) ** 2;
      cnt++;
    });
    // early exit: after the coarse stages a seam this poor will not become a candidate
    if (it === 6 && Math.sqrt(ss / cnt) > o.maxRms + 0.3) return null;
    cx /= cnt;
    cy /= cnt;
    const H = new Float64Array(9);
    const g = new Float64Array(3);
    const lam = 0.03;
    forRun(run, m, (k) => {
      if (w.inl[k] !== 1) return;
      const a = w.ai[k];
      const nx = A.NX[a];
      const ny = A.NY[a];
      const rx = w.qx[k] - cx;
      const ry = w.qy[k] - cy;
      const r = w.res[k] + delta;
      const wt = Math.abs(r) <= 1.5 ? 1 : 1.5 / Math.abs(r);
      addJ(H, g, -ry * nx + rx * ny, nx, ny, r, wt);
      addJ(H, g, -ry, 1, 0, w.qx[k] - A.X[a] + delta * nx, lam * wt);
      addJ(H, g, rx, 0, 1, w.qy[k] - A.Y[a] + delta * ny, lam * wt);
    });
    const x = solveSPD(H, Float64Array.from([-g[0], -g[1], -g[2]]), 3, 1e-6);
    const dth = Math.max(-0.2, Math.min(0.2, x[0]));
    const cd = Math.cos(dth);
    const sd = Math.sin(dth);
    pose = poseCompose({ theta: dth, tx: cx - (cd * cx - sd * cy) + x[1], ty: cy - (sd * cx + cd * cy) + x[2] }, pose);
    if (it >= 8 && Math.abs(dth) < 2e-5 && Math.hypot(x[1], x[2]) < 0.005) it = o.icpIters - 1;
  }
  if (!run) return null;
  const seam = seamFromRun(A, B, w, run, minSamples, delta);
  return seam ? { pose, rim: delta, ...seam } : null;
}

type SeamStats = {
  rms: number;
  shapeRms: number;
  fineRms: number;
  inliers: number;
  matchedA: Int32Array;
  matchedB: Int32Array;
  conditioning: number;
};

/** Residual statistics of a seam run: RMS, its coarse (18 px moving average) and fine parts, and conditioning. */
function seamFromRun(A: MatchData, B: MatchData, w: Matching, run: [number, number, number], minSamples: number, delta = 0): SeamStats | null {
  const m = B.sample.length;
  let ss = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  const mA: number[] = [];
  const mB: number[] = [];
  const seq: number[] = [];
  forRun(run, m, (k) => {
    if (w.inl[k] !== 1) return;
    const r = w.res[k] + delta;
    seq.push(r);
    ss += r * r;
    const a = w.ai[k];
    sxx += A.NX[a] * A.NX[a];
    syy += A.NY[a] * A.NY[a];
    sxy += A.NX[a] * A.NY[a];
    mA.push(a);
    mB.push(B.sample[k]);
  });
  const cnt = seq.length;
  if (cnt < minSamples) return null;
  const half = 4;
  let ls = 0;
  let fs = 0;
  for (let k = 0; k < cnt; k++) {
    let a = 0;
    let n = 0;
    for (let d = -half; d <= half; d++) {
      const j = k + d;
      if (j < 0 || j >= cnt) continue;
      a += seq[j];
      n++;
    }
    const lp = a / n;
    ls += lp * lp;
    fs += (seq[k] - lp) ** 2;
  }
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  return {
    rms: Math.sqrt(ss / cnt),
    shapeRms: Math.sqrt(ls / cnt),
    fineRms: Math.sqrt(fs / cnt),
    inliers: cnt,
    matchedA: Int32Array.from(mA),
    matchedB: Int32Array.from(mB),
    conditioning: tr > 0 ? (tr / 2 - disc) / (tr / 2 + disc) : 0,
  };
}

export type SeamMeasure = {
  overlap: number;
  /** The seam's rim overlap (px). */
  rim: number;
  rms: number;
  fineRms: number;
  shapeRms: number;
  conditioning: number;
  areaOverlap: number;
  score: number;
  seamA: [number, number];
  seamB: [number, number];
};

/** Measure the seam between A and B where a pose (B → A) puts them, without moving anything. */
export function measureSeam(A: MatchData, B: MatchData, pose: Pose, options: Partial<MatchOptions> = {}): SeamMeasure | null {
  const o = { ...MATCH_DEFAULTS, ...options };
  const w = workspace(B.sample.length);
  // the rim overlap at this pose: from the seam found with a band wide enough to hold it
  let delta = 0;
  if (o.rimMax > 0) {
    correspond(A, B, pose, o.inlier + o.rimMax, w);
    const wide = bestRun(w.inl, B.brk, 15);
    if (wide) delta = rimOverlap(w, wide, B.sample.length, o.rimMax);
  }
  correspond(A, B, pose, o.inlier, w, delta);
  const run = bestRun(w.inl, B.brk, 15);
  if (!run) return null;
  const st = seamFromRun(A, B, w, run, Math.ceil(o.minOverlap / o.step), delta);
  if (!st) return null;
  const overlap = st.inliers * o.step;
  const areaOverlap = interpenetration(A, B, pose, o.deepPx + delta, o.step);
  return {
    overlap,
    rim: delta,
    rms: st.rms,
    fineRms: st.fineRms,
    shapeRms: st.shapeRms,
    conditioning: st.conditioning,
    areaOverlap,
    score: geometryScore({ overlap, fineRms: st.fineRms, conditioning: st.conditioning, areaOverlap }, o),
    seamA: coverRange(st.matchedA, A.n),
    seamB: coverRange(st.matchedB, B.n),
  };
}

function addJ(H: Float64Array, g: Float64Array, j0: number, j1: number, j2: number, r: number, w: number) {
  const J0 = w * j0;
  const J1 = w * j1;
  const J2 = w * j2;
  g[0] += J0 * r;
  g[1] += J1 * r;
  g[2] += J2 * r;
  H[0] += J0 * j0;
  H[1] += J0 * j1;
  H[2] += J0 * j2;
  H[4] += J1 * j1;
  H[5] += J1 * j2;
  H[8] += J2 * j2;
  H[3] = H[1];
  H[6] = H[2];
  H[7] = H[5];
}

function forRun(run: [number, number, number], m: number, fn: (k: number) => void) {
  for (let q = 0; q < run[1]; q++) fn((run[0] + q) % m);
}

/**
 * The best contiguous seam over a cyclic sample array: inliers (1) count; near points (2) bridge up to `maxGap`
 * samples (a mask-noise blob); unmatched points (0) bridge only a few samples. Breaks where brk is set.
 * Returns [start, span, inliers] or null.
 */
export function bestRun(inl: Uint8Array, brk: ArrayLike<number>, maxGap: number): [number, number, number] | null {
  const m = inl.length;
  let s0 = -1;
  for (let k = 0; k < m; k++) {
    if (inl[k] !== 1 || brk[k]) {
      s0 = k;
      break;
    }
  }
  if (s0 < 0) return [0, m, m];
  const hardGap = Math.min(3, maxGap);
  let best: [number, number, number] | null = null;
  let start = -1;
  let lastIn = -1;
  let count = 0;
  let gap = 0;
  let hard = 0;
  const close = () => {
    if (start >= 0 && count > 0 && (!best || count > best[2])) best = [start, ((lastIn - start + m) % m) + 1, count];
    start = -1;
    count = 0;
    gap = 0;
    hard = 0;
  };
  for (let q = 0; q < m; q++) {
    const k = (s0 + q) % m;
    if (brk[k]) close();
    if (inl[k] === 1) {
      if (start < 0) start = k;
      lastIn = k;
      count++;
      gap = 0;
      hard = 0;
    } else if (start >= 0) {
      gap++;
      if (inl[k] === 0) hard++;
      if (gap > maxGap || hard > hardGap) close();
    }
  }
  close();
  return best;
}

/** Cyclic range [first, count] covering a set of outline indices (the complement of the largest gap). */
function coverRange(ids: Int32Array, n: number): [number, number] {
  if (!ids.length) return [0, 0];
  const s = Array.from(ids).sort((a, b) => a - b);
  let gapAt = s.length - 1;
  let gap = s[0] + n - s[s.length - 1];
  for (let k = 1; k < s.length; k++) {
    if (s[k] - s[k - 1] > gap) {
      gap = s[k] - s[k - 1];
      gapAt = k - 1;
    }
  }
  const first = s[(gapAt + 1) % s.length];
  const lastIdx = s[gapAt];
  return [first, ((lastIdx - first + n) % n) + 1];
}

/** Area (px²) of B's deep interior that lands deep inside A under the pose. */
export function interpenetration(A: MatchData, B: MatchData, pose: Pose, deepPx: number, step: number): number {
  const { mask, x0, y0 } = A.f.input;
  const c = Math.cos(pose.theta);
  const s = Math.sin(pose.theta);
  let hits = 0;
  const d = B.deep;
  for (let k = 0; k < d.length; k += 2) {
    const x = c * d[k] - s * d[k + 1] + pose.tx - x0;
    const y = s * d[k] + c * d[k + 1] + pose.ty - y0;
    const col = Math.floor(x);
    const row = Math.floor(y);
    if (col < 0 || row < 0 || col >= mask.width || row >= mask.height) continue;
    if (A.f.depth[row * mask.width + col] >= deepPx) hits++;
  }
  return hits * step * step;
}

/** Geometry score: seam px × fine-residual quality × conditioning gate − area penalty. */
export function geometryScore(
  c: { overlap: number; fineRms: number; conditioning: number; areaOverlap: number },
  o: Pick<MatchOptions, "fineFloor" | "fineScale">,
): number {
  const excess = Math.max(0, c.fineRms - o.fineFloor) / o.fineScale;
  const quality = Math.exp(-0.5 * excess * excess);
  const cond = Math.min(1, c.conditioning / 0.08);
  return c.overlap * quality * cond - c.areaOverlap / 10;
}

export type MatchResult = {
  candidates: Candidate[];
  twinGroups: TwinGroup[];
  /** Pieces sharing an outline (stack tears): fragment id → class id (the class's smallest fragment id). */
  twinClass: Map<string, string>;
  data: MatchData[];
  stats: { seeds: number; screened: number; icp: number; textPruned: number };
};

/** All candidate joins between the fragments, ranked, with twin groups. */
export function matchFragments(frags: Fragment[], options: Partial<MatchOptions> = {}): MatchResult {
  const o = { ...MATCH_DEFAULTS, ...options };
  const data = frags.map((f) => matchData(f, o));
  const consensus = lineConsensus(frags);
  // Starting poses: turning-function seeds (shape), then rotation-fixed Hough seeds from the text lines.
  type Start = { a: number; b: number; pose: Pose; minRun: number; q: number };
  const starts: Start[] = [];
  const pairSeeds: Seed[] = [];
  let seedCount = 0;
  for (let i = 0; i < data.length; i++) {
    for (let j = i + 1; j < data.length; j++) {
      pairSeeds.length = 0;
      for (const sa of data[i].sigs) for (const sb of data[j].sigs) seedPair(data[i], data[j], sa, sb, o, pairSeeds);
      pairSeeds.sort((x, y) => x.q - y.q);
      for (let k = 0; k < Math.min(o.seedsPerPair, pairSeeds.length); k++) {
        const s = pairSeeds[k];
        const fit = seedPose(data[i], data[j], s);
        seedCount++;
        if (fit.rms <= 3.5) starts.push({ a: s.a, b: s.b, pose: fit.pose, minRun: Math.max(o.minOverlap / o.step, 0.7 * s.w), q: s.q });
      }
    }
  }
  starts.sort((x, y) => x.q - y.q);
  const byIndex = new Map(data.map((d) => [d.f.index, d] as const));
  const raw: Candidate[] = [];
  const perPair = new Map<string, Candidate[]>();
  const spaces = new Map<number, Matching>();
  let screened = 0;
  let icpRuns = 0;
  let textPruned = 0;
  const prunedPoses = new Map<string, Pose[]>();
  const tryStart = (s: Start) => {
    const A = byIndex.get(s.a)!;
    const B = byIndex.get(s.b)!;
    const key = `${s.a}|${s.b}`;
    const known = perPair.get(key) ?? [];
    if (known.some((c) => samePose(c.pose, s.pose, B.f.centroid, 2.5, 8))) return;
    if (prunedPoses.get(key)?.some((p) => samePose(p, s.pose, B.f.centroid, 2.5, 8))) return;
    let w = spaces.get(B.f.index);
    if (!w) {
      w = workspace(B.sample.length);
      spaces.set(B.f.index, w);
    }
    // one-pass screen: the seam must hold beyond noise at the seed pose
    correspond(A, B, s.pose, 4, w);
    const pre = bestRun(w.inl, B.brk, 15);
    screened++;
    if (!pre || pre[2] < s.minRun) return;
    icpRuns++;
    const r = icp(A, B, s.pose, o, w);
    if (!r) return;
    if (known.some((c) => samePose(c.pose, r.pose, B.f.centroid, 1, 3))) return;
    const overlap = r.inliers * o.step;
    if (overlap < o.minOverlap || r.rms > o.maxRms) return;
    const areaOverlap = interpenetration(A, B, r.pose, o.deepPx + r.rim, o.step);
    const score = geometryScore({ overlap, fineRms: r.fineRms, conditioning: r.conditioning, areaOverlap }, o);
    if (score <= 0) return;
    const seamA = coverRange(r.matchedA, A.n);
    const seamB = coverRange(r.matchedB, B.n);
    const cand: Candidate = {
      id: `${A.f.id}~${B.f.id}#${known.length}`,
      a: A.f.id,
      b: B.f.id,
      pose: r.pose,
      overlap,
      rms: r.rms,
      fineRms: r.fineRms,
      shapeRms: r.shapeRms,
      areaOverlap,
      conditioning: r.conditioning,
      score,
      confidence: 0,
      margin: Infinity,
      segmentsA: segmentsIn(A.f, seamA),
      segmentsB: segmentsIn(B.f, seamB),
      seamA,
      seamB,
      appearance: null,
      twinGroup: null,
      edge: "torn",
      rim: r.rim,
    };
    const mid = (seamA[0] + Math.floor(seamA[1] / 2)) % A.n;
    cand.text = textCheck(A.f, B.f, r.pose, [A.X[mid], A.Y[mid]], consensus, o.textUpConfidence);
    const t = cand.text;
    // the direction test is strict where both text angles are clear, coarse (or off) where one of them is less sure
    const maxAngle = t?.angleValid ? o.textMaxAngle : o.textMaxAngleLoose;
    if (o.textPrune && t && t.weight >= o.textPruneWeight && (t.angle > maxAngle || (t.phaseValid && Math.abs(t.phase) > o.textMaxPhase) || t.flipped)) {
      textPruned++;
      prunedPoses.set(key, [...(prunedPoses.get(key) ?? []), r.pose]);
      return;
    }
    known.push(cand);
    perPair.set(key, known);
    raw.push(cand);
  };
  for (const s of starts) tryStart(s);
  if (o.textSeeds) {
    // Stack tears: pieces with a twin (the same outline on another page) are left to the shape seeds and to reading.
    // A seed from the lines finds the in-phase twin and not the others, which would hide the ambiguity reading must
    // settle.
    const twins = new Set(twinClassesOf(rank([...raw], data, o).congruent).keys());
    const fromText: Start[] = [];
    for (let i = 0; i < data.length; i++) {
      for (let j = i + 1; j < data.length; j++) {
        if (twins.has(data[i].f.id) || twins.has(data[j].f.id)) continue;
        if (!gridTrusted(data[i].f, consensus) || !gridTrusted(data[j].f, consensus)) continue;
        for (const h of textSeeds(data[i], data[j], o)) fromText.push({ a: data[i].f.index, b: data[j].f.index, pose: h.pose, minRun: o.minOverlap / o.step, q: -h.votes });
      }
    }
    seedCount += fromText.length;
    for (const s of fromText.sort((x, y) => x.q - y.q)) tryStart(s);
    // ranking again below starts from a clean slate
    for (const c of raw) {
      c.twinGroup = null;
      c.margin = Infinity;
    }
  }
  if (o.cuts) {
    for (const c of matchCuts(data, o)) {
      const B = data.find((d) => d.f.id === c.b)!;
      const known = raw.filter((x) => x.a === c.a && x.b === c.b);
      if (!known.some((x) => samePose(x.pose, c.pose, B.f.centroid, 1.5, 4))) raw.push(c);
    }
  }
  let ranked = rank(raw, data, o);
  // Twins come from different pages, so two pieces of one twin class can never be joined. A chance fit between two
  // edges of the same shape is dropped, and the rest re-ranked without it.
  const cls = twinClassesOf(ranked.congruent);
  const possible = raw.filter((c) => cls.get(c.a) === undefined || cls.get(c.a) !== cls.get(c.b));
  if (possible.length < raw.length) {
    for (const c of possible) c.twinGroup = null;
    ranked = rank(possible, data, o);
  }
  // seam appearance (paper tone, ink continuing) for every candidate worth a look: reported, and a free tie-break
  const frag = new Map(frags.map((f) => [f.id, f] as const));
  for (const c of ranked.candidates) if (c.score >= 25) c.appearance = seamAppearance(frag.get(c.a)!, frag.get(c.b)!, c);
  const { congruent, ...rest } = ranked;
  return { ...rest, data, twinClass: twinClassesOf([...ranked.congruent, ...congruent]), stats: { seeds: seedCount, screened, icp: icpRuns, textPruned } };
}

/**
 * Rotation-fixed Hough seeds for a pair whose text lines are both trusted: the lines give the rotation b → a up to a
 * half turn (the up votes settle it when both pieces know which way is up; ±1.5° absorbs their error). For each
 * rotation, every pair of torn outline samples (one per piece, every 4 px) with facing normals votes for the
 * translation that brings them together, weighted by how well the text lines would then be in phase. A true seam
 * piles its votes into one place; the best peaks become starting poses for ICP.
 */
export function textSeeds(A: MatchData, B: MatchData, o: MatchOptions): { pose: Pose; votes: number }[] {
  const ga = photoGrid(A.f);
  const gb = photoGrid(B.f);
  if (!ga || !gb || ga.weight < o.textPruneWeight || gb.weight < o.textPruneWeight) return [];
  const ta = A.f.text!;
  const tb = B.f.text!;
  const base = ga.angle - gb.angle;
  const known = ta.up !== 0 && tb.up !== 0 && ta.upConfidence >= 0.5 && tb.upConfidence >= 0.5;
  const turns = known ? [base + (ta.up === -1 ? Math.PI : 0) - (tb.up === -1 ? Math.PI : 0)] : [base, base + Math.PI];
  const pick = (D: MatchData) => {
    const idx: number[] = [];
    for (let i = 0; i < D.n; i += 4) if (D.torn[i]) idx.push(i);
    return idx;
  };
  const ia = pick(A);
  const ib = pick(B);
  if (ia.length < 8 || ib.length < 8) return [];
  const pitch = 0.5 * (ga.period + gb.period);
  // a grid locked onto a harmonic: no phase weighting
  const phaseOk = ga.period / gb.period > 0.87 && ga.period / gb.period < 1.15;
  const nax = -Math.sin(ga.angle);
  const nay = Math.cos(ga.angle);
  const BIN = 3;
  const out: { pose: Pose; votes: number }[] = [];
  for (const turn of turns) {
    for (const dth of [-1.5, 0, 1.5]) {
      const th = turn + (dth * Math.PI) / 180;
      const c = Math.cos(th);
      const s = Math.sin(th);
      // where b's lines land: n_a·t ≡ offset_a − sign·offset_b (mod pitch), sign = n_a·(R n_b)
      const sign = nax * -Math.sin(gb.angle + th) + nay * Math.cos(gb.angle + th) >= 0 ? 1 : -1;
      const want = ga.offset - sign * gb.offset;
      const bx = new Float64Array(ib.length);
      const by = new Float64Array(ib.length);
      const bnx = new Float64Array(ib.length);
      const bny = new Float64Array(ib.length);
      let minx = Infinity;
      let maxx = -Infinity;
      let miny = Infinity;
      let maxy = -Infinity;
      ib.forEach((i, k) => {
        bx[k] = c * B.X[i] - s * B.Y[i];
        by[k] = s * B.X[i] + c * B.Y[i];
        bnx[k] = c * B.NX[i] - s * B.NY[i];
        bny[k] = s * B.NX[i] + c * B.NY[i];
        minx = Math.min(minx, bx[k]);
        maxx = Math.max(maxx, bx[k]);
        miny = Math.min(miny, by[k]);
        maxy = Math.max(maxy, by[k]);
      });
      let ax0 = Infinity;
      let ax1 = -Infinity;
      let ay0 = Infinity;
      let ay1 = -Infinity;
      for (const i of ia) {
        ax0 = Math.min(ax0, A.X[i]);
        ax1 = Math.max(ax1, A.X[i]);
        ay0 = Math.min(ay0, A.Y[i]);
        ay1 = Math.max(ay1, A.Y[i]);
      }
      const tx0 = ax0 - maxx;
      const ty0 = ay0 - maxy;
      const nx = Math.ceil((ax1 - minx - tx0) / BIN) + 1;
      const ny = Math.ceil((ay1 - miny - ty0) / BIN) + 1;
      const grid = new Float32Array(nx * ny);
      for (const i of ia) {
        const ax = A.X[i];
        const ay = A.Y[i];
        const anx = A.NX[i];
        const any = A.NY[i];
        for (let k = 0; k < ib.length; k++) {
          if (anx * bnx[k] + any * bny[k] > -0.85) continue;
          const tx = ax - bx[k];
          const ty = ay - by[k];
          let ph = (nax * tx + nay * ty - want) / pitch;
          ph -= Math.round(ph);
          const wgt = phaseOk ? Math.exp(-(ph * ph) / (2 * 0.15 * 0.15)) : 1;
          grid[Math.floor((ty - ty0) / BIN) * nx + Math.floor((tx - tx0) / BIN)] += wgt;
        }
      }
      // 3×3 box sum, then the best local maxima at least 5 bins apart
      const sm = new Float32Array(nx * ny);
      for (let y = 1; y < ny - 1; y++) {
        for (let x = 1; x < nx - 1; x++) {
          let v = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) v += grid[(y + dy) * nx + x + dx];
          sm[y * nx + x] = v;
        }
      }
      const peaks: [number, number][] = [];
      for (let q = 0; q < sm.length; q++) if (sm[q] >= 6) peaks.push([q, sm[q]]);
      peaks.sort((p, q) => q[1] - p[1]);
      const kept: number[] = [];
      for (const [q, v] of peaks) {
        const x = q % nx;
        const y = (q - x) / nx;
        if (kept.some((r) => Math.abs((r % nx) - x) <= 5 && Math.abs(Math.floor(r / nx) - y) <= 5)) continue;
        kept.push(q);
        out.push({ pose: { theta: th, tx: tx0 + (x + 0.5) * BIN, ty: ty0 + (y + 0.5) * BIN }, votes: v });
        if (kept.length >= 3) break;
      }
    }
  }
  out.sort((p, q) => q.votes - p.votes);
  return out.slice(0, o.textSeedsPerPair);
}

function samePose(p: Pose, q: Pose, at: [number, number], deg: number, px: number): boolean {
  const dth = Math.abs(Math.atan2(Math.sin(p.theta - q.theta), Math.cos(p.theta - q.theta)));
  if (dth > (deg * Math.PI) / 180) return false;
  const cp = Math.cos(p.theta);
  const sp = Math.sin(p.theta);
  const cq = Math.cos(q.theta);
  const sq = Math.sin(q.theta);
  const dx = cp * at[0] - sp * at[1] + p.tx - (cq * at[0] - sq * at[1] + q.tx);
  const dy = sp * at[0] + cp * at[1] + p.ty - (sq * at[0] + cq * at[1] + q.ty);
  return Math.hypot(dx, dy) <= px;
}

function segmentsIn(f: Fragment, range: [number, number]): number[] {
  const n = f.outline.length / 2;
  const count = new Map<number, number>();
  for (let q = 0; q < range[1]; q++) {
    const s = f.segmentOf[(range[0] + q) % n];
    count.set(s, (count.get(s) ?? 0) + 1);
  }
  return [...count.entries()].filter(([, c]) => c >= 10).map(([s]) => s);
}

/** Overlap (in points) of two cyclic outline ranges. */
export function rangeOverlap(a: [number, number], b: [number, number], n: number): number {
  let total = 0;
  const segs = (r: [number, number]) => (r[0] + r[1] <= n ? [[r[0], r[0] + r[1]]] : [[r[0], n], [0, r[0] + r[1] - n]]);
  for (const [a0, a1] of segs(a)) for (const [b0, b1] of segs(b)) total += Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  return total;
}

/** A candidate seen from one of its fragments: the partner, the seam there, and the partner's pose in its frame. */
export function side(c: Candidate, fid: string): { partner: string; seam: [number, number]; pose: Pose } {
  return c.a === fid ? { partner: c.b, seam: c.seamA, pose: c.pose } : { partner: c.a, seam: c.seamB, pose: poseInvert(c.pose) };
}

/**
 * Competitors of each candidate: other candidates that claim the same stretch of edge (≥ 30% of the shorter seam) on
 * one of its fragments. Only one of them can be right.
 */
export function competitors(cands: Candidate[], data: MatchData[]): Map<string, Candidate[]> {
  const byId = new Map(data.map((d) => [d.f.id, d] as const));
  const involving = new Map<string, Candidate[]>();
  for (const c of cands) {
    for (const f of [c.a, c.b]) {
      const l = involving.get(f) ?? [];
      l.push(c);
      involving.set(f, l);
    }
  }
  const out = new Map<string, Candidate[]>();
  for (const c of cands) {
    const list: Candidate[] = [];
    for (const fid of [c.a, c.b]) {
      const F = byId.get(fid);
      if (!F) continue;
      const mine = side(c, fid);
      for (const d of involving.get(fid) ?? []) {
        if (d === c || list.includes(d)) continue;
        const other = side(d, fid);
        if (rangeOverlap(mine.seam, other.seam, F.n) >= 0.3 * Math.min(mine.seam[1], other.seam[1])) list.push(d);
      }
    }
    out.set(c.id, list);
  }
  return out;
}

/** Margins, geometry confidences and twin groups. */
function rank(cands: Candidate[], data: MatchData[], o: MatchOptions): { candidates: Candidate[]; twinGroups: TwinGroup[]; congruent: [string, string][] } {
  const byId = new Map(data.map((d) => [d.f.id, d] as const));
  const rivals = competitors(cands, data);
  const twinEdges: [Candidate, Candidate, string][] = [];
  const congruent: [string, string][] = [];
  for (const c of cands) {
    let margin = Infinity;
    let marginOther = Infinity;
    for (const d of rivals.get(c.id) ?? []) {
      if (d.edge !== c.edge) continue;
      margin = Math.min(margin, c.score / Math.max(d.score, 1e-9));
      // a rival that pairs the same two pieces is another alignment of this seam, not an alternative partner
      const samePair = (d.a === c.a && d.b === c.b) || (d.a === c.b && d.b === c.a);
      if (!samePair) marginOther = Math.min(marginOther, c.score / Math.max(d.score, 1e-9));
      // twins are a torn-edge notion; straight cuts are ambiguous by nature and go to pair checks
      if (c.edge === "cut" || c.id >= d.id || c.score < o.twinMinScore || d.score < o.twinMinScore) continue;
      // twins: same anchor fragment, different partners, footprints that coincide
      const anchor = c.a === d.a || c.a === d.b ? c.a : c.b;
      if ((d.a !== anchor && d.b !== anchor)) continue;
      const mine = side(c, anchor);
      const other = side(d, anchor);
      if (other.partner === mine.partner) continue;
      const ratio = Math.min(c.score, d.score) / Math.max(c.score, d.score);
      if (ratio < o.twinRatio) continue;
      // the two partners must cover each other: a small piece inside a large one is not its twin
      const P = byId.get(mine.partner)!;
      const Q = byId.get(other.partner)!;
      const area = Math.min(P.f.area, Q.f.area) / Math.max(P.f.area, Q.f.area);
      if (area < 0.85) continue;
      const fpq = footprint(P, mine.pose, Q, other.pose);
      const fqp = footprint(Q, other.pose, P, mine.pose);
      if (fpq >= o.twinFootprint && fqp >= o.twinFootprint) {
        twinEdges.push([c, d, anchor]);
        // same outline (stack twins): nearly full mutual cover and equal area
        if (fpq >= 0.92 && fqp >= 0.92 && area >= 0.93) congruent.push([P.f.id, Q.f.id]);
      }
    }
    c.margin = margin;
    c.marginOther = marginOther;
    const base = 1 - Math.exp(-c.score / 60);
    const amb = Number.isFinite(margin) ? Math.max(0, 1 - 1 / (margin * margin)) : 1;
    c.confidence = base * amb;
  }
  const groups: TwinGroup[] = [];
  const byAnchor = new Map<string, [Candidate, Candidate][]>();
  for (const [c, d, fid] of twinEdges) {
    const l = byAnchor.get(fid) ?? [];
    l.push([c, d]);
    byAnchor.set(fid, l);
  }
  for (const [anchor, edges] of byAnchor) {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      while (parent.get(x) !== x) x = parent.get(x)!;
      return x;
    };
    for (const [c, d] of edges) {
      for (const x of [c.id, d.id]) if (!parent.has(x)) parent.set(x, x);
      parent.set(find(c.id), find(d.id));
    }
    const comps = new Map<string, Candidate[]>();
    const all = new Map(edges.flat().map((c) => [c.id, c] as const));
    for (const [id, c] of all) {
      const r = find(id);
      const l = comps.get(r) ?? [];
      l.push(c);
      comps.set(r, l);
    }
    for (const members of comps.values()) {
      members.sort((x, y) => y.score - x.score);
      const gid = `twin-${anchor}-${groups.length}`;
      groups.push({ id: gid, anchor, seam: side(members[0], anchor).seam, candidates: members.map((m) => m.id) });
      for (const m of members) if (!m.twinGroup) m.twinGroup = gid;
    }
  }
  cands.sort((x, y) => y.score - x.score);
  return { candidates: cands, twinGroups: groups, congruent };
}

/** Classes of twins from congruent pairs (pieces with the same outline). Class id = the smallest member id. */
export function twinClassesOf(pairs: [string, string][]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  for (const [p, q] of pairs) {
    if (!parent.has(p)) parent.set(p, p);
    if (!parent.has(q)) parent.set(q, q);
    parent.set(find(p), find(q));
  }
  const min = new Map<string, string>();
  for (const id of parent.keys()) {
    const r = find(id);
    const m = min.get(r);
    if (m === undefined || id < m) min.set(r, id);
  }
  const out = new Map<string, string>();
  for (const id of parent.keys()) out.set(id, min.get(find(id))!);
  return out;
}

/** Share of partner Q's interior (placed by poseQ in the anchor's frame) that falls inside partner P (placed by poseP). */
function footprint(P: MatchData, poseP: Pose, Q: MatchData, poseQ: Pose): number {
  const rel = poseCompose(poseInvert(poseP), poseQ);
  const { mask, x0, y0 } = P.f.input;
  const c = Math.cos(rel.theta);
  const s = Math.sin(rel.theta);
  const d = Q.deep;
  let inside = 0;
  let total = 0;
  for (let k = 0; k < d.length; k += 8) {
    total++;
    const x = c * d[k] - s * d[k + 1] + rel.tx - x0;
    const y = s * d[k] + c * d[k + 1] + rel.ty - y0;
    const col = Math.floor(x);
    const row = Math.floor(y);
    if (col < 0 || row < 0 || col >= mask.width || row >= mask.height) continue;
    if (P.f.depth[row * mask.width + col] >= 1) inside++;
  }
  return total ? inside / total : 0;
}
