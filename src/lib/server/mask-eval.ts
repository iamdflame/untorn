// Score fragment masks against ground-truth piece outlines (a TypeScript port of spikes/v3/eval_masks.py).
// Per piece: IoU with the best-matching mask, and boundary error = distance from the centre of each boundary pixel of
// that mask (a set pixel with an unset 4-neighbour) to the true outline: median, 90th percentile and max.
// Used by the segmentation bench and its tests; not on the request path.

import { maskArea, type PlacedMask, type Point } from "./mask-geometry";

export type GtPiece = { page?: number; piece: number; photo_polygon: Point[] };

export type PieceScore = {
  gt: number;
  page: number;
  piece: number;
  /** Index of the best-matching mask, or null when none overlaps. */
  match: number | null;
  iou: number;
  boundary: { median: number; p90: number; max: number } | null;
};

export type EvalSummary = {
  pieces: number;
  masks: number;
  /** Pieces whose best mask has IoU >= 0.5. */
  detected: number;
  missed: number[];
  /** Masks that are no piece's best match (extra objects). */
  unmatchedMasks: number[];
  meanIoU: number;
  /** Median over pieces of each piece's median boundary error (px); the spike's headline number. */
  medianBoundaryPx: number;
  /** Median over every boundary pixel of every matched piece. */
  pooledMedianBoundaryPx: number;
  worstP90BoundaryPx: number;
  maxBoundaryPx: number;
};

/** Rasterise a polygon (even-odd) over its bounding box; pixel (x, y) is in when (x + c, y + c) is inside. */
export function rasterizePolygon(poly: Point[], c = 0.5): PlacedMask {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const x0 = Math.floor(minX) - 1, y0 = Math.floor(minY) - 1;
  const width = Math.ceil(maxX) - x0 + 2, height = Math.ceil(maxY) - y0 + 2;
  const data = new Uint8Array(width * height);
  const n = poly.length;
  const xs: number[] = [];
  for (let row = 0; row < height; row++) {
    const sy = y0 + row + c;
    xs.length = 0;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % n];
      if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // pixels whose sample x + c lies in [xs[k], xs[k+1])
      const from = Math.max(0, Math.ceil(xs[k] - c - x0));
      const to = Math.min(width - 1, Math.ceil(xs[k + 1] - c - x0) - 1);
      for (let col = from; col <= to; col++) data[row * width + col] = 1;
    }
  }
  return { x: x0, y: y0, width, height, data };
}

function overlap(a: PlacedMask, b: PlacedMask): number {
  const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height);
  let inter = 0;
  for (let y = y1; y < y2; y++) {
    const ra = (y - a.y) * a.width - a.x, rb = (y - b.y) * b.width - b.x;
    for (let x = x1; x < x2; x++) if (a.data[ra + x] && b.data[rb + x]) inter++;
  }
  return inter;
}

/** Centres of the mask's boundary pixels (set, with an unset or outside 4-neighbour), in photo pixels. */
export function boundaryCentres(m: PlacedMask): Point[] {
  const pts: Point[] = [];
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < m.width && y < m.height && m.data[y * m.width + x] === 1;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      if (!at(x, y)) continue;
      if (!at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1)) pts.push([m.x + x + 0.5, m.y + y + 0.5]);
    }
  }
  return pts;
}

/** Distance from p to the closed polygon's outline. */
export function distanceToRing(p: Point, ring: Point[]): number {
  let best = Infinity;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const wx = p[0] - a[0], wy = p[1] - a[1];
    const L = vx * vx + vy * vy;
    const t = L ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / L)) : 0;
    const dx = wx - t * vx, dy = wy - t * vy;
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

const q = (xs: number[], f: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * f;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
};
const r2 = (v: number) => Math.round(v * 100) / 100;

export function evaluateMasks(gt: GtPiece[], masks: PlacedMask[], opts: { fillOffset?: number } = {}): { summary: EvalSummary; pieces: PieceScore[] } {
  const areas = masks.map(maskArea);
  const used = new Set<number>();
  const pooled: number[] = [];
  const pieces: PieceScore[] = gt.map((g, gi) => {
    const ring = g.photo_polygon.slice(0, -1).length >= 3 && samePoint(g.photo_polygon[0], g.photo_polygon.at(-1)!) ? g.photo_polygon.slice(0, -1) : g.photo_polygon;
    const gm = rasterizePolygon(ring, opts.fillOffset ?? 0.5);
    const ga = maskArea(gm);
    let best = 0, bk: number | null = null;
    masks.forEach((m, k) => {
      if (m.x >= gm.x + gm.width || gm.x >= m.x + m.width || m.y >= gm.y + gm.height || gm.y >= m.y + m.height) return;
      const inter = overlap(gm, m);
      if (!inter) return;
      const iou = inter / (ga + areas[k] - inter);
      if (iou > best) {
        best = iou;
        bk = k;
      }
    });
    if (bk === null) return { gt: gi, page: g.page ?? 0, piece: g.piece, match: null, iou: 0, boundary: null };
    used.add(bk);
    const d = boundaryCentres(masks[bk]).map((p) => distanceToRing(p, ring));
    pooled.push(...d);
    return { gt: gi, page: g.page ?? 0, piece: g.piece, match: bk, iou: Math.round(best * 1e4) / 1e4, boundary: { median: r2(q(d, 0.5)), p90: r2(q(d, 0.9)), max: r2(Math.max(...d)) } };
  });
  const medians = pieces.map((p) => p.boundary?.median ?? 99);
  const summary: EvalSummary = {
    pieces: gt.length,
    masks: masks.length,
    detected: pieces.filter((p) => p.iou >= 0.5).length,
    missed: pieces.filter((p) => p.iou < 0.5).map((p) => p.gt),
    unmatchedMasks: masks.map((_, k) => k).filter((k) => !used.has(k)),
    meanIoU: Math.round((pieces.reduce((s, p) => s + p.iou, 0) / Math.max(1, pieces.length)) * 1e4) / 1e4,
    medianBoundaryPx: r2(q(medians, 0.5)),
    pooledMedianBoundaryPx: r2(q(pooled, 0.5)),
    worstP90BoundaryPx: Math.max(...pieces.map((p) => p.boundary?.p90 ?? 99)),
    maxBoundaryPx: Math.max(...pieces.map((p) => p.boundary?.max ?? 99)),
  };
  return { summary, pieces };
}

const samePoint = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1];
