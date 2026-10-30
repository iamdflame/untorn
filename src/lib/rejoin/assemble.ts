// Global assembly: accept joins in order of combined confidence, keep every page geometrically consistent, then
// refine all poses of a page jointly and turn it upright.
//
// Acceptance (two clues): with a content verdict, a join needs the geometry above a floor AND content saying "same";
// without one, geometry alone must be unambiguous (no twin, a clear margin over competitors) and above threshold.
// Every accepted join must leave its seams unused, agree with the page when it closes a loop, and not make placed
// pieces overlap. Fragments that join nothing stay unplaced: never force a fit.

import { competitors, correspond, interpenetration, measureSeam, MATCH_DEFAULTS, workspace, type MatchData } from "./match";
import { poseApply, poseCompose, poseInvert, solveSPD, type Pose } from "./geom";
import { gridTrusted, lineConsensus } from "./textlines";
import type { Candidate, Clue, Fragment, Join, Page, Unplaced } from "./types";

export type AssembleOptions = {
  /** Geometry alone: smallest score and margin over competitors. */
  minGeomScore: number;
  minMargin: number;
  /** Geometry floor when content confirms the join. */
  minContentScore: number;
  /** A twin (stack tear) needs this many concordant content reads: one unconfirmed pick never places a piece. */
  minTwinVotes: number;
  /** A join on geometry alone between two pieces with trusted text lines needs at least this line evidence. */
  minLinesLogLR: number;
  /** Weight of the text-line evidence in the combined confidence (0: lines only prune, never rank). */
  linesWeight: number;
  /** A join on geometry alone needs its pieces' text lines within this angle (rad) and phase (pitch fraction). */
  linesMaxAngle: number;
  linesMaxPhase: number;
  /**
   * Stiffness of the text-line term in the joint refinement (working px² per rad²; 0: off). A seam of ~200 px pins
   * a rotation with ~3·10⁵; this weighs each piece's own lines about as much as one seam.
   */
  linesStiffness: number;
  /** Fibre-rim overlap a seam may rest at (px), as in matching (MatchOptions.rimMax). */
  rimMax: number;
  /** Geometry this unambiguous (margin over every rival, and score) outvotes a single contrary read. */
  overrideMargin: number;
  overrideScore: number;
  /** Loop closure tolerance: px at the fragment's centroid, and degrees. */
  loopPx: number;
  loopDeg: number;
  /** Deep overlap (px²) allowed between two placed fragments, plus a share of the smaller one's area. */
  overlapPx: number;
  overlapShare: number;
  /** The final check of every page allows less: no piece may lie on another beyond overlapPx + this share. */
  finalOverlapShare: number;
  /** A join is refused when this share of either seam is already used by an accepted join. */
  seamReuse: number;
  refineIters: number;
  /** Accept a twin seam without a read when its two pieces already sit side by side on one page (a closed loop). */
  twinLoops: boolean;
  /** Called with every acceptance decision (for logs and the UI). */
  trace?: (candidate: string, outcome: TraceOutcome) => void;
};

export type TraceOutcome = "accepted" | "pair-joined" | "seam-taken" | "loop-disagrees" | "overlap";

export const ASSEMBLE_DEFAULTS: AssembleOptions = {
  minGeomScore: 60,
  minMargin: 1.4,
  minContentScore: 30,
  minTwinVotes: 2,
  minLinesLogLR: -Infinity,
  linesWeight: 0,
  linesMaxAngle: (6 * Math.PI) / 180,
  linesMaxPhase: 0.3,
  linesStiffness: 3e4,
  rimMax: MATCH_DEFAULTS.rimMax,
  overrideMargin: 5,
  overrideScore: 300,
  loopPx: 6,
  loopDeg: 2,
  overlapPx: 300,
  overlapShare: 0.02,
  finalOverlapShare: 0.02,
  seamReuse: 0.35,
  refineIters: 6,
  twinLoops: true,
};

/** Fused content evidence per candidate id: log-odds sum of the verdicts that touched it, how many touched it, and how
 *  many of those were for it (a "same" or a pick of it, confidence above 0.5). */
export type ContentEvidence = Map<string, { logOdds: number; votes: number; pos?: number }>;

export type AssembleResult = { pages: Page[]; joins: Join[]; unplaced: Unplaced[] };

const logit = (p: number) => Math.log(Math.max(1e-6, p) / Math.max(1e-6, 1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

type Decision = { c: Candidate; combined: number; decidedBy: Clue; content: Join["content"] };

/**
 * May a join be accepted on its outline fit alone? Unambiguous (a clear margin over every rival) and long enough; and
 * when both pieces carry text lines, the lines must continue: the same direction (whatever the angle confidence: a
 * chance fit along two page margins can be 20° off), in phase where the phase is measurable, neither piece turned
 * upside down. Without that second clue, a join needs the reading.
 */
function geometryAlone(c: Candidate, margin: number, o: AssembleOptions): boolean {
  if (margin < o.minMargin || c.score < o.minGeomScore) return false;
  const t = c.text;
  if (t && t.weight >= 0.5) {
    if (t.angle > o.linesMaxAngle || t.flipped || (t.phaseValid && Math.abs(t.phase) > o.linesMaxPhase)) return false;
    if (t.logLR < o.minLinesLogLR) return false;
  }
  return true;
}

/** Which candidates may be accepted, how confidently, and which clue decides. */
export function decide(cands: Candidate[], evidence: ContentEvidence | null, o: AssembleOptions): Decision[] {
  const out: Decision[] = [];
  for (const c of cands) {
    const ev = evidence?.get(c.id);
    const g = Math.min(0.995, Math.max(0.005, c.confidence));
    // the text lines (direction, phase, which way is up) of printed pages: evidence on top of the outline fit
    const lines = o.linesWeight * (c.text?.logLR ?? 0);
    if (ev && ev.votes > 0 && ev.logOdds !== 0) {
      const same = ev.logOdds > 0;
      const content = { same, confidence: sigmoid(Math.abs(ev.logOdds)), votes: ev.votes };
      // one contrary read does not veto an overwhelming fit (a margin no false fit reaches): the edge decides, and the
      // join map shows that Muse disagreed. Twins and straight cuts never get here: geometry cannot decide them.
      const overwhelming =
        !c.twinGroup && c.edge !== "cut" && c.margin >= o.overrideMargin && c.score >= o.overrideScore && ev.votes === 1 && geometryAlone(c, c.margin, o);
      if (!same && overwhelming) {
        out.push({ c, combined: sigmoid(logit(g) + ev.logOdds), decidedBy: "geometry", content });
        continue;
      }
      if (!same || c.score < o.minContentScore) continue;
      // inside a twin group geometry is tied: content decides, and only when confirmed; elsewhere both clues agree
      const twin = c.twinGroup !== null;
      // concordant: that many reads picked this very join (one pick plus one read against it is not two votes)
      if (twin && (ev.pos ?? ev.votes) < o.minTwinVotes) continue;
      const geomTerm = twin ? logit(1 - Math.exp(-c.score / 60)) : logit(g);
      out.push({ c, combined: sigmoid(geomTerm + ev.logOdds + lines), decidedBy: twin ? "content" : "geometry+content", content });
      continue;
    }
    // twins and straight cuts need the content clue: geometry cannot tell them apart
    if (c.twinGroup || c.edge === "cut") continue;
    if (!geometryAlone(c, c.margin, o)) continue;
    out.push({ c, combined: sigmoid(logit(g) + lines), decidedBy: "geometry", content: null });
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
  // text-line directions of the pieces whose line grid sits on the photo's pitch: a page keeps them parallel
  const consensus = lineConsensus(frags);
  const lineDirs = new Map(frags.filter((f) => gridTrusted(f, consensus)).map((f) => [f.id, f.text!.angle] as const));
  const accepted: Decision[] = [];
  const loops = new Set<string>();
  const direct = new Set<string>();

  const tryAccept = (dcs: Decision): boolean => {
    const c = dcs.c;
    const A = byId.get(c.a)!;
    const B = byId.get(c.b)!;
    const pairKey = c.a < c.b ? `${c.a}|${c.b}` : `${c.b}|${c.a}`;
    const no = (why: TraceOutcome) => {
      o.trace?.(c.id, why);
      return false;
    };
    if (direct.has(pairKey)) return no("pair-joined");
    if (usedShare(used.get(c.a)!, c.seamA, A.n) > o.seamReuse || usedShare(used.get(c.b)!, c.seamB, B.n) > o.seamReuse) return no("seam-taken");
    const ca = comp.get(c.a)!;
    const cb = comp.get(c.b)!;
    const pa = pose.get(c.a)!;
    const pb = pose.get(c.b)!;
    if (ca === cb) {
      // loop closure: the page already places b relative to a; the join must agree
      if (!agrees(c, pa, pb, B, o)) return no("loop-disagrees");
      loops.add(c.id);
    } else {
      // merge b's page into a's: X ↦ T ∘ pose_X, T from the join, then refined on every seam the merge creates
      const moved = members.get(cb)!;
      const staying = members.get(ca)!;
      const T = alignComponents(poseCompose(pa, poseCompose(c.pose, poseInvert(pb))), moved, staying, byId, pose, radius, Math.min(o.rimMax, c.rim ?? 0));
      for (const x of moved) {
        const px = poseCompose(T, pose.get(x)!);
        for (const y of staying) if (overlapping(byId.get(x)!, px, byId.get(y)!, pose.get(y)!, radius, o)) return no("overlap");
      }
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
    acceptedIds.add(c.id);
    o.trace?.(c.id, "accepted");
    return true;
  };
  const acceptedIds = new Set<string>();
  for (const dcs of decide(cands, evidence, o)) tryAccept(dcs);

  // Relaxation: a join is only ambiguous while its rivals are possible. Once the pages grow, rivals whose seams are
  // taken, whose pair is already joined, or that contradict the layout drop out; re-check the margins against the
  // rivals that remain, until nothing changes. Twins still need the content clue.
  const rivals = competitors(cands, data);
  const feasible = (d: Candidate): boolean => {
    if (acceptedIds.has(d.id)) return true;
    const pairKey = d.a < d.b ? `${d.a}|${d.b}` : `${d.b}|${d.a}`;
    if (direct.has(pairKey)) return false;
    const A = byId.get(d.a)!;
    const B = byId.get(d.b)!;
    if (usedShare(used.get(d.a)!, d.seamA, A.n) > o.seamReuse || usedShare(used.get(d.b)!, d.seamB, B.n) > o.seamReuse) return false;
    if (comp.get(d.a) === comp.get(d.b) && !agrees(d, pose.get(d.a)!, pose.get(d.b)!, B, o)) return false;
    return true;
  };
  const byScore = [...cands].sort((x, y) => y.score - x.score);
  for (let pass = 0; pass < 6; pass++) {
    let added = 0;
    for (const c of byScore) {
      if (acceptedIds.has(c.id) || c.twinGroup || c.edge === "cut" || c.score < o.minGeomScore) continue;
      const ev = evidence?.get(c.id);
      if (ev && ev.logOdds < 0) continue;
      let best = 0;
      for (const d of rivals.get(c.id) ?? []) if (d.edge === c.edge && feasible(d)) best = Math.max(best, d.score);
      const margin = best > 0 ? c.score / best : Infinity;
      if (!geometryAlone(c, margin, o)) continue;
      const base = 1 - Math.exp(-c.score / 60);
      const combined = sigmoid(logit(base * (Number.isFinite(margin) ? Math.max(0, 1 - 1 / (margin * margin)) : 1)) + o.linesWeight * (c.text?.logLR ?? 0));
      if (tryAccept({ c, combined, decidedBy: "geometry", content: null })) added++;
    }
    if (!added) break;
  }

  // Twins whose pieces already sit side by side on one page, exactly as the seam says: the loop closes on its own
  // (the pages were built from confirmed joins), so the seam is accepted without a read of its own.
  if (o.twinLoops) {
    for (const c of byScore) {
      if (acceptedIds.has(c.id) || !c.twinGroup || c.edge === "cut" || c.score < o.minContentScore) continue;
      if (comp.get(c.a) !== comp.get(c.b)) continue;
      const ev = evidence?.get(c.id);
      if (ev && ev.logOdds < 0) continue;
      tryAccept({ c, combined: 1 - Math.exp(-c.score / 60), decidedBy: "geometry", content: null });
    }
  }

  // A page never shows two pieces lying on each other. Merges were checked against overlap as they happened, but a
  // join that slipped through (or a loop closure) can still stack pieces: check every pair on every page, with a
  // stricter bound, and take the offending pieces off, weakest first, splitting what remains along its joins.
  const overlapRejected = clearOverlaps(members, comp, accepted, direct, acceptedIds, byId, pose, radius, o);

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
      unplaced.push({ id, reason: overlapRejected.has(id) ? "rejected" : twinMembers.has(id) ? "twin-unresolved" : withCands.has(id) ? "rejected" : "no-match" });
      continue;
    }
    const pageId = `page-${pageNo++}`;
    const pageJoins = accepted.filter((d) => comp.get(d.c.a) === root);
    // Once placed, every pair whose outlines meet is a seam: use all of them to refine, not only the accepted joins.
    // Fibre rims: each accepted join keeps the overlap it was matched at; seams the layout implies may rest at up to the
    // page's median rim (0 where seams just touch, as on clean cuts and simulations)
    const rims = pageJoins.map((d) => d.c.rim ?? 0).sort((x, y) => x - y);
    const pageRim = Math.min(o.rimMax, rims.length ? rims[Math.floor(rims.length / 2)] : 0);
    let implied = impliedSeams(ids, byId, pose, direct, radius, pageRim);
    const seams = [...pageJoins.map((d) => ({ a: d.c.a, b: d.c.b, rim: Math.min(o.rimMax, d.c.rim ?? 0) })), ...implied];
    const refined = refine(ids, seams, byId, pose, o.refineIters, lineDirs, o.linesStiffness);
    implied = impliedSeams(ids, byId, pose, direct, radius, pageRim);
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
        text: c.text ?? null,
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

type Seam = { a: string; b: string; seamA: [number, number]; seamB: [number, number]; score: number; rms: number; overlap: number; rim: number };

/** Seams between placed fragments that no accepted join covers: pairs whose outlines meet where the page puts them. */
function impliedSeams(ids: string[], byId: Map<string, MatchData>, pose: Map<string, Pose>, direct: Set<string>, radius: Map<string, number>, rimMax = 0): Seam[] {
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
      const m = measureSeam(A, B, rel, { minOverlap: 40, rimMax });
      if (!m || m.score < 25 || m.rms > 2) continue;
      out.push({ a, b, seamA: m.seamA, seamB: m.seamB, score: m.score, rms: m.rms, overlap: m.overlap, rim: m.rim });
    }
  }
  return out;
}

/**
 * Refine the rigid transform T that places a moved group of fragments against a staying group: point-to-line ICP over
 * all seams between the two groups at once (one seam alone pins the rotation weakly, and the error grows with the
 * distance from it).
 */
function alignComponents(
  T0: Pose,
  moved: string[],
  staying: string[],
  byId: Map<string, MatchData>,
  pose: Map<string, Pose>,
  radius: Map<string, number>,
  rimMax = 0,
): Pose {
  let T = T0;
  for (let it = 0; it < 4; it++) {
    const H = new Float64Array(9);
    const g = new Float64Array(3);
    let n = 0;
    let cx = 0;
    let cy = 0;
    const pts: [number, number, number, number, number][] = []; // q (page), a (page), normal (page)
    for (const x of moved) {
      const X = byId.get(x)!;
      const px = poseCompose(T, pose.get(x)!);
      const [xcx, xcy] = poseApply(px, ...X.f.centroid);
      for (const y of staying) {
        const Y = byId.get(y)!;
        const py = pose.get(y)!;
        const [ycx, ycy] = poseApply(py, ...Y.f.centroid);
        if (Math.hypot(xcx - ycx, xcy - ycy) > radius.get(x)! + radius.get(y)! + 4) continue;
        const rel = poseCompose(poseInvert(py), px); // X's photo → Y's photo
        const w = workspace(X.sample.length);
        // the seams between the two groups rest at the joining seam's rim overlap
        const delta = rimMax;
        correspond(Y, X, rel, 4, w, delta);
        const c = Math.cos(py.theta);
        const s = Math.sin(py.theta);
        for (let k = 0; k < X.sample.length; k++) {
          if (w.inl[k] !== 1) continue;
          const a = w.ai[k];
          const q = poseApply(py, w.qx[k], w.qy[k]);
          const ap = poseApply(py, Y.X[a], Y.Y[a]);
          // the target is A's outline moved in by the rim overlap: the seam rests there
          const nA = Math.atan2(s * Y.NX[a] + c * Y.NY[a], c * Y.NX[a] - s * Y.NY[a]);
          pts.push([q[0], q[1], ap[0] - delta * Math.cos(nA) - q[0], ap[1] - delta * Math.sin(nA) - q[1], nA]);
          cx += q[0];
          cy += q[1];
          n++;
        }
      }
    }
    if (n < 20) return T;
    cx /= n;
    cy /= n;
    for (const [qx, qy, dx, dy, na] of pts) {
      const nx = Math.cos(na);
      const ny = Math.sin(na);
      const r = -(nx * dx + ny * dy); // n·(q − a)
      const wt = Math.abs(r) <= 1.5 ? 1 : 1.5 / Math.abs(r);
      const J = [-(qy - cy) * nx + (qx - cx) * ny, nx, ny];
      for (let p = 0; p < 3; p++) {
        g[p] += wt * J[p] * r;
        for (let q = 0; q < 3; q++) H[3 * p + q] += wt * J[p] * J[q];
      }
    }
    const d = solveSPD(H, Float64Array.from([-g[0], -g[1], -g[2]]), 3, 1e-6);
    const dth = Math.max(-0.05, Math.min(0.05, d[0]));
    const cd = Math.cos(dth);
    const sd = Math.sin(dth);
    T = poseCompose({ theta: dth, tx: cx - (cd * cx - sd * cy) + d[1], ty: cy - (sd * cx + cd * cy) + d[2] }, T);
    if (Math.abs(dth) < 1e-5 && Math.hypot(d[1], d[2]) < 0.01) break;
  }
  return T;
}

/** Does a candidate agree with where the page already puts its two fragments? */
function agrees(c: Candidate, pa: Pose, pb: Pose, B: MatchData, o: AssembleOptions): boolean {
  const predicted = poseCompose(poseInvert(pa), pb);
  const [x1, y1] = poseApply(predicted, B.f.centroid[0], B.f.centroid[1]);
  const [x2, y2] = poseApply(c.pose, B.f.centroid[0], B.f.centroid[1]);
  const dth = Math.abs(Math.atan2(Math.sin(predicted.theta - c.pose.theta), Math.cos(predicted.theta - c.pose.theta)));
  return Math.hypot(x1 - x2, y1 - y2) <= o.loopPx && dth <= (o.loopDeg * Math.PI) / 180;
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

/** Pairs of pieces on one page that lie on each other: deep overlap beyond `overlapPx` + `finalOverlapShare` of the smaller. */
export function pageOverlaps(ids: string[], byId: Map<string, MatchData>, pose: Map<string, Pose>, radius: Map<string, number>, o: AssembleOptions): [string, string][] {
  const out: [string, string][] = [];
  const strict = { ...o, overlapShare: o.finalOverlapShare };
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const X = byId.get(ids[i])!;
      const Y = byId.get(ids[j])!;
      if (overlapping(X, pose.get(ids[i])!, Y, pose.get(ids[j])!, radius, strict) || overlapping(Y, pose.get(ids[j])!, X, pose.get(ids[i])!, radius, strict)) out.push([ids[i], ids[j]]);
    }
  }
  return out;
}

/**
 * Take pieces that lie on each other off their page: the piece in the most overlapping pairs first (then the one held
 * by the weakest joins), with its joins; the rest of the page splits along its remaining joins. Returns the pieces taken.
 */
function clearOverlaps(
  members: Map<string, string[]>,
  comp: Map<string, string>,
  accepted: Decision[],
  direct: Set<string>,
  acceptedIds: Set<string>,
  byId: Map<string, MatchData>,
  pose: Map<string, Pose>,
  radius: Map<string, number>,
  o: AssembleOptions,
): Set<string> {
  const taken = new Set<string>();
  for (let guard = 0; guard < 64; guard++) {
    let changed = false;
    for (const [root, ids] of [...members]) {
      if (ids.length < 2) continue;
      const pairs = pageOverlaps(ids, byId, pose, radius, o);
      if (!pairs.length) continue;
      const count = new Map<string, number>();
      for (const [a, b] of pairs) for (const x of [a, b]) count.set(x, (count.get(x) ?? 0) + 1);
      const strength = (x: string) => accepted.filter((d) => d.c.a === x || d.c.b === x).reduce((m, d) => Math.max(m, d.combined), 0);
      const worst = [...count.keys()].sort((x, y) => count.get(y)! - count.get(x)! || strength(x) - strength(y))[0];
      taken.add(worst);
      // drop its joins; the remaining members regroup along the joins left between them
      for (let k = accepted.length - 1; k >= 0; k--) {
        const c = accepted[k].c;
        if (c.a !== worst && c.b !== worst) continue;
        accepted.splice(k, 1);
        acceptedIds.delete(c.id);
        direct.delete(c.a < c.b ? `${c.a}|${c.b}` : `${c.b}|${c.a}`);
      }
      members.delete(root);
      const rest = ids.filter((x) => x !== worst);
      comp.set(worst, worst);
      members.set(worst, [worst]);
      const seen = new Set<string>();
      for (const start of rest) {
        if (seen.has(start)) continue;
        const group: string[] = [];
        const stack = [start];
        seen.add(start);
        while (stack.length) {
          const x = stack.pop()!;
          group.push(x);
          for (const d of accepted) {
            const y = d.c.a === x ? d.c.b : d.c.b === x ? d.c.a : null;
            if (y && rest.includes(y) && !seen.has(y)) {
              seen.add(y);
              stack.push(y);
            }
          }
        }
        for (const x of group) comp.set(x, group[0]);
        members.set(group[0], group);
      }
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return taken;
}

/** Do two placed fragments overlap by more than the noise allows? */
function overlapping(X: MatchData, px: Pose, Y: MatchData, py: Pose, radius: Map<string, number>, o: AssembleOptions): boolean {
  const [ax, ay] = poseApply(px, X.f.centroid[0], X.f.centroid[1]);
  const [bx, by] = poseApply(py, Y.f.centroid[0], Y.f.centroid[1]);
  if (Math.hypot(ax - bx, ay - by) > radius.get(X.f.id)! + radius.get(Y.f.id)!) return false;
  const rel = poseCompose(poseInvert(py), px); // X's photo → Y's photo
  // only deep overlap counts: placements drift by a few px before the joint refinement, wrong ones overlap deeply
  const area = interpenetration(Y, X, rel, 6, 2);
  return area > o.overlapPx + o.overlapShare * Math.min(X.f.area, Y.f.area);
}

/**
 * Joint refinement of a page: Gauss–Newton on point-to-line seam residuals of every accepted join, all poses at
 * once (the largest fragment fixed). Returns the final RMS seam residual (px).
 */
function refine(
  ids: string[],
  joins: { a: string; b: string; rim?: number }[],
  byId: Map<string, MatchData>,
  pose: Map<string, Pose>,
  iters: number,
  lineDirs: Map<string, number> = new Map(),
  linesStiffness = 0,
): number {
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
      const delta = c.rim ?? 0;
      correspond(A, B, rel, 3, w, delta);
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
        const r = nx * (qb[0] - qa[0]) + ny * (qb[1] - qa[1]) + delta;
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
    // Text lines: every piece with a trusted grid pulls its lines parallel to the page's (their weighted axial mean).
    // Seams fitted through fibre rims and curl carry rotation errors of 1–2°; the lines of each piece do not.
    const withLines = ids.filter((id) => lineDirs.has(id));
    if (linesStiffness > 0 && withLines.length >= 2) {
      let sx = 0;
      let sy = 0;
      for (const id of withLines) {
        const a = 2 * (lineDirs.get(id)! + pose.get(id)!.theta);
        sx += Math.cos(a);
        sy += Math.sin(a);
      }
      const page = Math.atan2(sy, sx) / 2;
      // a dead zone of ±0.6°: text angles are good to about that, and seams that already agree are left alone
      const dz = (0.6 * Math.PI) / 180;
      for (const id of withLines) {
        const k = 3 * index.get(id)!;
        let e = lineDirs.get(id)! + pose.get(id)!.theta - page;
        e -= Math.PI * Math.round(e / Math.PI);
        if (Math.abs(e) <= dz) continue;
        H[k * N + k] += linesStiffness;
        g[k] += linesStiffness * (e - Math.sign(e) * dz);
      }
    }
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
    // Typed lines start at one margin and end ragged: a weak prior, used only when the ascender vote is inconclusive.
    // It never overturns a clear vote: a page missing its left-margin pieces has a torn, ragged left edge and a flush
    // (justified) right one, and the margins alone would turn it upside down (S7: the user's own page, live).
    if (!flipKnown) {
      const side = alignedSide(ids, byId, pose, rot);
      if (side !== 0) {
        if (side < 0) rot += Math.PI;
        flipKnown = true;
      }
    }
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

/**
 * Which side of the turned page the text lines are aligned on: +1 the left (upright), -1 the right (the page is upside
 * down), 0 unclear. Ink is binned into line slots; the left and right ends of the slots are compared by how tightly
 * they cluster (a margin) against how ragged they are.
 */
function alignedSide(ids: string[], byId: Map<string, MatchData>, pose: Map<string, Pose>, rot: number): -1 | 0 | 1 {
  const pitches = ids
    .map((id) => byId.get(id)!.f.text)
    .filter((t) => t && t.confidence >= 0.4 && t.pitch)
    .map((t) => t!.pitch!)
    .sort((a, b) => a - b);
  if (!pitches.length) return 0;
  const pitch = pitches[Math.floor(pitches.length / 2)];
  const rows = new Map<number, number[]>();
  for (const id of ids) {
    const f = byId.get(id)!.f;
    const img = f.input.rgba;
    if (!img) continue;
    const P = poseCompose({ theta: rot, tx: 0, ty: 0 }, pose.get(id)!);
    const c = Math.cos(P.theta);
    const s = Math.sin(P.theta);
    const paper = f.paper ? 0.299 * f.paper[0] + 0.587 * f.paper[1] + 0.114 * f.paper[2] : 210;
    const { mask, x0, y0 } = f.input;
    for (let r = 0; r < mask.height; r += 2) {
      for (let col = 0; col < mask.width; col += 2) {
        const i = r * mask.width + col;
        if (!mask.data[i] || f.depth[i] < 6) continue;
        const k = 4 * i;
        const lum = 0.299 * img.data[k] + 0.587 * img.data[k + 1] + 0.114 * img.data[k + 2];
        if (lum > paper - 50) continue;
        const x = x0 + col + 0.5;
        const y = y0 + r + 0.5;
        const px = c * x - s * y + P.tx;
        const py = s * x + c * y + P.ty;
        const b = Math.floor(py / pitch);
        const l = rows.get(b);
        if (l) l.push(px);
        else rows.set(b, [px]);
      }
    }
  }
  const lefts: number[] = [];
  const rights: number[] = [];
  for (const xs of rows.values()) {
    if (xs.length < 40) continue;
    xs.sort((a, b) => a - b);
    lefts.push(xs[Math.floor(0.01 * xs.length)]);
    rights.push(xs[Math.floor(0.99 * xs.length)]);
  }
  if (lefts.length < 6) return 0;
  const tol = 0.4 * pitch;
  const cluster = (v: number[]) => {
    let best = 0;
    for (const a of v) best = Math.max(best, v.filter((b) => Math.abs(b - a) <= tol).length);
    return best;
  };
  const cl = cluster(lefts);
  const cr = cluster(rights);
  if (cl >= 4 && cl >= 2 * cr) return 1;
  if (cr >= 4 && cr >= 2 * cl) return -1;
  return 0;
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
