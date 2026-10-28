// Straight-edge matching: pieces cut along straight lines (ShredBench's Voronoi cells, scissor cuts).
//
// A torn edge carries its own fingerprint; a straight cut does not: any two straight sides of the same length fit.
// What pins a straight join down is everything around it:
// - the two copies of a cut have the same length and meet end to end (corners at both ends coincide);
// - the corner angles at each end leave room for at most one more piece (A's angle + B's angle ≥ 180°): a Voronoi
//   vertex joins three cells, or two cells and the page border;
// - the text lines run the same way on both pieces once the cut lines up;
// - the ink continues across the cut: letters sliced by it complete each other at the same places along the side.
// Hypotheses are aligned end to end at matching corners (or slid along the side by the ink when an end is hidden), and
// scored by those clues. The assembly (tiling.ts) adds the global constraints: no overlaps, loops that close, a page.

import { axialDiff, wrapAngle, type Pose } from "./geom";
import { polygonOf, type PolygonOptions, type PolygonShape, type Side } from "./polygon";
import { sampleRgba } from "./raster";
import type { Candidate, Fragment, TextOrientation } from "./types";

export type StraightOptions = {
  polygon: Partial<PolygonOptions>;
  /** Shortest side worth matching (px). */
  minSide: number;
  /** Two copies of one cut: lengths within lengthTol px + lengthShare × length. */
  lengthTol: number;
  lengthShare: number;
  /** Corners that coincide: within endTol px + endShare × length. */
  endTol: number;
  endShare: number;
  /** A's corner angle + B's corner angle ≥ 180° − cornerTol. */
  cornerTol: number;
  /** Text lines must agree within this (rad) when both pieces read confidently (≥ minTextConf). */
  textTol: number;
  minTextConf: number;
  /** Ink profile: samples every `inkStep` px along a side, the darkest of `inkDepths` px inside the cut, smoothed
   *  along the side with a Gaussian of `inkBlur` px (a curled side drifts by a few px; text lines do not care). */
  inkStep: number;
  inkDepths: number[];
  inkBlur: number;
  /** The ink clue needs text lines crossing the side: |sin| of their angle to it at least this (0.35 ≈ 20°). */
  minCrossing: number;
  /** The slide along the side searched around an end alignment (px + share of length). */
  slide: number;
  slideShare: number;
  /** Price (in correlation) of sliding a full window away from the corners' own slide. */
  slidePrior: number;
  /** Fewest overlapping profile samples, and least ink on each side, for the ink clue to count. */
  minSamples: number;
  minInk: number;
  /** Best hypotheses kept per pair of sides. */
  perPair: number;
};

export const STRAIGHT_DEFAULTS: StraightOptions = {
  polygon: {},
  minSide: 40,
  lengthTol: 8,
  lengthShare: 0.02,
  endTol: 10,
  endShare: 0.015,
  cornerTol: (8 * Math.PI) / 180,
  textTol: (2 * Math.PI) / 180,
  minTextConf: 0.5,
  inkStep: 2,
  inkDepths: [2.5, 4.5, 6.5],
  inkBlur: 5,
  minCrossing: 0.35,
  slide: 6,
  slideShare: 0.01,
  slidePrior: 0.3,
  minSamples: 24,
  minInk: 0.6,
  perPair: 1,
};

/**
 * Ink along one side: samples p0 → p1 every `step` px, NaN where the paper is not there (a bulge, a nick).
 * `crossing` is false when the side runs nearly along the text lines: the ink just inside it then belongs to a
 * different line on each side of the cut, so the two profiles say nothing about each other.
 */
export type SideProfile = { step: number; ink: Float32Array; total: number; crossing: boolean };

export type PieceShape = {
  f: Fragment;
  /** The piece's text lines when trusted (confident, and spaced like the rest of the page), else null. */
  text: TextOrientation | null;
  poly: PolygonShape;
  /** Per side (straight ones only; null for curved). */
  profiles: (SideProfile | null)[];
  paperLum: number;
};

const lumOf = (p: Float64Array) => 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2];

/** Ink darkness (0 paper … 1 dark ink) at a photo point of a piece; null off its paper or within 1 px of its edge. */
export function inkAt(f: Fragment, x: number, y: number, paperLum: number, px: Float64Array): number | null {
  const { mask, x0, y0, rgba } = f.input;
  if (!rgba) return null;
  const c = Math.floor(x - x0);
  const r = Math.floor(y - y0);
  if (c < 0 || r < 0 || c >= mask.width || r >= mask.height || f.depth[r * mask.width + c] < 1) return null;
  sampleRgba(rgba, x - x0, y - y0, px);
  return Math.max(0, Math.min(1, (paperLum - lumOf(px) - 25) / 70));
}

function sideProfile(f: Fragment, text: TextOrientation | null, s: Side, paperLum: number, o: StraightOptions): SideProfile {
  const n = Math.max(1, Math.floor(s.length / o.inkStep) + 1);
  const ink = new Float32Array(n);
  const px = new Float64Array(4);
  // Step inside along the text lines, not straight across the cut: a line crossing the cut at angle φ meets a
  // parallel d px inside at d·cot φ along the side, on opposite sides of the cut in opposite directions, which would
  // put the two profiles 2·d·cot φ apart. Along the text direction both sides sample the same line. Interior on the
  // (−dy, dx) side of the travel direction (positive signed area).
  let nx = -s.dir[1];
  let ny = s.dir[0];
  const t = text ? [Math.cos(text.angle), Math.sin(text.angle)] : null;
  let crossing = true;
  if (t) {
    const c = t[0] * nx + t[1] * ny;
    if (Math.abs(c) >= o.minCrossing) {
      nx = t[0] / c;
      ny = t[1] / c;
    } else crossing = false;
  }
  let total = 0;
  for (let k = 0; k < n; k++) {
    const u = k * o.inkStep;
    const x = s.p0[0] + u * s.dir[0];
    const y = s.p0[1] + u * s.dir[1];
    let best = -1;
    for (const d of o.inkDepths) {
      const v = inkAt(f, x + d * nx, y + d * ny, paperLum, px);
      if (v !== null && v > best) best = v;
    }
    ink[k] = best < 0 ? NaN : best;
    if (best > 0) total += best;
  }
  return { step: o.inkStep, ink: blurProfile(ink, o.inkBlur / o.inkStep), total, crossing };
}

/** Gaussian blur of a profile that skips NaN samples (they stay NaN). */
function blurProfile(v: Float32Array, sigma: number): Float32Array {
  if (sigma <= 0.3) return v;
  const r = Math.ceil(2.5 * sigma);
  const w = Array.from({ length: 2 * r + 1 }, (_, k) => Math.exp(-0.5 * ((k - r) / sigma) ** 2));
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) {
    if (Number.isNaN(v[i])) {
      out[i] = NaN;
      continue;
    }
    let s = 0;
    let ws = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j < 0 || j >= v.length || Number.isNaN(v[j])) continue;
      s += w[k + r] * v[j];
      ws += w[k + r];
    }
    out[i] = s / ws;
  }
  return out;
}

/** Per-piece polygon and side profiles. `text`: the trusted text lines (default: the piece's, when confident). */
export function pieceShape(f: Fragment, options: Partial<StraightOptions> = {}, text?: TextOrientation | null): PieceShape {
  const o = { ...STRAIGHT_DEFAULTS, ...options };
  const t = text === undefined ? (f.text && f.text.confidence >= o.minTextConf ? f.text : null) : text;
  const poly = polygonOf(f.outline, o.polygon);
  const paperLum = f.paper ? 0.299 * f.paper[0] + 0.587 * f.paper[1] + 0.114 * f.paper[2] : 235;
  const profiles = poly.sides.map((s) => (s.kind === "straight" && s.length >= o.minSide ? sideProfile(f, t, s, paperLum, o) : null));
  return { f, text: t, poly, profiles, paperLum };
}

/** Shapes of all the pieces of one photo (text trusted when confident). */
export function pieceShapes(frags: Fragment[], options: Partial<StraightOptions> = {}): PieceShape[] {
  return frags.map((f) => pieceShape(f, options));
}

/** Evidence behind one straight-side hypothesis. */
export type StraightEvidence = {
  sideA: number;
  sideB: number;
  /** Corners that coincide (0–2) and the larger misfit among them (px). */
  ends: number;
  endError: number;
  /** |length A − length B| when both sides end at corners on both ends, else null. */
  lengthDiff: number | null;
  /** Shift of B along A's side (px): B's far end lands this far from A's start. */
  shift: number;
  /** Overlap of the two sides along the cut (px). */
  overlap: number;
  /** Text-line disagreement (rad) when both read confidently, else null. */
  textDiff: number | null;
  /** Normalised correlation of the ink profiles across the cut (null when one side is blank). */
  ink: number | null;
  inkSamples: number;
  /** Significance of that correlation: Fisher z over the effectively independent samples. */
  inkZ: number | null;
  /** Combined log-odds-like scores of the geometry clue and the content clue. */
  geometry: number;
  content: number;
};

export type StraightCandidate = Candidate & { straight: StraightEvidence };

/**
 * Pose mapping B's photo frame into A's so that side b (reversed) lies along side a with b.p1 at a.p0 + shift · a.dir.
 * `theta` overrides the rotation (the text lines pin it far better than a side bowed by a few px); B's side is then
 * anchored to A's line at the middle of their overlap.
 */
export function sidePose(a: Side, b: Side, shift: number, theta?: number): Pose {
  const th = theta ?? wrapAngle(Math.atan2(-a.dir[1], -a.dir[0]) - Math.atan2(b.dir[1], b.dir[0]));
  const c = Math.cos(th);
  const s = Math.sin(th);
  const la = a.length;
  const lb = b.length;
  const uMid = (Math.max(0, shift) + Math.min(la, shift + lb)) / 2;
  const vMid = shift + lb - uMid;
  const bx = b.p0[0] + vMid * b.dir[0];
  const by = b.p0[1] + vMid * b.dir[1];
  const tx = a.p0[0] + uMid * a.dir[0] - (c * bx - s * by);
  const ty = a.p0[1] + uMid * a.dir[1] - (s * bx + c * by);
  return { theta: th, tx, ty };
}

/** The rotation B → A that makes both pieces' text lines parallel, nearest to `near` (null without trusted text). */
function textRotation(A: PieceShape, B: PieceShape, near: number): number | null {
  if (!A.text || !B.text) return null;
  const base = A.text.angle - B.text.angle;
  const k = Math.round((near - base) / Math.PI);
  return wrapAngle(base + k * Math.PI);
}

/** Normalised correlation of A's profile and B's reversed profile at a shift; null when too little overlaps. */
function profileNcc(pa: SideProfile, pb: SideProfile, la: number, lb: number, shift: number, o: StraightOptions): { r: number | null; samples: number; overlap: number } {
  // A sample k of A sits at u = k·step; B's sample j sits at u = shift + lb − j·step.
  const step = pa.step;
  const u0 = Math.max(0, shift);
  const u1 = Math.min(la, shift + lb);
  const overlap = Math.max(0, u1 - u0);
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  let inkA = 0;
  let inkB = 0;
  for (let k = Math.ceil(u0 / step); k * step <= u1 && k < pa.ink.length; k++) {
    const a = pa.ink[k];
    const jf = (shift + lb - k * step) / step;
    const j = Math.round(jf);
    if (j < 0 || j >= pb.ink.length) continue;
    const b = pb.ink[j];
    if (Number.isNaN(a) || Number.isNaN(b)) continue;
    n++;
    sa += a;
    sb += b;
    saa += a * a;
    sbb += b * b;
    sab += a * b;
    inkA += a;
    inkB += b;
  }
  if (n < o.minSamples || inkA < o.minInk || inkB < o.minInk) return { r: null, samples: n, overlap };
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  if (va <= 1e-9 || vb <= 1e-9) return { r: null, samples: n, overlap };
  return { r: (sab - (sa * sb) / n) / Math.sqrt(va * vb), samples: n, overlap };
}

/**
 * Rotation of a text angle by a pose, compared with another piece's text angle (axial). Two pieces whose lines meet
 * at right angles say nothing: one of them has locked onto something perpendicular (table rules, a column of digits).
 */
function textDisagreement(A: PieceShape, B: PieceShape, theta: number, tol: number): number | null {
  if (!A.text || !B.text) return null;
  const d = axialDiff(B.text.angle + theta, A.text.angle);
  return d > tol && Math.abs(d - Math.PI / 2) <= tol ? null : d;
}

/** Reading direction of a piece (rad, in its photo frame) when its up vote is clear, else null. */
export function readingDirection(P: PieceShape, minUp: number): number | null {
  const t = P.text;
  if (!t || t.up === 0 || t.upConfidence < minUp) return null;
  return t.angle + (t.up === 1 ? 0 : Math.PI);
}

/** Every plausible straight-side join between two pieces, best first. */
export function matchSides(A: PieceShape, B: PieceShape, options: Partial<StraightOptions> = {}): StraightCandidate[] {
  const o = { ...STRAIGHT_DEFAULTS, ...options };
  const out: StraightCandidate[] = [];
  A.poly.sides.forEach((a, ia) => {
    const pa = A.profiles[ia];
    if (!pa) return;
    B.poly.sides.forEach((b, ib) => {
      const pb = B.profiles[ib];
      if (!pb) return;
      const theta = wrapAngle(Math.atan2(-a.dir[1], -a.dir[0]) - Math.atan2(b.dir[1], b.dir[0]));
      const textDiff = textDisagreement(A, B, theta, o.textTol);
      if (textDiff !== null && textDiff > o.textTol) return;
      const la = a.length;
      const lb = b.length;
      const L = Math.max(la, lb);
      const tolL = o.lengthTol + o.lengthShare * L;
      const cornerOk = (x: number | null, y: number | null) => x === null || y === null || x + y >= Math.PI - o.cornerTol;
      // shared corners: a.p0 ↔ b.p1 (slide 0) and a.p1 ↔ b.p0 (slide la − lb)
      const e0 = a.ends[0].vertex && b.ends[1].vertex && cornerOk(a.ends[0].angle, b.ends[1].angle);
      const e1 = a.ends[1].vertex && b.ends[0].vertex && cornerOk(a.ends[1].angle, b.ends[0].angle);
      const informative = pa.crossing && pb.crossing;
      type Hyp = { kind: "full" | "end0" | "end1" | "free"; shift: number };
      const hyps: Hyp[] = [];
      if (e0 && e1 && Math.abs(la - lb) <= tolL) hyps.push({ kind: "full", shift: (la - lb) / 2 });
      else {
        // one shared corner: the sides run together from it; the shorter may end inside the longer (a T, or a corner
        // of the longer side so close to straight that it reads as one side)
        if (e0) hyps.push({ kind: "end0", shift: 0 });
        if (e1) hyps.push({ kind: "end1", shift: la - lb });
      }
      // no shared corner: only the ink can place the slide
      if (!hyps.length && informative) hyps.push({ kind: "free", shift: NaN });
      const window = o.slide + o.slideShare * L;
      for (const h of hyps) {
        let best: { shift: number; r: number | null; samples: number; overlap: number } | null = null;
        let bestScore = -Infinity;
        const consider = (shift: number) => {
          const m = informative ? profileNcc(pa, pb, la, lb, shift, o) : { r: null, samples: 0, overlap: Math.max(0, Math.min(la, shift + lb) - Math.max(0, shift)) };
          // the ink may move the slide off the corners' (a blunted corner), at a price that grows with the distance
          const prior = h.kind === "free" ? 0 : o.slidePrior * ((shift - h.shift) / window) ** 2;
          const sc = (m.r ?? -2) - prior;
          if (sc > bestScore) {
            bestScore = sc;
            best = { shift, ...m };
          }
        };
        if (h.kind !== "free") {
          // the corners' own slide first: it stands when the ink cannot move it (ties keep the earlier)
          consider(h.shift);
          for (let d = -window; d <= window; d += 1) consider(h.shift + d);
        } else {
          const need = 0.6 * Math.min(la, lb);
          for (let sh = need - lb; sh <= la - need; sh += 1) consider(sh);
        }
        if (!best) continue;
        const bs: { shift: number; r: number | null; samples: number; overlap: number } = best;
        if (bs.overlap < Math.min(o.minSide, 0.5 * Math.min(la, lb))) continue;
        const ends = h.kind === "full" ? 2 : h.kind === "free" ? 0 : 1;
        const endError = h.kind === "free" ? 0 : Math.abs(bs.shift - h.shift);
        if (ends && endError > o.endTol + o.endShare * L) continue;
        const lengthDiff = h.kind === "full" ? Math.abs(la - lb) : null;
        // geometry: corners that coincide carry it; without one the slide along the cut is free and proves nothing
        // (a free slide still says the two cuts are collinear and the text agrees: a weak geometry score of its own)
        const geometry = ends
          ? (ends === 2 ? 3 : 1.5) + (textDiff !== null ? 1 : 0) + Math.min(1.5, bs.overlap / 400) - endError / (o.endTol + o.endShare * L)
          : Math.min(1, bs.overlap / 400) + (textDiff !== null ? 0.5 : 0);
        // content: how significant the ink correlation is (Fisher z over the effectively independent samples)
        const nEff = bs.overlap / (2.5 * o.inkBlur);
        const z = bs.r === null || nEff <= 4 ? null : Math.atanh(Math.max(-0.999, Math.min(0.999, bs.r))) * Math.sqrt(nEff - 3);
        const content = z === null ? 0 : Math.max(-3, Math.min(4, 1.5 * (z - 1.5)));
        const pose = sidePose(a, b, bs.shift, textDiff !== null ? (textRotation(A, B, theta) ?? undefined) : undefined);
        const nA = A.f.outline.length / 2;
        const nB = B.f.outline.length / 2;
        out.push({
          id: `${A.f.id}~${B.f.id}#s${ia}-${ib}${h.kind === "full" ? "" : `:${h.kind}`}`,
          a: A.f.id,
          b: B.f.id,
          pose,
          overlap: bs.overlap,
          rms: 0,
          areaOverlap: 0,
          conditioning: ends === 2 ? 1 : 0.5,
          shapeRms: 0,
          fineRms: 0,
          score: 30 * geometry,
          confidence: 0,
          margin: Infinity,
          segmentsA: [],
          segmentsB: [],
          seamA: [a.start, Math.min(nA, a.count)],
          seamB: [b.start, Math.min(nB, b.count)],
          appearance: bs.r === null ? null : { ink: bs.r, tone: 0, score: bs.r },
          twinGroup: null,
          edge: "cut",
          straight: { sideA: ia, sideB: ib, ends, endError, lengthDiff, shift: bs.shift, overlap: bs.overlap, textDiff, ink: bs.r, inkSamples: bs.samples, inkZ: z, geometry, content },
        });
      }
    });
  });
  out.sort((x, y) => y.straight.geometry + y.straight.content - (x.straight.geometry + x.straight.content));
  return out;
}

/** All straight-side candidates between every pair of pieces. */
export function matchStraight(shapes: PieceShape[], options: Partial<StraightOptions> = {}): StraightCandidate[] {
  const out: StraightCandidate[] = [];
  for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) out.push(...matchSides(shapes[i], shapes[j], options));
  out.sort((x, y) => y.straight.geometry + y.straight.content - (x.straight.geometry + x.straight.content));
  return out;
}
