// The hero's scene, built from a run (live, replayed or stored): every piece where SAM found it and where the solver
// put it, every seam the solver joined (its line on the page, both edge traces, and what Muse read across it), the
// order the pieces come home in, and the read the climax lands on. Pure: no DOM, no pixels.
//
// World coordinates are the photo's pixels. Rebuilt pages sit side by side, centred on the photo's centre, so a piece
// travels from where it lies in the photo to where the solver put it on its page.

import type { JoinOut, PageOut, PieceOut, ReadOut } from "./types";

export type Vec = [number, number];

export type ScenePiece = {
  id: string;
  /** Index in `scene.pieces`. */
  i: number;
  /** The balloon number (1-based, SAM's order). */
  k: number;
  /** Centroid in the photo. */
  c: Vec;
  /** Outline relative to `c`, interleaved x, y (simplified to about 1 px). */
  poly: number[];
  bbox: [number, number, number, number];
  /** Largest distance from `c` to the outline. */
  r: number;
  /** Outline length (px). */
  len: number;
  text: boolean;
  /** Placed on a rebuilt page by the solver. */
  placed: boolean;
  page: number;
  /** Where the solver put the centroid (world), and the turn it took to get there (rad). */
  home: Vec;
  ang: number;
};

/** A read Muse made across a seam that agrees with the join (the hero shows these). */
export type SeamRead = {
  id: string;
  kind: "pair" | "choice";
  confidence: number;
  words: string[];
  reason: string;
  /** The word shown for this read, and where the tear splits it when Muse said so ("r|espected" → ["r", "espected"]). */
  word: string | null;
  split: [string, string] | null;
};

export type SceneSeam = {
  i: number;
  a: number;
  b: number;
  page: number;
  join: JoinOut;
  /** The shared edge on the page (world), along piece a's outline, interleaved x, y. Empty when the edges barely touch. */
  line: number[];
  mid: Vec;
  /** Length of the shared edge (px). */
  len: number;
  /** Edge traces: each edge's deviation from the chord, outward from its own piece (96 samples), and their sum. */
  profA: number[] | null;
  profB: number[] | null;
  /** The agreeing read, if Muse confirmed this join by reading across it. */
  read: SeamRead | null;
};

export type SceneStep = { piece: number; via: number[]; read: number | null; more: number[] };

export type ScenePage = { id: string; origin: Vec; width: number; height: number };

export type Climax = { seam: number; word: string; split: [string, string] | null; read: SeamRead };

export type Scene = {
  photo: { width: number; height: number };
  pages: ScenePage[];
  pieces: ScenePiece[];
  seams: SceneSeam[];
  /** The order pieces come home in: a spanning tree over the seams, by the strongest real clue, climax last. */
  order: SceneStep[];
  climax: Climax | null;
  /** Seams confirmed by reading. */
  reads: number;
  /** World bounds of all the pages. */
  pagesBox: [number, number, number, number];
};

const PAGE_GAP = 0.06;
const SEAM_TOL = 4;

/* ---------------- small geometry ---------------- */

function centroid(poly: Vec[]): Vec {
  // area centroid of the polygon (falls back to the vertex mean for degenerate outlines)
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x0, y0] = poly[j];
    const [x1, y1] = poly[i];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-6) {
    const n = poly.length || 1;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

const applyPose = (pose: { theta: number; tx: number; ty: number }, [x, y]: Vec): Vec => {
  const c = Math.cos(pose.theta);
  const s = Math.sin(pose.theta);
  return [c * x - s * y + pose.tx, s * x + c * y + pose.ty];
};

function densify(poly: Vec[], step: number): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = Math.max(1, Math.floor(L / step));
    for (let j = 0; j < k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
  }
  return out;
}

/** Segments of a closed polygon bucketed in a grid, for fast "is this point within tol of the outline" tests. */
type SegGrid = { cell: number; map: Map<string, number[]>; q: Vec[] };
function segGrid(q: Vec[], cell: number): SegGrid {
  const map = new Map<string, number[]>();
  for (let i = 0; i < q.length; i++) {
    const a = q[i];
    const b = q[(i + 1) % q.length];
    const x0 = Math.floor(Math.min(a[0], b[0]) / cell);
    const x1 = Math.floor(Math.max(a[0], b[0]) / cell);
    const y0 = Math.floor(Math.min(a[1], b[1]) / cell);
    const y1 = Math.floor(Math.max(a[1], b[1]) / cell);
    for (let gx = x0; gx <= x1; gx++)
      for (let gy = y0; gy <= y1; gy++) {
        const k = `${gx},${gy}`;
        const l = map.get(k);
        if (l) l.push(i);
        else map.set(k, [i]);
      }
  }
  return { cell, map, q };
}
/** Distance from p to the polygon, or Infinity when no segment lies within one grid cell of p. */
function distNear(p: Vec, g: SegGrid): number {
  const gx = Math.floor(p[0] / g.cell);
  const gy = Math.floor(p[1] / g.cell);
  let best = Infinity;
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++) {
      const l = g.map.get(`${gx + dx},${gy + dy}`);
      if (!l) continue;
      for (const i of l) {
        const a = g.q[i];
        const b = g.q[(i + 1) % g.q.length];
        const abx = b[0] - a[0];
        const aby = b[1] - a[1];
        const l2 = abx * abx + aby * aby || 1e-9;
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2));
        const d = Math.hypot(a[0] + abx * t - p[0], a[1] + aby * t - p[1]);
        if (d < best) best = d;
      }
    }
  return best;
}

export function distToPoly(p: Vec, q: Vec[]): number {
  let best = Infinity;
  for (let i = 0; i < q.length; i++) {
    const a = q[i];
    const b = q[(i + 1) % q.length];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const l2 = abx * abx + aby * aby || 1e-9;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / l2));
    const d = Math.hypot(a[0] + abx * t - p[0], a[1] + aby * t - p[1]);
    if (d < best) best = d;
  }
  return best;
}

/** The longest circular run of true values, bridging gaps of up to `gap` samples. */
function longestRun(mask: boolean[], gap = 4): number[] {
  const n = mask.length;
  if (!n) return [];
  if (mask.every(Boolean)) return mask.map((_, i) => i);
  const m = mask.slice();
  const idx = m.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  for (let i = 0; i < idx.length; i++) {
    const a = idx[i];
    const b = idx[(i + 1) % idx.length];
    const d = (b - a + n) % n;
    if (d > 1 && d <= gap + 1) for (let j = 1; j < d; j++) m[(a + j) % n] = true;
  }
  if (m.every(Boolean)) return m.map((_, i) => i);
  const start = m.indexOf(false);
  let best: number[] = [];
  let cur: number[] = [];
  for (let j = 0; j < n; j++) {
    const i = (start + j) % n;
    if (m[i]) cur.push(i);
    else {
      if (cur.length > best.length) best = cur;
      cur = [];
    }
  }
  if (cur.length > best.length) best = cur;
  return best;
}

/** Douglas–Peucker on an open polyline. */
function simplifyOpen(pts: Vec[], eps: number): Vec[] {
  if (pts.length < 3) return pts.slice();
  const [a, b] = [pts[0], pts[pts.length - 1]];
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const n = Math.hypot(abx, aby);
  let worst = -1;
  let wi = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const d = n === 0 ? Math.hypot(p[0] - a[0], p[1] - a[1]) : Math.abs(abx * (p[1] - a[1]) - aby * (p[0] - a[0])) / n;
    if (d > worst) {
      worst = d;
      wi = i;
    }
  }
  if (worst > eps) return [...simplifyOpen(pts.slice(0, wi + 1), eps).slice(0, -1), ...simplifyOpen(pts.slice(wi), eps)];
  return [a, b];
}

function simplifyClosed(pts: Vec[], eps: number): Vec[] {
  if (pts.length < 8) return pts.slice();
  let far = 0;
  let fd = -1;
  pts.forEach((p, i) => {
    const d = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  });
  const a = simplifyOpen(pts.slice(0, far + 1), eps);
  const b = simplifyOpen([...pts.slice(far), pts[0]], eps);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

const arcLength = (pts: Vec[]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);

function pointAtLength(pts: Vec[], at: number): Vec {
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const L = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + L >= at) {
      const u = L ? (at - acc) / L : 0;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
    }
    acc += L;
  }
  return pts[pts.length - 1] ?? [0, 0];
}

/** Edge trace after e2: unroll an edge along the chord; deviation measured outward from its own piece. */
function profile(Q: Vec[], st: Vec, u: Vec, nrm: Vec, cl: number, side: number, n = 96): number[] {
  const pts = Q.map(([x, y]) => [((x - st[0]) * u[0] + (y - st[1]) * u[1]) / cl, ((x - st[0]) * nrm[0] + (y - st[1]) * nrm[1]) * -side] as Vec).sort((p, q) => p[0] - q[0]);
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const g = k / (n - 1);
    let j = 0;
    while (j < pts.length - 1 && pts[j + 1][0] < g) j++;
    const a = pts[j];
    const b = pts[Math.min(j + 1, pts.length - 1)];
    const v = g <= pts[0][0] ? pts[0][1] : g >= pts[pts.length - 1][0] ? pts[pts.length - 1][1] : b[0] === a[0] ? a[1] : a[1] + ((b[1] - a[1]) * (g - a[0])) / (b[0] - a[0]);
    out.push(v);
  }
  // 5-tap box smoothing, edges held
  return out.map((_, i) => {
    let s = 0;
    for (let d = -2; d <= 2; d++) s += out[Math.max(0, Math.min(n - 1, i + d))];
    return Math.round((s / 5) * 10) / 10;
  });
}

/* ---------------- reads: the word shown, and Muse's own split ---------------- */

const TOKEN = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;

/** Single words Muse read across a tear (entries with a space are phrases that cross between words). */
export function splitWords(words: string[]): string[] {
  const out: string[] = [];
  for (const w of words) {
    const t = w.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!t || /\s/.test(t)) continue;
    const m = t.match(TOKEN);
    if (m && m.length === 1 && m[0].length === t.length) out.push(t);
  }
  return out;
}

/** Muse's stated split of `word` in its reason ("'r' + 'espected'", "o+rn makes born"), or null. */
export function statedSplit(word: string, reason: string): [string, string] | null {
  const re = /['‘’"“”]?([\p{L}\p{N}]+)['‘’"“”]?\s*\+\s*['‘’"“”]?([\p{L}\p{N}]+)['‘’"“”]?/gu;
  const w = word.toLowerCase();
  for (const m of reason.matchAll(re)) {
    const l = m[1].toLowerCase();
    const r = m[2].toLowerCase();
    if (!r || r.length >= w.length) continue;
    // the halves spell the word, or the left half is only the letters next to the tear ("o+rn" in "born")
    if ((l + r === w || w.endsWith(l + r)) && w.endsWith(r)) {
      const at = w.length - r.length;
      if (at > 0) return [word.slice(0, at), word.slice(at)];
    }
  }
  return null;
}

export function seamRead(join: JoinOut, reads: ReadOut[]): SeamRead | null {
  const jr = join.read;
  if (!jr || jr.agrees !== true) return null;
  const src = reads.find((r) => r.id === jr.id);
  const tokens = splitWords(jr.words);
  let word: string | null = null;
  let split: [string, string] | null = null;
  // A split is drawn only when the pipeline verified it on the paper (the tear runs through ink on that text line).
  // Muse's stated splits alone are not shown as fact: on real and simulated tears it named in-word splits
  // ("h+ope") where the tear ran between words.
  const verified = (jr as { splitVerified?: boolean }).splitVerified === true;
  for (const t of [...tokens].sort((a, b) => b.length - a.length)) {
    const s = verified ? statedSplit(t, jr.reason) : null;
    if (s && (!split || t.length > (word?.length ?? 0))) {
      word = t;
      split = s;
    }
  }
  if (!word) word = [...tokens].sort((a, b) => b.length - a.length)[0] ?? null;
  return { id: jr.id, kind: src?.kind ?? (jr.id.startsWith("choice") ? "choice" : "pair"), confidence: jr.confidence, words: jr.words, reason: jr.reason, word, split };
}

/**
 * The climax: the real split word Muse read most confidently across a tear it confirmed, at confidence 0.9 or more.
 * Ties go to the longer word, then to the read that lands first. Null when no read qualifies. Certainty comes before
 * length: on the user's real tear, a longer word read at 0.90 carried a split the paper doesn't show, and the climax
 * must be one a judge can check by eye.
 */
export function chooseClimax(seams: SceneSeam[], minConfidence = 0.9): Climax | null {
  let best: { seam: SceneSeam; word: string } | null = null;
  for (const s of seams) {
    const r = s.read;
    if (!r || r.confidence < minConfidence || !s.line.length) continue;
    for (const w of splitWords(r.words)) {
      if (!best) {
        best = { seam: s, word: w };
        continue;
      }
      const L = w.length;
      const bL = best.word.length;
      const bc = best.seam.read!.confidence;
      if (r.confidence > bc || (r.confidence === bc && L > bL)) best = { seam: s, word: w };
    }
  }
  if (!best) return null;
  const read = best.seam.read!;
  // the climax word's split is drawn only when the seam read carries a verified split (see seamRead)
  return { seam: best.seam.i, word: best.word, split: read.split ? statedSplit(best.word, read.reason) : null, read };
}

/* ---------------- the scene ---------------- */

export type SceneInput = {
  photo: { width: number; height: number };
  pieces: PieceOut[];
  pages: PageOut[];
  joins: JoinOut[];
  reads: ReadOut[];
};

const cache = new WeakMap<object, { pages: object; joins: object; scene: Scene }>();

/** The scene for a run; the same run's arrays give back the same scene (the hero and the result share it). */
export function buildScene(input: SceneInput): Scene {
  const hit = cache.get(input.pieces);
  if (hit && hit.pages === input.pages && hit.joins === input.joins) return hit.scene;
  const scene = makeScene(input);
  cache.set(input.pieces, { pages: input.pages, joins: input.joins, scene });
  return scene;
}

function makeScene(input: SceneInput): Scene {
  const { photo } = input;
  // pages side by side, centred on the photo
  const gap = input.pages.length ? PAGE_GAP * input.pages[0].width : 0;
  const total = input.pages.reduce((s, p) => s + p.width, 0) + gap * Math.max(0, input.pages.length - 1);
  let x = photo.width / 2 - total / 2;
  const pages: ScenePage[] = input.pages.map((p) => {
    const pg = { id: p.id, origin: [x, photo.height / 2 - p.height / 2] as Vec, width: p.width, height: p.height };
    x += p.width + gap;
    return pg;
  });
  const pagesBox: [number, number, number, number] = pages.length
    ? [pages[0].origin[0], Math.min(...pages.map((p) => p.origin[1])), pages[pages.length - 1].origin[0] + pages[pages.length - 1].width, Math.max(...pages.map((p) => p.origin[1] + p.height))]
    : [0, 0, photo.width, photo.height];

  const where = new Map<string, { page: number; pose: PageOut["pieces"][number]["pose"] }>();
  input.pages.forEach((p, k) => p.pieces.forEach((f) => where.set(f.id, { page: k, pose: f.pose })));

  const pieces: ScenePiece[] = input.pieces.map((p, i) => {
    const poly = p.polygon as Vec[];
    const c = centroid(poly);
    const simp = simplifyClosed(poly, 0.9);
    let r = 0;
    const local: number[] = [];
    for (const [px, py] of simp) {
      local.push(px - c[0], py - c[1]);
      r = Math.max(r, Math.hypot(px - c[0], py - c[1]));
    }
    const w = where.get(p.id);
    let home: Vec = c;
    let ang = 0;
    if (w) {
      const h = applyPose(w.pose, c);
      const o = pages[w.page].origin;
      home = [h[0] + o[0], h[1] + o[1]];
      ang = w.pose.theta;
    }
    return { id: p.id, i, k: i + 1, c, poly: local, bbox: p.box, r, len: arcLength([...poly, poly[0]]), text: p.text, placed: !!w, page: w?.page ?? -1, home, ang };
  });
  const byId = new Map(pieces.map((p) => [p.id, p] as const));

  // seams: the shared edge of every join, found where the two outlines meet on the page
  const pagePoly = new Map<string, Vec[]>();
  const grids = new Map<string, SegGrid>();
  const gridOf = (p: ScenePiece) => {
    let g = grids.get(p.id);
    if (!g) {
      g = segGrid(onPage(p), 8);
      grids.set(p.id, g);
    }
    return g;
  };
  const onPage = (p: ScenePiece): Vec[] => {
    let pts = pagePoly.get(p.id);
    if (!pts) {
      const src = input.pieces[p.i].polygon as Vec[];
      const pose = where.get(p.id)!.pose;
      const o = pages[p.page].origin;
      pts = densify(src, 3).map((q) => {
        const h = applyPose(pose, q);
        return [h[0] + o[0], h[1] + o[1]] as Vec;
      });
      pagePoly.set(p.id, pts);
    }
    return pts;
  };
  const seams: SceneSeam[] = [];
  for (const j of input.joins) {
    const pa = byId.get(j.a);
    const pb = byId.get(j.b);
    if (!pa || !pb || !pa.placed || !pb.placed || pa.page !== pb.page) continue;
    const A = onPage(pa);
    const B = onPage(pb);
    const gA = gridOf(pa);
    const gB = gridOf(pb);
    const ra = longestRun(A.map((p) => distNear(p, gB) < SEAM_TOL));
    const rb = longestRun(B.map((p) => distNear(p, gA) < SEAM_TOL));
    const runA = ra.map((i) => A[i]);
    const runB = rb.map((i) => B[i]);
    const line = runA.length >= 2 ? simplifyOpen(runA, 0.8) : [];
    const len = arcLength(runA);
    const mid: Vec = runA.length ? pointAtLength(runA, len / 2) : [(pa.home[0] + pb.home[0]) / 2, (pa.home[1] + pb.home[1]) / 2];
    let profA: number[] | null = null;
    let profB: number[] | null = null;
    if (runA.length >= 4 && runB.length >= 4) {
      const st = runA[0];
      const en = runA[runA.length - 1];
      const cl = Math.hypot(en[0] - st[0], en[1] - st[1]);
      if (cl > 8) {
        const u: Vec = [(en[0] - st[0]) / cl, (en[1] - st[1]) / cl];
        const nrm: Vec = [-u[1], u[0]];
        const sideOf = (c: Vec) => Math.sign((c[0] - st[0]) * nrm[0] + (c[1] - st[1]) * nrm[1]);
        const sA = sideOf(pa.home) || 1;
        const sB = sideOf(pb.home) || -sA;
        profA = profile(runA, st, u, nrm, cl, sA);
        profB = profile(runB, st, u, nrm, cl, sB);
      }
    }
    seams.push({ i: seams.length, a: pa.i, b: pb.i, page: pa.page, join: j, line: line.flat(), mid, len, profA, profB, read: seamRead(j, input.reads) });
  }

  const climax = chooseClimax(seams);
  const order = joinOrder(pieces, seams, climax, pages.length);
  return { photo, pages, pieces, seams, order, climax, reads: seams.filter((s) => s.read).length, pagesBox };
}

/** A spanning tree over the seams, page by page, each step caused by its strongest real clue; the climax piece last. */
function joinOrder(pieces: ScenePiece[], seams: SceneSeam[], climax: Climax | null, nPages: number): SceneStep[] {
  const order: SceneStep[] = [];
  const climaxPage = climax ? seams[climax.seam].page : -1;
  const pages = [...Array(nPages).keys()].sort((a, b) => Number(a === climaxPage) - Number(b === climaxPage));
  for (const pg of pages) {
    const members = pieces.filter((p) => p.placed && p.page === pg).map((p) => p.i);
    if (!members.length) continue;
    const ss = seams.filter((s) => s.page === pg);
    if (!(climax && pg === climaxPage)) {
      order.push(...pageOrder(pieces, members, ss, -1, null));
      continue;
    }
    // the climax piece is one of its seam's two pieces: take the one that leaves the most reads their own beat
    const cs = seams[climax.seam];
    let best: SceneStep[] | null = null;
    let bestScore = -1;
    for (const last of [cs.a, cs.b]) {
      if (!connected(members.filter((x) => x !== last), ss)) continue;
      const steps = pageOrder(pieces, members, ss, last, cs);
      const sc = steps.slice(0, -1).reduce((n, st) => n + (st.read !== null ? 1 + seams[st.read].read!.confidence : 0), 0) - pieces[last].r / 1e6;
      if (sc > bestScore) {
        bestScore = sc;
        best = steps;
      }
    }
    order.push(...(best ?? pageOrder(pieces, members, ss, -1, null)));
  }
  return order;
}

function connected(set: number[], ss: SceneSeam[]): boolean {
  if (!set.length) return true;
  const seen = new Set([set[0]]);
  const st = [set[0]];
  while (st.length) {
    const g = st.pop()!;
    for (const s of ss) {
      const o = s.a === g ? s.b : s.b === g ? s.a : -1;
      if (o >= 0 && set.includes(o) && !seen.has(o)) {
        seen.add(o);
        st.push(o);
      }
    }
  }
  return seen.size === set.length;
}

function pageOrder(pieces: ScenePiece[], members: number[], ss: SceneSeam[], last: number, lastSeam: SceneSeam | null): SceneStep[] {
  const steps: SceneStep[] = [];
  const score = (s: SceneSeam) => (s.read ? 10 + s.read.confidence : s.len / 10000);
  const rest = members.filter((x) => x !== last);
  // anchor: the piece with the most confirming reads (then the largest)
  const rc = new Map<number, number>();
  for (const s of ss)
    if (s.read && s.a !== last && s.b !== last) {
      rc.set(s.a, (rc.get(s.a) ?? 0) + 1);
      rc.set(s.b, (rc.get(s.b) ?? 0) + 1);
    }
  const anchor = [...rest].sort((a, b) => (rc.get(b) ?? 0) - (rc.get(a) ?? 0) || pieces[b].r - pieces[a].r)[0];
  const placed = new Set<number>();
  const add = (g: number, forced?: SceneSeam | null) => {
    const via = ss.filter((s) => (s.a === g && placed.has(s.b)) || (s.b === g && placed.has(s.a)));
    const reads = via.filter((s) => s.read).sort((x, y) => y.read!.confidence - x.read!.confidence);
    const lead = forced && forced.read ? forced : reads[0];
    steps.push({ piece: g, via: via.map((s) => s.i), read: lead ? lead.i : null, more: reads.filter((s) => s !== lead).map((s) => s.i) });
    placed.add(g);
  };
  if (anchor !== undefined) add(anchor);
  while (rest.some((g) => !placed.has(g))) {
    let best = -1;
    let bestScore = -1;
    for (const s of ss) {
      const ina = placed.has(s.a);
      const inb = placed.has(s.b);
      if (ina === inb) continue;
      const other = ina ? s.b : s.a;
      if (other === last) continue;
      const sc = score(s);
      if (sc > bestScore) {
        bestScore = sc;
        best = other;
      }
    }
    if (best < 0) best = rest.find((g) => !placed.has(g))!; // not reachable through a seam: it still comes home
    add(best);
  }
  if (last >= 0) add(last, lastSeam);
  return steps;
}
