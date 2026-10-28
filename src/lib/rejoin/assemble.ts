// Global assembly: accept joins in order of combined confidence, keep every page geometrically consistent, then
// refine all poses of a page jointly and turn it upright.
//
// Acceptance (two clues): with a content verdict, a join needs the geometry above a floor AND content saying "same";
// without one, geometry alone must be unambiguous (no twin, a clear margin over competitors) and above threshold.
// Every accepted join must leave its seams unused, agree with the page when it closes a loop, and not make placed
// pieces overlap. Fragments that join nothing stay unplaced: never force a fit.

import { correspond, interpenetration, measureSeam, workspace, type MatchData } from "./match";
import { poseApply, poseCompose, poseInvert, solveSPD, type Pose } from "./geom";
import type { Candidate, Clue, Fragment, Join, Page, Unplaced } from "./types";

export type AssembleOptions = {
  /** Geometry alone: smallest score and margin over competitors. */
  minGeomScore: number;
  minMargin: number;
  /** Geometry floor when content confirms the join. */
  minContentScore: number;
  /** Loop closure tolerance: px at the fragment's centroid, and degrees. */
  loopPx: number;
  loopDeg: number;
  /** Deep overlap (px²) allowed between two placed fragments, plus a share of the smaller one's area. */
  overlapPx: number;
  overlapShare: number;
  /** A join is refused when this share of either seam is already used by an accepted join. */
  seamReuse: number;
  refineIters: number;
};

export const ASSEMBLE_DEFAULTS: AssembleOptions = {
  minGeomScore: 60,
  minMargin: 1.4,
  minContentScore: 30,
  loopPx: 6,
  loopDeg: 2,
  overlapPx: 300,
  overlapShare: 0.02,
  seamReuse: 0.35,
  refineIters: 6,
};

/** Fused content evidence per candidate id: log-odds sum of the verdicts that touched it. */
export type ContentEvidence = Map<string, { logOdds: number; votes: number }>;

export type AssembleResult = { pages: Page[]; joins: Join[]; unplaced: Unplaced[] };

const logit = (p: number) => Math.log(Math.max(1e-6, p) / Math.max(1e-6, 1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

type Decision = { c: Candidate; combined: number; decidedBy: Clue; content: Join["content"] };

/** Which candidates may be accepted, how confidently, and which clue decides. */
export function decide(cands: Candidate[], evidence: ContentEvidence | null, o: AssembleOptions): Decision[] {
  const out: Decision[] = [];
  for (const c of cands) {
    const ev = evidence?.get(c.id);
    const g = Math.min(0.995, Math.max(0.005, c.confidence));
    if (ev && ev.votes > 0 && ev.logOdds !== 0) {
      const same = ev.logOdds > 0;
      const content = { same, confidence: sigmoid(Math.abs(ev.logOdds)), votes: ev.votes };
      if (!same || c.score < o.minContentScore) continue;
      // inside a twin group geometry is tied: content decides; elsewhere both clues agree
      const twin = c.twinGroup !== null;
      const geomTerm = twin ? logit(1 - Math.exp(-c.score / 60)) : logit(g);
      out.push({ c, combined: sigmoid(geomTerm + ev.logOdds), decidedBy: twin ? "content" : "geometry+content", content });
      continue;
    }
    // a twin needs the content clue: unresolved, or resolved in favour of another member
    if (c.twinGroup) continue;
    if (c.margin < o.minMargin || c.score < o.minGeomScore) continue;
    out.push({ c, combined: g, decidedBy: "geometry", content: null });
  }
  out.sort((x, y) => y.combined - x.combined || y.c.score - x.c.score);
  return out;
}

export function assemble(
  frags: Fragment[],
  data: MatchData[],
  cands: Candidate[],
  evidence: ContentEvidence | null,
  options: Partial<AssembleOptions> = {},
): AssembleResult {
  const o = { ...ASSEMBLE_DEFAULTS, ...options };
  const byId = new Map(data.map((d) => [d.f.id, d] as const));
  const comp = new Map<string, string>(frags.map((f) => [f.id, f.id]));
  const members = new Map<string, string[]>(frags.map((f) => [f.id, [f.id]]));
  const pose = new Map<string, Pose>(frags.map((f) => [f.id, { theta: 0, tx: 0, ty: 0 }]));
  const used = new Map<string, Uint8Array>(data.map((d) => [d.f.id, new Uint8Array(d.n)]));
  const radius = new Map<string, number>();
  for (const d of data) {
    let r = 0;
    const [cx, cy] = d.f.centroid;
    for (let i = 0; i < d.n; i++) r = Math.max(r, Math.hypot(d.X[i] - cx, d.Y[i] - cy));
    radius.set(d.f.id, r);
  }
  const accepted: Decision[] = [];
  const loops = new Set<string>();
  const direct = new Set<string>();

  for (const dcs of decide(cands, evidence, o)) {
    const c = dcs.c;
    const A = byId.get(c.a)!;
    const B = byId.get(c.b)!;
    const pairKey = c.a < c.b ? `${c.a}|${c.b}` : `${c.b}|${c.a}`;
    if (direct.has(pairKey)) continue;
    if (usedShare(used.get(c.a)!, c.seamA, A.n) > o.seamReuse || usedShare(used.get(c.b)!, c.seamB, B.n) > o.seamReuse) continue;
    const ca = comp.get(c.a)!;
    const cb = comp.get(c.b)!;
    const pa = pose.get(c.a)!;
    const pb = pose.get(c.b)!;
    if (ca === cb) {
      // loop closure: the page already places b relative to a; the join must agree
      const predicted = poseCompose(poseInvert(pa), pb);
      const [x1, y1] = poseApply(predicted, B.f.centroid[0], B.f.centroid[1]);
      const [x2, y2] = poseApply(c.pose, B.f.centroid[0], B.f.centroid[1]);
      const dth = Math.abs(Math.atan2(Math.sin(predicted.theta - c.pose.theta), Math.cos(predicted.theta - c.pose.theta)));
      if (Math.hypot(x1 - x2, y1 - y2) > o.loopPx || dth > (o.loopDeg * Math.PI) / 180) continue;
      loops.add(c.id);
    } else {
      // merge b's page into a's: X ↦ pose_a ∘ c.pose ∘ pose_b⁻¹ ∘ pose_X
      const T = poseCompose(pa, poseCompose(c.pose, poseInvert(pb)));
      const moved = members.get(cb)!;
      const staying = members.get(ca)!;
      let clash = false;
      for (const x of moved) {
        const px = poseCompose(T, pose.get(x)!);
        for (const y of staying) {
          if (overlapping(byId.get(x)!, px, byId.get(y)!, pose.get(y)!, radius, o)) {
            clash = true;
            break;
          }
        }
        if (clash) break;
      }
      if (clash) continue;
      for (const x of moved) {
        pose.set(x, poseCompose(T, pose.get(x)!));
        comp.set(x, ca);
      }
      members.set(ca, [...staying, ...moved]);
      members.delete(cb);
    }
    markUsed(used.get(c.a)!, c.seamA, A.n);
    markUsed(used.get(c.b)!, c.seamB, B.n);
    direct.add(pairKey);
    accepted.push(dcs);
  }

  // pages: components of two or more fragments
  const pages: Page[] = [];
  const joins: Join[] = [];
  const unplaced: Unplaced[] = [];
  const twinMembers = new Set(cands.filter((c) => c.twinGroup).flatMap((c) => [c.a, c.b]));
  const withCands = new Set(cands.flatMap((c) => [c.a, c.b]));
  let pageNo = 0;
  for (const [root, ids] of members) {
    if (ids.length < 2) {
      const id = ids[0];
      unplaced.push({ id, reason: twinMembers.has(id) ? "twin-unresolved" : withCands.has(id) ? "rejected" : "no-match" });
      continue;
    }
    const pageId = `page-${pageNo++}`;
    const pageJoins = accepted.filter((d) => comp.get(d.c.a) === root);
    // Once placed, every pair whose outlines meet is a seam: use all of them to refine, not only the accepted joins.
    let implied = impliedSeams(ids, byId, pose, direct, radius);
    const refined = refine(ids, [...pageJoins.map((d) => d.c), ...implied], byId, pose, o.refineIters);
    implied = impliedSeams(ids, byId, pose, direct, radius);
    const up = upright(ids, byId, pose);
    // bounding box of the placed outlines → origin at the top-left
    let minx = Infinity;
    let miny = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    for (const id of ids) {
      const d = byId.get(id)!;
      const p = pose.get(id)!;
      const c = Math.cos(p.theta);
      const s = Math.sin(p.theta);
      for (let i = 0; i < d.n; i += 2) {
        const x = c * d.X[i] - s * d.Y[i] + p.tx;
        const y = s * d.X[i] + c * d.Y[i] + p.ty;
        if (x < minx) minx = x;
        if (y < miny) miny = y;
        if (x > maxx) maxx = x;
        if (y > maxy) maxy = y;
      }
    }
    for (const id of ids) pose.set(id, poseCompose({ theta: 0, tx: -minx, ty: -miny }, pose.get(id)!));
    const completeness = coverage(ids, [...pageJoins.map((d) => d.c), ...implied], byId);
    const corners = countCorners(ids, byId, pose);
    const jc = pageJoins.length ? Math.exp(pageJoins.reduce((s, d) => s + Math.log(Math.max(1e-6, d.combined)), 0) / pageJoins.length) : 0;
    pages.push({
      id: pageId,
      fragments: ids.map((id) => ({ id, pose: { ...pose.get(id)! } })),
      width: Math.ceil(maxx - minx),
      height: Math.ceil(maxy - miny),
      confidence: jc * (0.5 + 0.5 * completeness),
      completeness,
      pageCorners: corners,
      upright: up,
      rms: refined,
    });
    for (const d of pageJoins) {
      const c = d.c;
      joins.push({
        candidate: c.id,
        a: c.a,
        b: c.b,
        // the refined relative pose b → a
        pose: poseCompose(poseInvert(pose.get(c.a)!), pose.get(c.b)!),
        geometry: { score: c.score, confidence: c.confidence, rms: c.rms, overlap: c.overlap, margin: c.margin },
        appearance: c.appearance,
        content: d.content,
        decidedBy: d.decidedBy,
        confidence: d.combined,
        loop: loops.has(c.id),
        page: pageId,
      });
    }
    for (const m of implied) {
      const conf = 1 - Math.exp(-m.score / 60);
      joins.push({
        candidate: `implied:${m.a}~${m.b}`,
        a: m.a,
        b: m.b,
        pose: poseCompose(poseInvert(pose.get(m.a)!), pose.get(m.b)!),
        geometry: { score: m.score, confidence: conf, rms: m.rms, overlap: m.overlap, margin: Infinity },
        appearance: null,
        content: null,
        decidedBy: "geometry",
        confidence: conf,
        loop: true,
        page: pageId,
      });
    }
  }
  pages.sort((a, b) => b.fragments.length - a.fragments.length);
  return { pages, joins, unplaced };
}

type Seam = { a: string; b: string; seamA: [number, number]; seamB: [number, number]; score: number; rms: number; overlap: number };

/** Seams between placed fragments that no accepted join covers: pairs whose outlines meet where the page puts them. */
function impliedSeams(ids: string[], byId: Map<string, MatchData>, pose: Map<string, Pose>, direct: Set<string>, radius: Map<string, number>): Seam[] {
  const out: Seam[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
      if (direct.has(`${a}|${b}`)) continue;
      const A = byId.get(a)!;
      const B = byId.get(b)!;
      const [ax, ay] = poseApply(pose.get(a)!, ...A.f.centroid);
      const [bx, by] = poseApply(pose.get(b)!, ...B.f.centroid);
      if (Math.hypot(ax - bx, ay - by) > radius.get(a)! + radius.get(b)! + 4) continue;
      const rel = poseCompose(poseInvert(pose.get(a)!), pose.get(b)!);
      const m = measureSeam(A, B, rel, { minOverlap: 40 });
      if (!m || m.score < 25 || m.rms > 2) continue;
      out.push({ a, b, seamA: m.seamA, seamB: m.seamB, score: m.score, rms: m.rms, overlap: m.overlap });
    }
  }
  return out;
}

function usedShare(used: Uint8Array, seam: [number, number], n: number): number {
  if (!seam[1]) return 0;
  let u = 0;
  for (let q = 0; q < seam[1]; q++) u += used[(seam[0] + q) % n];
  return u / seam[1];
}

function markUsed(used: Uint8Array, seam: [number, number], n: number) {
  for (let q = 0; q < seam[1]; q++) used[(seam[0] + q) % n] = 1;
}

/** Do two placed fragments overlap by more than the noise allows? */
function overlapping(X: MatchData, px: Pose, Y: MatchData, py: Pose, radius: Map<string, number>, o: AssembleOptions): boolean {
  const [ax, ay] = poseApply(px, X.f.centroid[0], X.f.centroid[1]);
  const [bx, by] = poseApply(py, Y.f.centroid[0], Y.f.centroid[1]);
  if (Math.hypot(ax - bx, ay - by) > radius.get(X.f.id)! + radius.get(Y.f.id)!) return false;
  const rel = poseCompose(poseInvert(py), px); // X's photo → Y's photo
  const area = interpenetration(Y, X, rel, 3, 2);
  return area > o.overlapPx + o.overlapShare * Math.min(X.f.area, Y.f.area);
}

/**
 * Joint refinement of a page: Gauss–Newton on point-to-line seam residuals of every accepted join, all poses at
 * once (the largest fragment fixed). Returns the final RMS seam residual (px).
 */
function refine(ids: string[], joins: { a: string; b: string }[], byId: Map<string, MatchData>, pose: Map<string, Pose>, iters: number): number {
  const index = new Map(ids.map((id, k) => [id, k] as const));
  const root = ids.reduce((a, b) => (byId.get(a)!.f.area >= byId.get(b)!.f.area ? a : b));
  const N = 3 * ids.length;
  let rms = 0;
  for (let it = 0; it < iters; it++) {
    const H = new Float64Array(N * N);
    const g = new Float64Array(N);
    let ss = 0;
    let cnt = 0;
    const piv = ids.map((id) => poseApply(pose.get(id)!, ...byId.get(id)!.f.centroid));
    for (const c of joins) {
      const A = byId.get(c.a)!;
      const B = byId.get(c.b)!;
      const pa = pose.get(c.a)!;
      const pb = pose.get(c.b)!;
      const rel = poseCompose(poseInvert(pa), pb);
      const w = workspace(B.sample.length);
      correspond(A, B, rel, 3, w);
      const ia = index.get(c.a)!;
      const ib = index.get(c.b)!;
      const ca = Math.cos(pa.theta);
      const sa = Math.sin(pa.theta);
      for (let k = 0; k < B.sample.length; k++) {
        if (w.inl[k] !== 1) continue;
        const a = w.ai[k];
        // everything in page coordinates
        const qa = poseApply(pa, A.X[a], A.Y[a]);
        const qb = poseApply(pa, w.qx[k], w.qy[k]);
        const nx = ca * A.NX[a] - sa * A.NY[a];
        const ny = sa * A.NX[a] + ca * A.NY[a];
        const r = nx * (qb[0] - qa[0]) + ny * (qb[1] - qa[1]);
        ss += r * r;
        cnt++;
        const wt = Math.abs(r) <= 1.5 ? 1 : 1.5 / Math.abs(r);
        // d r / d(δ_b) = [n·J(qb − piv_b), nx, ny]; d r / d(δ_a) = −[n·J(qa − piv_a), nx, ny]
        const jb = [nx * -(qb[1] - piv[ib][1]) + ny * (qb[0] - piv[ib][0]), nx, ny];
        const ja = [-(nx * -(qa[1] - piv[ia][1]) + ny * (qa[0] - piv[ia][0])), -nx, -ny];
        const cols = [3 * ib, 3 * ib + 1, 3 * ib + 2, 3 * ia, 3 * ia + 1, 3 * ia + 2];
        const J = [...jb, ...ja];
        for (let p = 0; p < 6; p++) {
          g[cols[p]] += wt * J[p] * r;
          for (let q = 0; q < 6; q++) H[cols[p] * N + cols[q]] += wt * J[p] * J[q];
        }
      }
    }
    rms = cnt ? Math.sqrt(ss / cnt) : 0;
    if (!cnt || ids.length < 2) break;
    // fix the root firmly, damp everything a little
    const r0 = 3 * index.get(root)!;
    for (let p = 0; p < 3; p++) H[(r0 + p) * N + r0 + p] += 1e9;
    for (let p = 0; p < N; p++) H[p * N + p] += 1e-3;
    const x = solveSPD(H, g.map((v) => -v), N, 1e-6);
    for (const id of ids) {
      const k = 3 * index.get(id)!;
      const [cx, cy] = piv[index.get(id)!];
      const dth = Math.max(-0.05, Math.min(0.05, x[k]));
      const cd = Math.cos(dth);
      const sd = Math.sin(dth);
      const inc: Pose = { theta: dth, tx: cx - (cd * cx - sd * cy) + x[k + 1], ty: cy - (sd * cx + cd * cy) + x[k + 2] };
      pose.set(id, poseCompose(inc, pose.get(id)!));
    }
  }
  return rms;
}

/** Turn a page upright: text lines horizontal (reading left to right when the up vote is clear), else page edges. */
function upright(ids: string[], byId: Map<string, MatchData>, pose: Map<string, Pose>): Page["upright"] {
  let sx = 0;
  let sy = 0;
  let wt = 0;
  for (const id of ids) {
    const t = byId.get(id)!.f.text;
    if (!t || t.confidence < 0.3) continue;
    const a = 2 * (t.angle + pose.get(id)!.theta);
    const w = t.confidence * Math.sqrt(t.ink);
    sx += w * Math.cos(a);
    sy += w * Math.sin(a);
    wt += w;
  }
  let rot = 0;
  let by: Page["upright"]["by"] = "none";
  let flipKnown = false;
  if (wt > 0 && Math.hypot(sx, sy) / wt > 0.5) {
    const axis = Math.atan2(sy, sx) / 2;
    let vote = 0;
    for (const id of ids) {
      const t = byId.get(id)!.f.text;
      if (!t || t.up === 0 || t.confidence < 0.3) continue;
      const reading = t.angle + (t.up === 1 ? 0 : Math.PI) + pose.get(id)!.theta;
      vote += Math.sign(Math.cos(reading - axis)) * t.upConfidence * t.confidence * Math.sqrt(t.ink);
    }
    rot = -axis + (vote < 0 ? Math.PI : 0);
    flipKnown = Math.abs(vote) > 0.25 * wt;
    by = "text";
  } else {
    // page edges: dominant direction modulo 90°, then portrait
    let ex = 0;
    let ey = 0;
    for (const id of ids) {
      const f = byId.get(id)!.f;
      for (const s of f.segments) {
        if (s.kind !== "straight" || s.length < 60 || s.angle === undefined) continue;
        const a = 4 * (s.angle + pose.get(id)!.theta);
        ex += s.length * Math.cos(a);
        ey += s.length * Math.sin(a);
      }
    }
    if (Math.hypot(ex, ey) > 0) {
      rot = -Math.atan2(ey, ex) / 4;
      by = "edges";
      const [w, h] = extent(ids, byId, pose, rot);
      if (w > h) rot += Math.PI / 2;
    }
  }
  if (rot) for (const id of ids) pose.set(id, poseCompose({ theta: rot, tx: 0, ty: 0 }, pose.get(id)!));
  return { by, flipKnown };
}

function extent(ids: string[], byId: Map<string, MatchData>, pose: Map<string, Pose>, rot: number): [number, number] {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const id of ids) {
    const d = byId.get(id)!;
    const p = poseCompose({ theta: rot, tx: 0, ty: 0 }, pose.get(id)!);
    for (let i = 0; i < d.n; i += 8) {
      const [x, y] = poseApply(p, d.X[i], d.Y[i]);
      minx = Math.min(minx, x);
      maxx = Math.max(maxx, x);
      miny = Math.min(miny, y);
      maxy = Math.max(maxy, y);
    }
  }
  return [maxx - minx, maxy - miny];
}

/** Share of the page's torn edge covered by accepted seams. */
function coverage(ids: string[], joins: { a: string; b: string; seamA: [number, number]; seamB: [number, number] }[], byId: Map<string, MatchData>): number {
  let torn = 0;
  let covered = 0;
  for (const id of ids) {
    const d = byId.get(id)!;
    const mark = new Uint8Array(d.n);
    for (const c of joins) {
      if (c.a === id) markUsed(mark, c.seamA, d.n);
      if (c.b === id) markUsed(mark, c.seamB, d.n);
    }
    for (let i = 0; i < d.n; i++) {
      if (!d.torn[i]) continue;
      torn++;
      covered += mark[i];
    }
  }
  return torn ? covered / torn : 1;
}

function countCorners(ids: string[], byId: Map<string, MatchData>, pose: Map<string, Pose>): number {
  const pts: [number, number][] = [];
  for (const id of ids) {
    for (const c of byId.get(id)!.f.pageCorners) {
      const p = poseApply(pose.get(id)!, c.x, c.y);
      if (!pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 15)) pts.push(p);
    }
  }
  return pts.length;
}
