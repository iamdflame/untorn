// The straight sides of a piece cut along straight lines (scissors, guillotines, ShredBench's Voronoi cells).
//
// A Voronoi cell is a convex polygon: a few long straight sides meeting at sharp corners. Two things get in the way.
// The cut is jagged by a pixel or two and the render bends a side gently (paper curl), and a page border can render
// as a rounded bulge. So the outline is classified by how much it turns over a fixed scale (±h px): a side turns
// almost nothing, a corner turns sharply over about 2h px, and a bulge keeps turning. Straight runs that one line still
// fits are merged across small kinks. Consecutive straight sides meet at a vertex where their lines intersect; a side
// next to a bulge has an "open" end whose true corner is hidden.

import { fitLine } from "./edges";

export type PolygonOptions = {
  /** Scale (px) of the turning angle: chords from i − h to i and from i to i + h. */
  scale: number;
  /** Largest turn (rad) over that scale on a straight side. */
  maxTurn: number;
  /** Shortest straight side (px). */
  minLength: number;
  /** Largest RMS (px) and largest deviation (px) of a straight side's outline from its line, and how both grow with
   *  the side's length (a long side may bow by a few px: the render bends paper near a piece's bounding box). */
  maxRms: number;
  maxDev: number;
  rmsPerPx: number;
  devPerPx: number;
  /** Straight runs closer than this in direction (rad), across a kink of at most `kink` px, merge. */
  mergeAngle: number;
  kink: number;
  /** A corner may lie up to cornerReach px beyond the ends of its two straight runs (a blunted acute tip), across a
   *  curved stretch of up to cornerSpan px that stays inside the wedge; and up to cornerGap px short of them. */
  cornerGap: number;
  cornerReach: number;
  cornerSpan: number;
};

export const POLYGON_DEFAULTS: PolygonOptions = {
  scale: 32,
  maxTurn: (10 * Math.PI) / 180,
  minLength: 32,
  maxRms: 1.6,
  maxDev: 5,
  rmsPerPx: 0.003,
  devPerPx: 0.008,
  mergeAngle: (6 * Math.PI) / 180,
  kink: 48,
  cornerGap: 24,
  cornerReach: 180,
  cornerSpan: 260,
};

export type SideEnd = {
  /** True when a straight neighbour meets this end at a corner (the vertex is the lines' intersection). */
  vertex: boolean;
  /** Interior angle of the piece at that corner (rad), when it is a vertex. */
  angle: number | null;
  /** The neighbouring side across this end. */
  neighbour: number;
};

export type Side = {
  index: number;
  kind: "straight" | "curved";
  /** First outline index and number of outline points (cyclic). */
  start: number;
  count: number;
  /** Ends in travel order; at a vertex, the corner itself. */
  p0: [number, number];
  p1: [number, number];
  /** Unit direction p0 → p1 along the outline's travel (straight sides: the fitted line's). */
  dir: [number, number];
  length: number;
  /** RMS and largest deviation of the side's outline points from its line (px). */
  rms: number;
  maxDev: number;
  ends: [SideEnd, SideEnd];
};

export type PolygonShape = { sides: Side[]; perimeter: number; straightLength: number };

/** Intersection of two lines given by a point and a direction. */
export function intersectLines(p: [number, number], u: [number, number], q: [number, number], v: [number, number]): [number, number] | null {
  const det = u[0] * v[1] - u[1] * v[0];
  if (Math.abs(det) < 1e-9) return null;
  const t = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / det;
  return [p[0] + t * u[0], p[1] + t * u[1]];
}

type Run = { start: number; count: number };

/** Cyclic moving average of radius r, applied twice (a triangular kernel). */
function boxSmooth(v: Float64Array, r: number): Float64Array {
  const n = v.length;
  let cur = v;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float64Array(n);
    let s = 0;
    for (let d = -r; d <= r; d++) s += cur[((d % n) + n) % n];
    for (let i = 0; i < n; i++) {
      out[i] = s / (2 * r + 1);
      s += cur[(i + r + 1) % n] - cur[(((i - r) % n) + n) % n];
    }
    cur = out;
  }
  return cur;
}

/** The polygon of a closed outline (interleaved [x, y, …], ~1 px spacing, positive signed area). */
export function polygonOf(outline: Float64Array, options: Partial<PolygonOptions> = {}): PolygonShape {
  const o = { ...POLYGON_DEFAULTS, ...options };
  const n = outline.length / 2;
  const X = new Float64Array(n);
  const Y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    X[i] = outline[2 * i];
    Y[i] = outline[2 * i + 1];
  }
  const at = (i: number) => ((i % n) + n) % n;
  let perimeter = 0;
  for (let i = 0; i < n; i++) perimeter += Math.hypot(X[at(i + 1)] - X[i], Y[at(i + 1)] - Y[i]);
  const h = Math.max(2, Math.min(o.scale, Math.floor(n / 8)));

  // 1 · turning angle over ±h on a smoothed copy (the cut's jaggies average out); flat points turn less than maxTurn
  const SX = boxSmooth(X, 3);
  const SY = boxSmooth(Y, 3);
  const flat = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = at(i - h);
    const c = at(i + h);
    const v1x = SX[i] - SX[a];
    const v1y = SY[i] - SY[a];
    const v2x = SX[c] - SX[i];
    const v2y = SY[c] - SY[i];
    const turn = Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y);
    flat[i] = Math.abs(turn) < o.maxTurn ? 1 : 0;
  }

  // 2 · maximal flat runs (cyclic)
  let runs: Run[] = [];
  const firstBreak = flat.indexOf(0);
  if (firstBreak < 0) runs.push({ start: 0, count: n });
  else {
    for (let q = 0; q < n; q++) {
      const i = at(firstBreak + q);
      if (!flat[i]) continue;
      if (flat[at(i - 1)] && q > 0) continue;
      let len = 0;
      while (len < n && flat[at(i + len)]) len++;
      runs.push({ start: i, count: len });
    }
  }
  const fit = (r: Run) => fitLine(X, Y, r.start, Math.max(2, r.count), n);
  const good = (r: Run) => {
    const f = fit(r);
    return f.rms <= Math.max(o.maxRms, o.rmsPerPx * r.count) && f.maxDev <= Math.max(o.maxDev, o.devPerPx * r.count);
  };
  runs = runs.filter((r) => r.count >= 4);
  // a flat run that no line fits holds a corner too shallow to turn the outline much (two cuts meeting at ~170°):
  // split it where it strays furthest from its chord, as Douglas–Peucker would, until each piece fits a line
  const split = (r: Run): Run[] => {
    if (r.count < 2 * Math.max(8, h) || good(r)) return [r];
    const a = r.start;
    const b = at(r.start + r.count - 1);
    const dx = X[b] - X[a];
    const dy = Y[b] - Y[a];
    const L = Math.hypot(dx, dy) || 1;
    let far = -1;
    let fd = -1;
    for (let q = Math.max(8, h); q < r.count - Math.max(8, h); q++) {
      const i = at(a + q);
      const d = Math.abs((X[i] - X[a]) * dy - (Y[i] - Y[a]) * dx) / L;
      if (d > fd) {
        fd = d;
        far = q;
      }
    }
    if (far < 0) return [r];
    return [...split({ start: a, count: far }), ...split({ start: at(a + far), count: r.count - far })];
  };
  runs = runs.flatMap(split);

  // 3 · merge neighbours that one line still fits, across small kinks (a bend or a nick in one long side)
  let merged = true;
  while (merged && runs.length > 1) {
    merged = false;
    for (let k = 0; k < runs.length; k++) {
      const a = runs[k];
      const b = runs[(k + 1) % runs.length];
      const gap = (b.start - (a.start + a.count) + 2 * n) % n;
      if (gap > o.kink) continue;
      const fa = fit(a);
      const fb = fit(b);
      let d = Math.abs(fa.angle - fb.angle) % (2 * Math.PI);
      d = Math.min(d, 2 * Math.PI - d);
      // short runs have noisy directions; the merged fit is the real test
      if (d > o.mergeAngle && Math.min(a.count, b.count) > 3 * h) continue;
      const m = { start: a.start, count: Math.min(n, a.count + gap + b.count) };
      if (!good(m)) continue;
      if (k + 1 < runs.length) runs.splice(k, 2, m);
      else {
        runs[0] = m;
        runs.pop();
      }
      merged = true;
      break;
    }
  }
  // the turn window reaches h past a run's flat points into a corner: grow each run by up to h/2 at both ends, as far
  // as its line still fits and without crossing into a neighbour
  runs = runs.map((r, k) => {
    const prev = runs[(k - 1 + runs.length) % runs.length];
    const next = runs[(k + 1) % runs.length];
    const room0 = runs.length > 1 ? Math.floor(((r.start - (prev.start + prev.count) + 2 * n) % n) / 2) : h;
    const room1 = runs.length > 1 ? Math.floor(((next.start - (r.start + r.count) + 2 * n) % n) / 2) : h;
    let g = r;
    for (let grow = Math.min(Math.floor(h / 2), room0, room1); grow > 0; grow = Math.floor(grow / 2)) {
      const cand = { start: at(r.start - grow), count: Math.min(n - 1, r.count + 2 * grow) };
      if (good(cand)) {
        g = cand;
        break;
      }
    }
    return g;
  });

  // 4 · sides: straight runs, and the curved stretches between them
  const straightRuns = runs.filter((r) => r.count - 1 >= o.minLength && good(r)).sort((x, y) => x.start - y.start);
  type Raw = { start: number; count: number; straight: boolean };
  const raw: Raw[] = [];
  if (!straightRuns.length) raw.push({ start: 0, count: n, straight: false });
  for (let k = 0; k < straightRuns.length; k++) {
    const r = straightRuns[k];
    const next = straightRuns[(k + 1) % straightRuns.length];
    raw.push({ start: r.start, count: r.count, straight: true });
    const end = r.start + r.count;
    let gap = straightRuns.length === 1 ? n - r.count : (next.start - end + 2 * n) % n;
    if (gap > n / 2 && straightRuns.length > 1) gap = 0; // neighbours that touch or overlap by a point
    if (gap > 0) raw.push({ start: at(end), count: gap + 1, straight: false });
  }

  const sides: Side[] = raw.map((r, index) => {
    const f = fitLine(X, Y, r.start, Math.max(2, r.count), n);
    const c = Math.cos(f.angle);
    const s = Math.sin(f.angle);
    const proj = (i: number): [number, number] => {
      const t = (X[i] - f.cx) * c + (Y[i] - f.cy) * s;
      return [f.cx + t * c, f.cy + t * s];
    };
    const a = at(r.start);
    const b = at(r.start + r.count - 1);
    const p0: [number, number] = r.straight ? proj(a) : [X[a], Y[a]];
    const p1: [number, number] = r.straight ? proj(b) : [X[b], Y[b]];
    return {
      index,
      kind: r.straight ? "straight" : "curved",
      start: a,
      count: r.count,
      p0,
      p1,
      dir: [c, s],
      length: Math.hypot(p1[0] - p0[0], p1[1] - p0[1]),
      rms: f.rms,
      maxDev: f.maxDev,
      ends: [
        { vertex: false, angle: null, neighbour: (index - 1 + raw.length) % raw.length },
        { vertex: false, angle: null, neighbour: (index + 1) % raw.length },
      ],
    } satisfies Side;
  });

  // 5 · vertices: consecutive straight sides meet where their lines cross. A rounded or blunted tip between them is
  //     fine as long as it stays inside the wedge of the two lines; a bulge that crosses either line hides the corner.
  const k = sides.length;
  for (let q = 0; q < k && k > 1; q++) {
    const A = sides[q];
    if (A.kind !== "straight") continue;
    let t = (q + 1) % k;
    let gap: Side | null = null;
    if (sides[t].kind !== "straight") {
      if (k < 3 || sides[t].count - 1 > o.cornerSpan) continue;
      gap = sides[t];
      t = (t + 1) % k;
    }
    const B = sides[t];
    if (B.kind !== "straight" || t === q) continue;
    const turn = Math.atan2(A.dir[0] * B.dir[1] - A.dir[1] * B.dir[0], A.dir[0] * B.dir[0] + A.dir[1] * B.dir[1]);
    // a cell is convex: only a turn towards the interior is a corner
    if (turn < o.mergeAngle) continue;
    const x = intersectLines(A.p1, A.dir, B.p0, B.dir);
    if (!x) continue;
    const dA = (x[0] - A.p1[0]) * A.dir[0] + (x[1] - A.p1[1]) * A.dir[1];
    const dB = (B.p0[0] - x[0]) * B.dir[0] + (B.p0[1] - x[1]) * B.dir[1];
    if (dA < -o.cornerGap || dB < -o.cornerGap || dA > o.cornerReach || dB > o.cornerReach) continue;
    if (gap) {
      // outward distance from a side's line: interior lies on the (−dy, dx) side
      const out = (S: Side, px: number, py: number) => (px - S.p1[0]) * S.dir[1] - (py - S.p1[1]) * S.dir[0];
      let inside = true;
      for (let m = 0; m < gap.count && inside; m += 2) {
        const i = at(gap.start + m);
        if (out(A, X[i], Y[i]) > 3 || out(B, X[i], Y[i]) > 3) inside = false;
      }
      if (!inside) continue;
    }
    A.p1 = x;
    B.p0 = [x[0], x[1]];
    const interior = Math.PI - turn;
    A.ends[1] = { vertex: true, angle: interior, neighbour: t };
    B.ends[0] = { vertex: true, angle: interior, neighbour: q };
  }
  let straightLength = 0;
  for (const s of sides) {
    s.length = Math.hypot(s.p1[0] - s.p0[0], s.p1[1] - s.p0[1]);
    if (s.kind === "straight") straightLength += s.length;
  }
  return { sides, perimeter, straightLength };
}
