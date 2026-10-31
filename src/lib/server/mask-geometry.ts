// Raster geometry for fragment masks: components, holes, outlines, IoU, resampling and edge snapping.
//
// Coordinates are continuous photo pixels: pixel (x, y) covers [x, x+1) × [y, y+1), so its centre is (x+0.5, y+0.5).
// A PlacedMask is a 0/1 raster whose top-left pixel sits at (x, y) in the photo.

import type { Rgb } from "./images";

export type PlacedMask = { x: number; y: number; width: number; height: number; data: Uint8Array };
export type Point = [number, number];

export function maskArea(m: PlacedMask): number {
  let n = 0;
  for (let i = 0; i < m.data.length; i++) n += m.data[i];
  return n;
}

/** Tight box of the set pixels, inclusive, in photo pixels; null when empty. */
export function maskBox(m: PlacedMask): [number, number, number, number] | null {
  let x1 = Infinity, y1 = Infinity, x2 = -1, y2 = -1;
  for (let y = 0; y < m.height; y++) {
    const row = y * m.width;
    for (let x = 0; x < m.width; x++) {
      if (!m.data[row + x]) continue;
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
    }
  }
  return x2 < 0 ? null : [m.x + x1, m.y + y1, m.x + x2, m.y + y2];
}

/** Crop a mask to its tight box (an empty mask stays 1×1 and empty). */
export function trimMask(m: PlacedMask): PlacedMask {
  const b = maskBox(m);
  if (!b) return { x: m.x, y: m.y, width: 1, height: 1, data: new Uint8Array(1) };
  const [x1, y1, x2, y2] = b;
  const width = x2 - x1 + 1, height = y2 - y1 + 1;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const src = (y1 - m.y + y) * m.width + (x1 - m.x);
    data.set(m.data.subarray(src, src + width), y * width);
  }
  return { x: x1, y: y1, width, height, data };
}

/** Keep the largest 8-connected component. */
export function largestComponent(m: PlacedMask): PlacedMask {
  const { width: w, height: h, data } = m;
  const label = new Int32Array(w * h);
  const queue = new Int32Array(w * h);
  let best = 0, bestSize = 0, next = 0;
  for (let s = 0; s < data.length; s++) {
    if (!data[s] || label[s]) continue;
    next++;
    let head = 0, tail = 0, size = 0;
    queue[tail++] = s;
    label[s] = next;
    while (head < tail) {
      const p = queue[head++];
      size++;
      const px = p % w, py = (p - px) / w;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (data[q] && !label[q]) {
            label[q] = next;
            queue[tail++] = q;
          }
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
  }
  const out = new Uint8Array(w * h);
  if (best) for (let i = 0; i < out.length; i++) out[i] = label[i] === best ? 1 : 0;
  return { ...m, data: out };
}

/** Fill every background region not 4-connected to the raster border. */
export function fillHoles(m: PlacedMask): PlacedMask {
  const { width: w, height: h, data } = m;
  const outside = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let tail = 0;
  const seed = (i: number) => {
    if (!data[i] && !outside[i]) {
      outside[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  for (let head = 0; head < tail; head++) {
    const p = queue[head];
    const px = p % w, py = (p - px) / w;
    if (px > 0) seed(p - 1);
    if (px < w - 1) seed(p + 1);
    if (py > 0) seed(p - w);
    if (py < h - 1) seed(p + w);
  }
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = outside[i] ? 0 : 1;
  return { ...m, data: out };
}

/** Largest component, holes filled, trimmed: what a paper fragment's mask should be. */
export function cleanFragmentMask(m: PlacedMask): PlacedMask {
  return trimMask(fillHoles(largestComponent(m)));
}

export function maskIoU(a: PlacedMask, b: PlacedMask): number {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
  let inter = 0;
  for (let y = y1; y < y2; y++) {
    const ra = (y - a.y) * a.width - a.x, rb = (y - b.y) * b.width - b.x;
    for (let x = x1; x < x2; x++) if (a.data[ra + x] && b.data[rb + x]) inter++;
  }
  const union = maskArea(a) + maskArea(b) - inter;
  return union ? inter / union : 0;
}

/** Share of a's pixels that b also covers. */
export function maskCoverage(a: PlacedMask, b: PlacedMask): number {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
  let inter = 0;
  for (let y = y1; y < y2; y++) {
    const ra = (y - a.y) * a.width - a.x, rb = (y - b.y) * b.width - b.x;
    for (let x = x1; x < x2; x++) if (a.data[ra + x] && b.data[rb + x]) inter++;
  }
  const area = maskArea(a);
  return area ? inter / area : 0;
}

/**
 * Pairs of pieces (indices into `masks`) that touch or lie on one another: their masks come within `gap` px along at
 * least `minContact` px, or overlap. Where two pieces touch, one edge hides under the other or the two blur together,
 * so neither edge can be matched. Checked on a grid of `cell` px (each cell set when any pixel in it is), so a 24 MP
 * photo takes milliseconds.
 */
export function touchingPairs(masks: PlacedMask[], { gap = 6, minContact = 40, cell = 4 } = {}): [number, number][] {
  const grids = masks.map((m) => {
    const gx0 = Math.floor(m.x / cell);
    const gy0 = Math.floor(m.y / cell);
    const w = Math.floor((m.x + m.width - 1) / cell) - gx0 + 1;
    const h = Math.floor((m.y + m.height - 1) / cell) - gy0 + 1;
    const g = new Uint8Array(Math.max(0, w * h));
    for (let r = 0; r < m.height; r++) {
      const row = (Math.floor((m.y + r) / cell) - gy0) * w;
      for (let c = 0; c < m.width; c++) if (m.data[r * m.width + c]) g[row + Math.floor((m.x + c) / cell) - gx0] = 1;
    }
    return { gx0, gy0, w, h, g };
  });
  const reach = Math.ceil(gap / cell);
  const out: [number, number][] = [];
  for (let i = 0; i < grids.length; i++) {
    for (let j = i + 1; j < grids.length; j++) {
      const A = grids[i];
      const B = grids[j];
      if (A.gx0 > B.gx0 + B.w - 1 + reach || B.gx0 > A.gx0 + A.w - 1 + reach || A.gy0 > B.gy0 + B.h - 1 + reach || B.gy0 > A.gy0 + A.h - 1 + reach) continue;
      // cells of A with a cell of B within reach: a contact line of L px gives about L / cell of them
      let contact = 0;
      for (let y = 0; y < A.h; y++) {
        for (let x = 0; x < A.w; x++) {
          if (!A.g[y * A.w + x]) continue;
          let near = false;
          for (let dy = -reach; dy <= reach && !near; dy++) {
            const by = A.gy0 + y + dy - B.gy0;
            if (by < 0 || by >= B.h) continue;
            for (let dx = -reach; dx <= reach; dx++) {
              const bx = A.gx0 + x + dx - B.gx0;
              if (bx >= 0 && bx < B.w && B.g[by * B.w + bx]) {
                near = true;
                break;
              }
            }
          }
          if (near) contact++;
        }
      }
      if (contact * cell >= minContact) out.push([i, j]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Outline tracing

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/**
 * The outer outline of the mask as a closed polygon (first point not repeated), clockwise on screen, in photo pixels.
 * Follows the pixel-edge cracks around the largest outer loop (diagonal touches stay joined), puts a vertex at the
 * middle of every crack (the marching-squares outline), then simplifies with Ramer–Douglas–Peucker at `epsilon` px.
 */
export function traceOutline(m: PlacedMask, epsilon = 0.5): Point[] {
  const { width: w, height: h, data } = m;
  const W = w + 1;
  const V = W * (h + 1);
  const out = new Uint8Array(V); // bit d set: an outgoing crack in direction d starts at this corner
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && data[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!data[y * w + x]) continue;
      if (!inside(x, y - 1)) out[y * W + x] |= 1 << 0; // top: (x,y) → (x+1,y)
      if (!inside(x + 1, y)) out[y * W + x + 1] |= 1 << 1; // right: (x+1,y) → (x+1,y+1)
      if (!inside(x, y + 1)) out[(y + 1) * W + x + 1] |= 1 << 2; // bottom: (x+1,y+1) → (x,y+1)
      if (!inside(x - 1, y)) out[(y + 1) * W + x] |= 1 << 3; // left: (x,y+1) → (x,y)
    }
  }
  const used = new Uint8Array(V);
  let bestLoop: number[] | null = null;
  let bestArea = 0;
  for (let s = 0; s < V; s++) {
    while (out[s] & ~used[s]) {
      const free = out[s] & ~used[s];
      let d = free & 1 ? 0 : free & 2 ? 1 : free & 4 ? 2 : 3;
      let v = s;
      const loop: number[] = [];
      let area2 = 0;
      for (let guard = 0; guard < 4 * V; guard++) {
        used[v] |= 1 << d;
        loop.push(v);
        const vx = v % W, vy = (v - vx) / W;
        const nv = v + DX[d] + DY[d] * W;
        area2 += vx * (vy + DY[d]) - (vx + DX[d]) * vy;
        v = nv;
        const avail = out[v] & ~used[v];
        if (!avail) break;
        // prefer turning left (keeps diagonal touches joined), then straight, then right
        const pref = [(d + 3) % 4, d, (d + 1) % 4];
        const nd = pref.find((k) => avail & (1 << k));
        if (nd === undefined) break;
        d = nd;
      }
      if (area2 > bestArea) {
        bestArea = area2;
        bestLoop = loop;
      }
    }
  }
  if (!bestLoop || bestLoop.length < 3) return [];
  const n = bestLoop.length;
  const pts: Point[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = bestLoop[i], b = bestLoop[(i + 1) % n];
    const ax = a % W, ay = (a - ax) / W, bx = b % W, by = (b - bx) / W;
    pts[i] = [m.x + (ax + bx) / 2, m.y + (ay + by) / 2];
  }
  return simplifyClosed(pts, epsilon);
}

function segDist2(p: Point, a: Point, b: Point): number {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const wx = p[0] - a[0], wy = p[1] - a[1];
  const L = vx * vx + vy * vy;
  const t = L ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / L)) : 0;
  const dx = wx - t * vx, dy = wy - t * vy;
  return dx * dx + dy * dy;
}

function rdp(pts: Point[], first: number, last: number, eps2: number, keep: Uint8Array): void {
  const stack: [number, number][] = [[first, last]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    let best = -1, bestD = eps2;
    for (let k = i + 1; k < j; k++) {
      const d = segDist2(pts[k], pts[i], pts[j]);
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i, best], [best, j]);
    }
  }
}

/** Ramer–Douglas–Peucker on a closed polygon. */
export function simplifyClosed(pts: Point[], epsilon: number): Point[] {
  const n = pts.length;
  if (n < 4 || epsilon <= 0) return pts;
  let far = 0, farD = -1;
  for (let k = 1; k < n; k++) {
    const d = (pts[k][0] - pts[0][0]) ** 2 + (pts[k][1] - pts[0][1]) ** 2;
    if (d > farD) {
      farD = d;
      far = k;
    }
  }
  const ring = [...pts, pts[0]];
  const keep = new Uint8Array(n + 1);
  keep[0] = keep[far] = keep[n] = 1;
  const eps2 = epsilon * epsilon;
  rdp(ring, 0, far, eps2, keep);
  rdp(ring, far, n, eps2, keep);
  const outPts: Point[] = [];
  for (let k = 0; k < n; k++) if (keep[k]) outPts.push(pts[k]);
  return outPts;
}

export function polygonArea(poly: Point[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

// ---------------------------------------------------------------------------------------------------------------
// Resampling a low-resolution mask, and snapping it to the paper edge in the full-resolution photo

/**
 * Bilinear upsampling of a 0/1 mask given in a coarser frame (`scale` = full-res px per coarse px), over a region of
 * the full-resolution photo. Returns soft values 0..1 per full-res pixel of the region.
 */
export function upsampleMask(coarse: PlacedMask, scale: number, region: { x: number; y: number; width: number; height: number }): Float32Array {
  const { width: rw, height: rh } = region;
  const soft = new Float32Array(rw * rh);
  const at = (cx: number, cy: number) => {
    const lx = cx - coarse.x, ly = cy - coarse.y;
    return lx >= 0 && ly >= 0 && lx < coarse.width && ly < coarse.height ? coarse.data[ly * coarse.width + lx] : 0;
  };
  for (let y = 0; y < rh; y++) {
    const v = (region.y + y + 0.5) / scale - 0.5;
    const y0 = Math.floor(v), fy = v - y0;
    for (let x = 0; x < rw; x++) {
      const u = (region.x + x + 0.5) / scale - 0.5;
      const x0 = Math.floor(u), fx = u - x0;
      const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
      const bot = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
      soft[y * rw + x] = top * (1 - fy) + bot * fy;
    }
  }
  return soft;
}

/** Two-pass chamfer distance (in px, 3-4 weights) from every pixel to the nearest pixel where `src` is 0. */
function chamfer(src: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = src[i] ? INF : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - w] + 3);
        if (x > 0) v = Math.min(v, d[i - w - 1] + 4);
        if (x < w - 1) v = Math.min(v, d[i - w + 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      if (x < w - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < h - 1) {
        v = Math.min(v, d[i + w] + 3);
        if (x < w - 1) v = Math.min(v, d[i + w + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + w - 1] + 4);
      }
      d[i] = v;
    }
  }
  for (let i = 0; i < d.length; i++) d[i] = d[i] >= INF ? 1e6 : d[i] / 3;
  return d;
}

/**
 * Up to `n` points deep inside the mask (photo pixels, pixel centres), spread out: the deepest pixel first, then the
 * deepest ones far from those already chosen. Good positive point prompts for a thin or oddly shaped fragment.
 */
export function interiorPoints(m: PlacedMask, n = 3): Point[] {
  const d = chamfer(m.data, m.width, m.height);
  let max = 0;
  for (let i = 0; i < d.length; i++) if (m.data[i] && d[i] > max) max = d[i];
  if (!max) return [];
  const diag = Math.hypot(m.width, m.height);
  const pts: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    let best = -1, bestD = 0;
    for (let i = 0; i < d.length; i++) {
      if (!m.data[i] || d[i] < 0.4 * max || d[i] <= bestD) continue;
      const x = i % m.width, y = (i - x) / m.width;
      if (pts.some(([px, py]) => Math.hypot(px - x, py - y) < 0.3 * diag)) continue;
      best = i;
      bestD = d[i];
    }
    if (best < 0) break;
    pts.push([best % m.width, Math.floor(best / m.width)]);
  }
  return pts.map(([x, y]) => [m.x + x + 0.5, m.y + y + 0.5]);
}

type Gauss = { mean: [number, number, number]; inv: number[] } | null;

function fitGauss(samples: number[][]): Gauss {
  const n = samples.length;
  if (n < 12) return null;
  const mean: [number, number, number] = [0, 0, 0];
  for (const s of samples) for (let k = 0; k < 3; k++) mean[k] += s[k] / n;
  const c = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const s of samples) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) c[i * 3 + j] += ((s[i] - mean[i]) * (s[j] - mean[j])) / n;
  for (let i = 0; i < 3; i++) c[i * 4] += 9; // regularise: at least a 3-level spread per channel
  const [a, b, cc, d, e, f, g, h, k] = c;
  const det = a * (e * k - f * h) - b * (d * k - f * g) + cc * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
  const inv = [
    (e * k - f * h) / det, (cc * h - b * k) / det, (b * f - cc * e) / det,
    (f * g - d * k) / det, (a * k - cc * g) / det, (cc * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
  return { mean, inv };
}

/**
 * How far apart two colour samples are, robustly: per channel, the gap between the medians over the sum of the robust
 * spreads (1.4826 × MAD, at least 2 levels), combined over R, G, B. Ink in the paper ring and a shadow in the
 * background ring do not move it, unlike a Gaussian fit. ~1 means the colours overlap; white paper on a mid-grey
 * or wooden desk scores 5–30.
 */
export function robustSeparation(a: number[][], b: number[][]): number | null {
  if (a.length < 12 || b.length < 12) return null;
  const stat = (xs: number[]) => {
    const s = Float64Array.from(xs).sort();
    const med = s[s.length >> 1];
    const dev = Float64Array.from(xs, (v) => Math.abs(v - med)).sort();
    return { med, spread: Math.max(2, 1.4826 * dev[dev.length >> 1]) };
  };
  let sum = 0;
  for (let c = 0; c < 3; c++) {
    const sa = stat(a.map((p) => p[c])), sb = stat(b.map((p) => p[c]));
    sum += ((sa.med - sb.med) / (sa.spread + sb.spread)) ** 2;
  }
  return Math.sqrt(sum);
}

function mahal2(g: NonNullable<Gauss>, r: number, gg: number, b: number): number {
  const v = [r - g.mean[0], gg - g.mean[1], b - g.mean[2]];
  let s = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s += v[i] * g.inv[i * 3 + j] * v[j];
  return s;
}

/**
 * Snap a coarse mask (soft values over `region`, e.g. from upsampleMask) to the paper edge in the full-res photo.
 * Pixels within `band` px of the coarse outline are re-decided by colour: a Gaussian colour model of the background
 * ring just outside and of the paper ring just inside. Inside the coarse outline a pixel turns background only when it
 * is closer to the background model and plausibly background at all (within 4σ), so ink touching the tear stays paper.
 * Falls back to the coarse mask when either ring is too small to model. `separation` (robustSeparation of the two
 * rings) says how far apart the paper and background colours are: low separation means the snap had little to go on.
 */
export function snapToPaperEdge(
  rgb: Rgb,
  soft: Float32Array,
  region: { x: number; y: number; width: number; height: number },
  band = 4,
): { mask: PlacedMask; separation: number | null } {
  const { width: w, height: h } = region;
  const m0 = new Uint8Array(w * h);
  for (let i = 0; i < m0.length; i++) m0[i] = soft[i] >= 0.5 ? 1 : 0;
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < inv.length; i++) inv[i] = 1 - m0[i];
  const dIn = chamfer(m0, w, h); // inside pixels: distance to the outside
  const dOut = chamfer(inv, w, h); // outside pixels: distance to the inside
  const px = (i: number) => {
    const x = region.x + (i % w), y = region.y + Math.floor(i / w);
    const o = (y * rgb.width + x) * 3;
    return [rgb.data[o], rgb.data[o + 1], rgb.data[o + 2]];
  };
  const paper: number[][] = [], bg: number[][] = [];
  for (let i = 0; i < m0.length; i++) {
    if (m0[i] && dIn[i] > band + 1 && dIn[i] <= band + 7) paper.push(px(i));
    else if (!m0[i] && dOut[i] > band + 1 && dOut[i] <= band + 7) bg.push(px(i));
  }
  const gp = fitGauss(paper), gb = fitGauss(bg);
  const out = new Uint8Array(m0);
  if (gp && gb) {
    for (let i = 0; i < m0.length; i++) {
      const near = m0[i] ? dIn[i] <= band : dOut[i] <= band;
      if (!near) continue;
      const [r, g, b] = px(i);
      const db = mahal2(gb, r, g, b), dp = mahal2(gp, r, g, b);
      // inside the coarse mask: background only when it really looks like background (ink stays paper);
      // outside it: paper only when it looks more like paper than background
      out[i] = m0[i] ? (db < dp && db < 16 ? 0 : 1) : dp < db ? 1 : 0;
    }
  }
  // how far apart paper and background are (null: could not model one side)
  const separation = gp && gb ? robustSeparation(paper, bg) : null;
  return { mask: cleanFragmentMask({ x: region.x, y: region.y, width: w, height: h, data: out }), separation };
}
