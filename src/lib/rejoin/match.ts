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
  /** When both fragments have a confident text angle, their lines must be parallel within this (rad) to seed. */
  textTol: number;
  textConfidence: number;
  /** Score ratio and footprint coincidence that make two alternatives twins. */
  twinRatio: number;
  twinFootprint: number;
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
  textTol: (6 * Math.PI) / 180,
  textConfidence: 0.85,
  twinRatio: 0.7,
  twinFootprint: 0.8,
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
export function correspond(A: MatchData, B: MatchData, pose: Pose, tau: number, w: Matching) {
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
    const a = A.grid.nearest(x, y, Math.max(tau, NEAR));
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
    w.inl[k] = Math.abs(r) <= tau && dx * dx + dy * dy <= (tau + 1.5) ** 2 ? 1 : 2;
  }
}

type IcpResult = {
  pose: Pose;
  rms: number;
  shapeRms: number;
  fineRms: number;
  inliers: number;
  matchedA: Int32Array;
  matchedB: Int32Array;
  conditioning: number;
};

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
  for (let it = 0; it <= o.icpIters; it++) {
    const final = it === o.icpIters;
    const tau = final ? o.inlier : it < 3 ? 6 : it < 6 ? 4.5 : o.inlier + 0.5;
    correspond(A, B, pose, tau, w);
    run = bestRun(w.inl, B.brk, 15);
    if (!run || run[2] < minSamples) return null;
    if (final) break;
    let cx = 0;
    let cy = 0;
    let cnt = 0;
    let ss = 0;
    forRun(run, m, (k) => {
      if (w.inl[k] !== 1) return;
      cx += w.qx[k];
      cy += w.qy[k];
      ss += w.res[k] * w.res[k];
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
      const r = w.res[k];
      const wt = Math.abs(r) <= 1.5 ? 1 : 1.5 / Math.abs(r);
      addJ(H, g, -ry * nx + rx * ny, nx, ny, r, wt);
      addJ(H, g, -ry, 1, 0, w.qx[k] - A.X[a], lam * wt);
      addJ(H, g, rx, 0, 1, w.qy[k] - A.Y[a], lam * wt);
    });
    const x = solveSPD(H, Float64Array.from([-g[0], -g[1], -g[2]]), 3, 1e-6);
    const dth = Math.max(-0.2, Math.min(0.2, x[0]));
    const cd = Math.cos(dth);
    const sd = Math.sin(dth);
    pose = poseCompose({ theta: dth, tx: cx - (cd * cx - sd * cy) + x[1], ty: cy - (sd * cx + cd * cy) + x[2] }, pose);
    if (it >= 8 && Math.abs(dth) < 2e-5 && Math.hypot(x[1], x[2]) < 0.005) it = o.icpIters - 1;
  }
  if (!run) return null;
  let ss = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  const mA: number[] = [];
  const mB: number[] = [];
  const seq: number[] = [];
  forRun(run, m, (k) => {
    if (w.inl[k] !== 1) return;
    const r = w.res[k];
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
  // fine residual: the residual minus its 18 px moving average
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
    pose,
    rms: Math.sqrt(ss / cnt),
    shapeRms: Math.sqrt(ls / cnt),
    fineRms: Math.sqrt(fs / cnt),
    inliers: cnt,
    matchedA: Int32Array.from(mA),
    matchedB: Int32Array.from(mB),
    conditioning: tr > 0 ? (tr / 2 - disc) / (tr / 2 + disc) : 0,
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
  data: MatchData[];
  stats: { seeds: number; screened: number; icp: number };
};

/** All candidate joins between the fragments, ranked, with twin groups. */
export function matchFragments(frags: Fragment[], options: Partial<MatchOptions> = {}): MatchResult {
  const o = { ...MATCH_DEFAULTS, ...options };
  const data = frags.map((f) => matchData(f, o));
  const seeds: Seed[] = [];
  const pairSeeds: Seed[] = [];
  for (let i = 0; i < data.length; i++) {
    for (let j = i + 1; j < data.length; j++) {
      pairSeeds.length = 0;
      for (const sa of data[i].sigs) for (const sb of data[j].sigs) seedPair(data[i], data[j], sa, sb, o, pairSeeds);
      pairSeeds.sort((x, y) => x.q - y.q);
      for (let k = 0; k < Math.min(o.seedsPerPair, pairSeeds.length); k++) seeds.push(pairSeeds[k]);
    }
  }
  seeds.sort((x, y) => x.q - y.q);
  const byIndex = new Map(data.map((d) => [d.f.index, d] as const));
  const raw: Candidate[] = [];
  const perPair = new Map<string, Candidate[]>();
  const spaces = new Map<number, Matching>();
  let screened = 0;
  let icpRuns = 0;
  for (const s of seeds) {
    const A = byIndex.get(s.a)!;
    const B = byIndex.get(s.b)!;
    const key = `${s.a}|${s.b}`;
    const fit = seedPose(A, B, s);
    if (fit.rms > 3.5) continue;
    const known = perPair.get(key) ?? [];
    if (known.some((c) => samePose(c.pose, fit.pose, B.f.centroid, 2.5, 8))) continue;
    let w = spaces.get(B.f.index);
    if (!w) {
      w = workspace(B.sample.length);
      spaces.set(B.f.index, w);
    }
    // one-pass screen: the seam must hold beyond noise at the seed pose
    correspond(A, B, fit.pose, 4, w);
    const pre = bestRun(w.inl, B.brk, 15);
    screened++;
    if (!pre || pre[2] < Math.max(o.minOverlap / o.step, 0.7 * s.w)) continue;
    icpRuns++;
    const r = icp(A, B, fit.pose, o, w);
    if (!r) continue;
    if (known.some((c) => samePose(c.pose, r.pose, B.f.centroid, 1, 3))) continue;
    const overlap = r.inliers * o.step;
    if (overlap < o.minOverlap || r.rms > o.maxRms) continue;
    const areaOverlap = interpenetration(A, B, r.pose, o.deepPx, o.step);
    const score = geometryScore({ overlap, fineRms: r.fineRms, conditioning: r.conditioning, areaOverlap }, o);
    if (score <= 0) continue;
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
    };
    known.push(cand);
    perPair.set(key, known);
    raw.push(cand);
  }
  const { candidates, twinGroups } = rank(raw, data, o);
  return { candidates, twinGroups, data, stats: { seeds: seeds.length, screened, icp: icpRuns } };
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

/** Margins, geometry confidences and twin groups. */
function rank(cands: Candidate[], data: MatchData[], o: MatchOptions): { candidates: Candidate[]; twinGroups: TwinGroup[] } {
  const byId = new Map(data.map((d) => [d.f.id, d] as const));
  const involving = new Map<string, Candidate[]>();
  for (const c of cands) {
    for (const f of [c.a, c.b]) {
      const l = involving.get(f) ?? [];
      l.push(c);
      involving.set(f, l);
    }
  }
  const twinEdges: [Candidate, Candidate, string][] = [];
  for (const c of cands) {
    let margin = Infinity;
    for (const fid of [c.a, c.b]) {
      const F = byId.get(fid)!;
      const mine = side(c, fid);
      for (const d of involving.get(fid) ?? []) {
        if (d === c) continue;
        const other = side(d, fid);
        const ov = rangeOverlap(mine.seam, other.seam, F.n);
        if (ov < 0.3 * Math.min(mine.seam[1], other.seam[1])) continue;
        margin = Math.min(margin, c.score / Math.max(d.score, 1e-9));
        if (other.partner !== mine.partner && c.id < d.id) {
          const ratio = Math.min(c.score, d.score) / Math.max(c.score, d.score);
          if (ratio >= o.twinRatio && footprint(byId.get(mine.partner)!, mine.pose, byId.get(other.partner)!, other.pose) >= o.twinFootprint) {
            twinEdges.push([c, d, fid]);
          }
        }
      }
    }
    c.margin = margin;
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
  return { candidates: cands, twinGroups: groups };
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
