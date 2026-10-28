// Edge analysis of a fragment outline: find the straight page-edge runs (robust to ~1 px mask noise), split the rest
// at sharp corners into torn segments, and find corners of the original page (two straight edges meeting at ~90°).
// Input: a closed outline at ~1 px spacing with positive signed area (see contour.ts).

export type SegmentKind = "straight" | "torn";

export type Segment = {
  index: number;
  kind: SegmentKind;
  /** Outline index of the first point; the segment covers `count` points from there, wrapping around. */
  start: number;
  count: number;
  /** Arc length in px. */
  length: number;
  /** Straight segments: direction of the fitted line (rad, along the outline's travel) and its RMS residual (px). */
  angle?: number;
  rms?: number;
};

export type PageCorner = {
  /** Intersection of the two page edges, in the outline's frame. */
  x: number;
  y: number;
  /** The two straight segments meeting here (indices into segments). */
  segments: [number, number];
  /** Angle between the two edges (rad), ~π/2 for a page corner. */
  angle: number;
};

export type EdgeAnalysis = {
  segments: Segment[];
  /** Per outline point: 1 when the point lies on a straight page-edge segment. */
  straight: Uint8Array;
  /** Per outline point: index of its segment. */
  segmentOf: Int32Array;
  pageCorners: PageCorner[];
};

export type EdgeOptions = {
  /** Half-window (px) of the local line fit. */
  halfWindow?: number;
  /** Local line-fit RMS (px) under which a point may belong to a straight run. */
  localRms?: number;
  /** Shortest straight page edge (px). */
  minStraight?: number;
  /** Largest RMS (px) and largest deviation (px) of a whole straight run from its line. */
  maxRms?: number;
  maxDev?: number;
  /** Turning angle (rad) over `cornerScale` px that splits torn stretches. */
  cornerTurn?: number;
  cornerScale?: number;
  /** Shortest torn segment (px); shorter pieces between corners merge into a neighbour. */
  minSegment?: number;
};

const DEFAULTS: Required<EdgeOptions> = {
  halfWindow: 12,
  localRms: 1.0,
  minStraight: 48,
  maxRms: 1.0,
  maxDev: 3.0,
  cornerTurn: (60 * Math.PI) / 180,
  cornerScale: 14,
  minSegment: 24,
};

type Run = { start: number; count: number };

export function analyzeEdges(outline: Float64Array, options: EdgeOptions = {}): EdgeAnalysis {
  const o = { ...DEFAULTS, ...options };
  const n = outline.length / 2;
  // Centre the coordinates for numerically stable fits.
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += outline[2 * i];
    my += outline[2 * i + 1];
  }
  mx /= n;
  my /= n;
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    X[i] = outline[2 * i] - mx;
    Y[i] = outline[2 * i + 1] - my;
  }
  const at = (i: number) => ((i % n) + n) % n;

  // 1 · local straightness: RMS of a line fit over [i − h, i + h].
  const h = Math.min(o.halfWindow, Math.floor((n - 1) / 4));
  const local = localLineRms(X, Y, h);
  const cand = new Uint8Array(n);
  for (let i = 0; i < n; i++) cand[i] = local[i] < o.localRms ? 1 : 0;

  // 2 · maximal runs of candidate points (cyclic), refined against a fitted line.
  let runs = cyclicRuns(cand).filter((r) => r.count >= Math.max(8, o.minStraight - 2 * h));
  runs = runs.map((r) => refineRun(X, Y, r, n)).filter((r): r is Run => r !== null);
  runs = mergeCollinear(X, Y, runs, n, o);
  runs = runs.filter((r) => {
    const f = fitLine(X, Y, r.start, r.count, n);
    // short runs must be straighter: a quiet stretch of tear can look straight over a few tens of px
    const rmsBound = o.maxRms * Math.sqrt(Math.min(1, r.count / (2 * o.minStraight)));
    return r.count >= o.minStraight && f.rms <= rmsBound && f.maxDev <= o.maxDev;
  });

  // 3 · the outline as alternating straight runs and torn gaps; tiny gaps between runs are rounded corners.
  runs = resolveOverlaps(runs, n);
  type Raw = { start: number; count: number; kind: SegmentKind };
  let raw: Raw[] = [];
  if (!runs.length) raw.push({ start: 0, count: n, kind: "torn" });
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    const next = runs[(r + 1) % runs.length];
    raw.push({ start: run.start, count: run.count, kind: "straight" });
    const gapStart = at(run.start + run.count);
    const gap = runs.length === 1 ? n - run.count : (next.start - gapStart + n) % n;
    if (gap > 0) raw.push({ start: gapStart, count: gap, kind: "torn" });
  }
  raw = absorbShortGaps(raw, o.minSegment, n);

  // 4 · split torn stretches at strong turns (local maxima of the turning angle at a coarse scale).
  const k = Math.min(o.cornerScale, Math.floor(n / 6));
  const turn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = at(i - k);
    const b = at(i + k);
    const v1x = X[i] - X[a];
    const v1y = Y[i] - Y[a];
    const v2x = X[b] - X[i];
    const v2y = Y[b] - Y[i];
    turn[i] = Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y);
  }
  const split: Raw[] = [];
  for (const seg of raw) {
    if (seg.kind !== "torn" || seg.count < 2 * o.minSegment) {
      split.push(seg);
      continue;
    }
    const cuts: number[] = [];
    const whole = seg.count === n;
    for (let q = whole ? 0 : o.minSegment; q < (whole ? n : seg.count - o.minSegment); q++) {
      const i = at(seg.start + q);
      const t = Math.abs(turn[i]);
      if (t < o.cornerTurn) continue;
      let isMax = true;
      for (let d = -k; d <= k && isMax; d++) {
        const v = Math.abs(turn[at(i + d)]);
        if (d && (v > t || (v === t && d < 0))) isMax = false;
      }
      if (isMax && (!cuts.length || q - cuts[cuts.length - 1] >= o.minSegment)) cuts.push(q);
    }
    if (whole && cuts.length >= 2 && n - cuts[cuts.length - 1] + cuts[0] < o.minSegment) cuts.pop();
    if (!cuts.length) {
      split.push(seg);
      continue;
    }
    if (whole) {
      for (let c = 0; c < cuts.length; c++) {
        const a = cuts[c];
        const b = c + 1 < cuts.length ? cuts[c + 1] : cuts[0] + n;
        split.push({ start: at(seg.start + a), count: b - a, kind: "torn" });
      }
    } else {
      let prev = 0;
      for (const c of [...cuts, seg.count]) {
        split.push({ start: at(seg.start + prev), count: c - prev, kind: "torn" });
        prev = c;
      }
    }
  }
  raw = split;

  const segments: Segment[] = raw.map((r, index) => {
    const seg: Segment = { index, kind: r.kind, start: at(r.start), count: r.count, length: arcLength(X, Y, r.start, r.count, n) };
    if (r.kind === "straight") {
      const f = fitLine(X, Y, r.start, r.count, n);
      seg.angle = f.angle;
      seg.rms = f.rms;
    }
    return seg;
  });
  const segmentOf = new Int32Array(n);
  const straight = new Uint8Array(n);
  for (const s of segments) {
    for (let q = 0; q < s.count; q++) {
      segmentOf[at(s.start + q)] = s.index;
      straight[at(s.start + q)] = s.kind === "straight" ? 1 : 0;
    }
  }

  // 5 · page corners: consecutive straight segments (allowing a short rounded gap) at ~90°, turning convex.
  const pageCorners: PageCorner[] = [];
  const m = segments.length;
  for (let s = 0; s < m && m > 1; s++) {
    const a = segments[s];
    if (a.kind !== "straight") continue;
    let gap = 0;
    let t = (s + 1) % m;
    while (t !== s && segments[t].kind === "torn" && gap + segments[t].length <= 16) {
      gap += segments[t].length;
      t = (t + 1) % m;
    }
    const b = segments[t];
    if (t === s || b.kind !== "straight") continue;
    const fa = fitLine(X, Y, a.start, a.count, n);
    const fb = fitLine(X, Y, b.start, b.count, n);
    const da = [Math.cos(fa.angle), Math.sin(fa.angle)];
    const db = [Math.cos(fb.angle), Math.sin(fb.angle)];
    const cross = da[0] * db[1] - da[1] * db[0];
    const ang = Math.acos(Math.min(1, Math.abs(da[0] * db[0] + da[1] * db[1])));
    if (cross <= 0 || Math.abs(ang - Math.PI / 2) > (14 * Math.PI) / 180) continue;
    // Intersection of the two lines.
    const det = da[0] * -db[1] - da[1] * -db[0];
    if (Math.abs(det) < 1e-9) continue;
    const rx = fb.cx - fa.cx;
    const ry = fb.cy - fa.cy;
    const u = (rx * -db[1] - ry * -db[0]) / det;
    pageCorners.push({ x: fa.cx + u * da[0] + mx, y: fa.cy + u * da[1] + my, segments: [a.index, b.index], angle: ang });
  }

  return { segments, straight, segmentOf, pageCorners };
}

/** RMS distance of the points in [i − h, i + h] to their best-fit line, per point (cyclic). */
function localLineRms(X: Float64Array, Y: Float64Array, h: number): Float64Array {
  const n = X.length;
  const len = n + 2 * h;
  const S = new Float64Array(5 * (len + 1));
  for (let k = 0; k < len; k++) {
    const i = (((k - h) % n) + n) % n;
    const x = X[i];
    const y = Y[i];
    S[5 * (k + 1)] = S[5 * k] + x;
    S[5 * (k + 1) + 1] = S[5 * k + 1] + y;
    S[5 * (k + 1) + 2] = S[5 * k + 2] + x * x;
    S[5 * (k + 1) + 3] = S[5 * k + 3] + y * y;
    S[5 * (k + 1) + 4] = S[5 * k + 4] + x * y;
  }
  const w = 2 * h + 1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = 5 * i;
    const b = 5 * (i + w);
    const sx = (S[b] - S[a]) / w;
    const sy = (S[b + 1] - S[a + 1]) / w;
    const sxx = (S[b + 2] - S[a + 2]) / w - sx * sx;
    const syy = (S[b + 3] - S[a + 3]) / w - sy * sy;
    const sxy = (S[b + 4] - S[a + 4]) / w - sx * sy;
    const lmin = (sxx + syy) / 2 - Math.sqrt(((sxx - syy) / 2) ** 2 + sxy * sxy);
    out[i] = Math.sqrt(Math.max(0, lmin));
  }
  return out;
}

type LineFit = { angle: number; cx: number; cy: number; rms: number; maxDev: number };

/** PCA line through points [start, start + count) (cyclic); angle oriented along the travel direction. */
export function fitLine(X: Float64Array, Y: Float64Array, start: number, count: number, n: number): LineFit {
  let sx = 0;
  let sy = 0;
  for (let q = 0; q < count; q++) {
    const i = (start + q) % n;
    sx += X[i];
    sy += Y[i];
  }
  const cx = sx / count;
  const cy = sy / count;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let q = 0; q < count; q++) {
    const i = (start + q) % n;
    const dx = X[i] - cx;
    const dy = Y[i] - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  let angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const first = start % n;
  const last = (start + count - 1) % n;
  if ((X[last] - X[first]) * Math.cos(angle) + (Y[last] - Y[first]) * Math.sin(angle) < 0) angle += Math.PI;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let ss = 0;
  let maxDev = 0;
  for (let q = 0; q < count; q++) {
    const i = (start + q) % n;
    const d = -(X[i] - cx) * s + (Y[i] - cy) * c;
    ss += d * d;
    if (Math.abs(d) > maxDev) maxDev = Math.abs(d);
  }
  return { angle, cx, cy, rms: Math.sqrt(ss / count), maxDev };
}

function cyclicRuns(flag: Uint8Array): Run[] {
  const n = flag.length;
  let first = -1;
  for (let i = 0; i < n; i++) {
    if (!flag[i]) {
      first = i;
      break;
    }
  }
  if (first < 0) return [{ start: 0, count: n }];
  const runs: Run[] = [];
  let k = 0;
  while (k < n) {
    const i = (first + k) % n;
    if (!flag[i]) {
      k++;
      continue;
    }
    const start = i;
    let count = 0;
    while (k < n && flag[(first + k) % n]) {
      count++;
      k++;
    }
    runs.push({ start, count });
  }
  return runs;
}

/** Grow or trim a candidate run so every point sits close to the run's own line. */
function refineRun(X: Float64Array, Y: Float64Array, r: Run, n: number): Run | null {
  let { start, count } = r;
  for (let iter = 0; iter < 4; iter++) {
    const f = fitLine(X, Y, start, count, n);
    const c = Math.cos(f.angle);
    const s = Math.sin(f.angle);
    const dev = (i: number) => Math.abs(-(X[i] - f.cx) * s + (Y[i] - f.cy) * c);
    const tol = Math.max(1.6, 2.2 * f.rms);
    // Trim ends that drift away (rounded corners), then grow while points stay on the line.
    while (count > 8 && dev(start % n) > tol) {
      start = (start + 1) % n;
      count--;
    }
    while (count > 8 && dev((start + count - 1) % n) > tol) count--;
    let grew = false;
    while (count < n - 2 && dev((start - 1 + n) % n) <= tol) {
      start = (start - 1 + n) % n;
      count++;
      grew = true;
    }
    while (count < n - 2 && dev((start + count) % n) <= tol) {
      count++;
      grew = true;
    }
    if (!grew) break;
  }
  return count >= 8 ? { start, count } : null;
}

/** Join neighbouring straight runs that lie on one line (a noise blob can split a page edge). */
function mergeCollinear(X: Float64Array, Y: Float64Array, runs: Run[], n: number, o: Required<EdgeOptions>): Run[] {
  if (runs.length < 2) return runs;
  const sorted = [...runs].sort((a, b) => a.start - b.start);
  let changed = true;
  while (changed && sorted.length > 1) {
    changed = false;
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      const j = (i + 1) % sorted.length;
      if (j === i) break;
      const b = sorted[j];
      const gap = (b.start - (a.start + a.count) + 2 * n) % n;
      if (gap > 18) continue;
      const merged = { start: a.start, count: a.count + gap + b.count };
      if (merged.count > n) continue;
      const f = fitLine(X, Y, merged.start, merged.count, n);
      if (f.rms <= o.maxRms && f.maxDev <= o.maxDev) {
        sorted.splice(i, 1, merged);
        sorted.splice(sorted.indexOf(b), 1);
        changed = true;
        break;
      }
    }
  }
  return sorted;
}

/** Sort runs cyclically and remove overlaps (a run inside another is dropped; partial overlaps split at the middle). */
function resolveOverlaps(runs: Run[], n: number): Run[] {
  let list = runs.map((r) => ({ ...r }));
  for (let guard = 0; guard < 4 * runs.length + 4 && list.length > 1; guard++) {
    list.sort((a, b) => a.start - b.start);
    let changed = false;
    for (let i = 0; i < list.length && !changed; i++) {
      const a = list[i];
      const b = list[(i + 1) % list.length];
      if (a === b) break;
      // b overlaps a exactly when b starts inside a's span
      const offset = (((b.start - a.start) % n) + n) % n;
      if (offset >= a.count) continue;
      if (offset + b.count <= a.count) list = list.filter((r) => r !== b);
      else {
        const over = a.count - offset;
        const keepA = Math.floor(over / 2);
        a.count -= over - keepA;
        b.start = (b.start + keepA) % n;
        b.count -= keepA;
      }
      changed = true;
    }
    if (!changed) break;
  }
  return list.sort((a, b) => a.start - b.start);
}

/** Torn gaps shorter than minLen between two straight runs are rounded corners or noise: share them out. */
function absorbShortGaps<T extends { start: number; count: number; kind: SegmentKind }>(segs: T[], minLen: number, n: number): T[] {
  const out = segs.map((s) => ({ ...s }));
  for (let i = 0; i < out.length && out.length > 2; i++) {
    const s = out[i];
    if (s.kind !== "torn" || s.count >= minLen) continue;
    const prev = out[(i - 1 + out.length) % out.length];
    const next = out[(i + 1) % out.length];
    if (prev.kind !== "straight" || next.kind !== "straight") continue;
    const half = Math.floor(s.count / 2);
    prev.count += half;
    next.start = (s.start + half) % n;
    next.count += s.count - half;
    out.splice(i, 1);
    i--;
  }
  return out;
}

function arcLength(X: Float64Array, Y: Float64Array, start: number, count: number, n: number): number {
  let s = 0;
  for (let q = 1; q < count; q++) {
    const i = (start + q - 1) % n;
    const j = (start + q) % n;
    s += Math.hypot(X[j] - X[i], Y[j] - Y[i]);
  }
  return s;
}
