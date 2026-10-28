// A small 2D geometry kit for the solver: rigid poses, closed polylines, a point grid, rigid fits and a dense solver.
// Points are interleaved Float64Arrays [x0, y0, x1, y1, …] in image pixels (x right, y down). Pure TypeScript.

/** Rigid transform p' = R(theta)·p + (tx, ty). With y pointing down, a positive theta turns clockwise on screen. */
export type Pose = { theta: number; tx: number; ty: number };

export const IDENTITY: Pose = { theta: 0, tx: 0, ty: 0 };

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  a = a % (2 * Math.PI);
  if (a <= -Math.PI) a += 2 * Math.PI;
  else if (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

/** Smallest absolute difference between two axial angles (lines; period π). */
export function axialDiff(a: number, b: number): number {
  let d = (a - b) % Math.PI;
  if (d < 0) d += Math.PI;
  return Math.min(d, Math.PI - d);
}

export function poseApply(p: Pose, x: number, y: number): [number, number] {
  const c = Math.cos(p.theta);
  const s = Math.sin(p.theta);
  return [c * x - s * y + p.tx, s * x + c * y + p.ty];
}

/** p ∘ q: first q, then p. */
export function poseCompose(p: Pose, q: Pose): Pose {
  const c = Math.cos(p.theta);
  const s = Math.sin(p.theta);
  return { theta: wrapAngle(p.theta + q.theta), tx: c * q.tx - s * q.ty + p.tx, ty: s * q.tx + c * q.ty + p.ty };
}

export function poseInvert(p: Pose): Pose {
  const c = Math.cos(p.theta);
  const s = Math.sin(p.theta);
  return { theta: -p.theta, tx: -(c * p.tx + s * p.ty), ty: -(-s * p.tx + c * p.ty) };
}

export function transformPoints(p: Pose, pts: Float64Array): Float64Array {
  const c = Math.cos(p.theta);
  const s = Math.sin(p.theta);
  const out = new Float64Array(pts.length);
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    out[i] = c * x - s * y + p.tx;
    out[i + 1] = s * x + c * y + p.ty;
  }
  return out;
}

/** How far apart two poses put a point (px), and their rotation difference (rad). */
export function poseDistance(p: Pose, q: Pose, x: number, y: number): { dist: number; dtheta: number } {
  const [ax, ay] = poseApply(p, x, y);
  const [bx, by] = poseApply(q, x, y);
  return { dist: Math.hypot(ax - bx, ay - by), dtheta: Math.abs(wrapAngle(p.theta - q.theta)) };
}

/** Shoelace area; positive when the interior lies on the (−dy, dx) side of each step. */
export function signedArea(pts: Float64Array): number {
  const n = pts.length / 2;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1];
  }
  return a / 2;
}

export function reverseClosed(pts: Float64Array): Float64Array {
  const n = pts.length / 2;
  const out = new Float64Array(pts.length);
  for (let i = 0; i < n; i++) {
    out[2 * i] = pts[2 * (n - 1 - i)];
    out[2 * i + 1] = pts[2 * (n - 1 - i) + 1];
  }
  return out;
}

export function polygonCentroid(pts: Float64Array): [number, number] {
  const n = pts.length / 2;
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const cr = pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1];
    a += cr;
    cx += (pts[2 * i] + pts[2 * j]) * cr;
    cy += (pts[2 * i + 1] + pts[2 * j + 1]) * cr;
  }
  if (Math.abs(a) < 1e-9) {
    for (let i = 0; i < n; i++) {
      cx += pts[2 * i];
      cy += pts[2 * i + 1];
    }
    return [cx / n, cy / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** Resample a closed polyline at (nearly) uniform arc-length spacing. */
export function resampleClosed(pts: Float64Array, spacing: number): Float64Array {
  const n = pts.length / 2;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    cum[i + 1] = cum[i] + Math.hypot(pts[2 * j] - pts[2 * i], pts[2 * j + 1] - pts[2 * i + 1]);
  }
  const total = cum[n];
  const m = Math.max(3, Math.round(total / spacing));
  const step = total / m;
  const out = new Float64Array(2 * m);
  let seg = 0;
  for (let k = 0; k < m; k++) {
    const s = k * step;
    while (seg < n - 1 && cum[seg + 1] < s) seg++;
    const i = seg;
    const j = (seg + 1) % n;
    const len = cum[seg + 1] - cum[seg];
    const t = len > 0 ? (s - cum[seg]) / len : 0;
    out[2 * k] = pts[2 * i] + t * (pts[2 * j] - pts[2 * i]);
    out[2 * k + 1] = pts[2 * i + 1] + t * (pts[2 * j + 1] - pts[2 * i + 1]);
  }
  return out;
}

/** Gaussian smoothing of a closed polyline's coordinates (sigma in samples). */
export function smoothClosed(pts: Float64Array, sigma: number): Float64Array {
  const n = pts.length / 2;
  if (sigma <= 0 || n < 5) return pts.slice();
  const r = Math.min(Math.ceil(3 * sigma), Math.floor((n - 1) / 2));
  const k = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += k[i + r];
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const out = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    let x = 0;
    let y = 0;
    for (let d = -r; d <= r; d++) {
      const j = (i + d + n) % n;
      x += k[d + r] * pts[2 * j];
      y += k[d + r] * pts[2 * j + 1];
    }
    out[2 * i] = x;
    out[2 * i + 1] = y;
  }
  return out;
}

/**
 * A uniform grid over a point set for nearest-neighbour queries. `ids` (optional) restricts the grid to a subset of
 * the points (indices into `pts`); queries return indices into `pts`.
 */
export class PointGrid {
  readonly cell: number;
  readonly x0: number;
  readonly y0: number;
  readonly nx: number;
  readonly ny: number;
  private readonly start: Int32Array;
  private readonly items: Int32Array;
  readonly pts: Float64Array;

  constructor(pts: Float64Array, cell: number, ids?: ArrayLike<number>) {
    this.pts = pts;
    this.cell = cell;
    const list = ids ?? Array.from({ length: pts.length / 2 }, (_, i) => i);
    let minx = Infinity;
    let miny = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      const x = pts[2 * i];
      const y = pts[2 * i + 1];
      if (x < minx) minx = x;
      if (y < miny) miny = y;
      if (x > maxx) maxx = x;
      if (y > maxy) maxy = y;
    }
    if (!list.length) minx = miny = maxx = maxy = 0;
    this.x0 = minx;
    this.y0 = miny;
    this.nx = Math.max(1, Math.floor((maxx - minx) / cell) + 1);
    this.ny = Math.max(1, Math.floor((maxy - miny) / cell) + 1);
    const counts = new Int32Array(this.nx * this.ny + 1);
    const cellOf = new Int32Array(list.length);
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      const cx = Math.floor((pts[2 * i] - minx) / cell);
      const cy = Math.floor((pts[2 * i + 1] - miny) / cell);
      cellOf[k] = cy * this.nx + cx;
      counts[cellOf[k] + 1]++;
    }
    for (let c = 0; c < this.nx * this.ny; c++) counts[c + 1] += counts[c];
    this.start = counts;
    this.items = new Int32Array(list.length);
    const fill = counts.slice(0, this.nx * this.ny);
    for (let k = 0; k < list.length; k++) this.items[fill[cellOf[k]]++] = list[k];
  }

  /** Index of the nearest point within maxDist of (x, y), or -1. */
  nearest(x: number, y: number, maxDist: number): number {
    const cx0 = Math.max(0, Math.floor((x - maxDist - this.x0) / this.cell));
    const cx1 = Math.min(this.nx - 1, Math.floor((x + maxDist - this.x0) / this.cell));
    const cy0 = Math.max(0, Math.floor((y - maxDist - this.y0) / this.cell));
    const cy1 = Math.min(this.ny - 1, Math.floor((y + maxDist - this.y0) / this.cell));
    let best = -1;
    let bd = maxDist * maxDist;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = cy * this.nx + cx;
        for (let k = this.start[c]; k < this.start[c + 1]; k++) {
          const i = this.items[k];
          const dx = this.pts[2 * i] - x;
          const dy = this.pts[2 * i + 1] - y;
          const d = dx * dx + dy * dy;
          if (d <= bd) {
            bd = d;
            best = i;
          }
        }
      }
    }
    return best;
  }
}

/**
 * Least-squares rigid transform taking points a onto points b (pairs in order, optional weights): Kabsch in 2D.
 * Returns the pose and the weighted RMS residual.
 */
export function fitRigid(a: Float64Array, b: Float64Array, w?: Float64Array): { pose: Pose; rms: number } {
  const n = a.length / 2;
  let sw = 0;
  let ax = 0;
  let ay = 0;
  let bx = 0;
  let by = 0;
  for (let i = 0; i < n; i++) {
    const wi = w ? w[i] : 1;
    sw += wi;
    ax += wi * a[2 * i];
    ay += wi * a[2 * i + 1];
    bx += wi * b[2 * i];
    by += wi * b[2 * i + 1];
  }
  if (sw <= 0) return { pose: { ...IDENTITY }, rms: Infinity };
  ax /= sw;
  ay /= sw;
  bx /= sw;
  by /= sw;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const wi = w ? w[i] : 1;
    const pax = a[2 * i] - ax;
    const pay = a[2 * i + 1] - ay;
    const pbx = b[2 * i] - bx;
    const pby = b[2 * i + 1] - by;
    sxx += wi * (pax * pbx + pay * pby);
    sxy += wi * (pax * pby - pay * pbx);
  }
  const theta = Math.atan2(sxy, sxx);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const pose = { theta, tx: bx - (c * ax - s * ay), ty: by - (s * ax + c * ay) };
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const wi = w ? w[i] : 1;
    const x = c * a[2 * i] - s * a[2 * i + 1] + pose.tx - b[2 * i];
    const y = s * a[2 * i] + c * a[2 * i + 1] + pose.ty - b[2 * i + 1];
    ss += wi * (x * x + y * y);
  }
  return { pose, rms: Math.sqrt(ss / sw) };
}

/** Solve the symmetric positive-definite system A·x = b (A row-major n×n) by Cholesky; adds `ridge` to the diagonal. */
export function solveSPD(A: Float64Array, b: Float64Array, n: number, ridge = 1e-9): Float64Array {
  const L = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * n + j] + (i === j ? ridge : 0);
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k];
      if (i === j) L[i * n + i] = Math.sqrt(Math.max(s, 1e-12));
      else L[i * n + j] = s / L[j * n + j];
    }
  }
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i * n + k] * y[k];
    y[i] = s / L[i * n + i];
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k];
    x[i] = s / L[i * n + i];
  }
  return x;
}

/** A tiny deterministic PRNG (mulberry32) for reproducible choices inside the solver and its tests. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
