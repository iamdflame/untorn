// Global assembly: accept joins in order of combined confidence, keep every page geometrically consistent, then
// refine all poses of a page jointly and turn it upright.
//
// Acceptance (two clues): with a content verdict, a join needs the geometry above a floor AND content saying "same";
// without one, geometry alone must be unambiguous (no twin, a clear margin over competitors) and above threshold.
// Every accepted join must leave its seams unused, agree with the page when it closes a loop, and not make placed
// pieces overlap. Fragments that join nothing stay unplaced: never force a fit.

import { competitors, correspond, interpenetration, measureSeam, MATCH_DEFAULTS, workspace, type MatchData } from "./match";
import { axialDiff, poseApply, poseCompose, poseInvert, solveSPD, type Pose } from "./geom";
import { gridTrusted, lineConsensus, linesAlong, lineWeight, textCheck, UP_CONFIDENCE } from "./textlines";
import type { Candidate, Clue, Fragment, Join, Page, Segment, TextCheck, Unplaced } from "./types";

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
  /**
   * When many of a page's pieces still turn their lines beyond `linesBend` (rad) after the refinement, refine again
   * with the lines at `linesBendStiffness` (0: never). `linesAnyGrid`: every piece with clear lines pulls, not only
   * grids on the photo's pitch (off: Bench-S large lost 8 pieces to text angles off by a few degrees).
   */
  linesBend: number;
  linesBendStiffness: number;
  /** …kept only when the seams' RMS grows by at most this share; lines within `linesBendDeadZone` of the page's are left. */
  linesBendCost: number;
  linesBendDeadZone: number;
  linesAnyGrid: boolean;
  /** Fibre-rim overlap a seam may rest at (px), as in matching (MatchOptions.rimMax). */
  rimMax: number;
  /**
   * A join a read confirms still needs the outline fit not to prefer another partner on that edge: its score at least
   * this times every rival's with another partner. (On the real photo Muse said "same" at 0.85 to a chance fit whose
   * edge three other partners fitted better.)
   */
  minContentMargin: number;
  /** A read-confirmed join needs the fused reads at least this sure (a hesitant "same" is no clue). */
  minReadConfidence: number;
  /** The final check of every page also takes off pieces whose clear text lines run off the page's (linesAstray). */
  pageLines: boolean;
  /** …when their ink shows lines along the page's direction no more regular than this (linesAlong; 0–1). */
  astrayAlong: number;
  /** Up votes this sure say which way a piece reads (the page check; matching has MatchOptions.textUpConfidence). */
  upConfidence: number;
  /**
   * A second chance against the finished pages for the pieces left out (completePages): the strongest placement
   * needs seams scoring `completeMinScore` in all (`completeOneSeam` when it meets a single piece), and every other
   * placement of that gap or that piece `completeMargin` below it. Weak up votes still say which way a piece reads
   * there (`completeUpConfidence`: right on 58 of 59 Bench-S votes from 0.5 to 0.75).
   */
  complete: boolean;
  completeMinScore: number;
  completeOneSeam: number;
  /** A seam counts toward the two a placement needs from this score up. */
  completeSeamScore: number;
  /** Pieces whose outline is straight beyond this share (cut, not torn) get no second chance. */
  completeMaxStraight: number;
  completeMargin: number;
  completeUpConfidence: number;
  /** Rotations the page's lines give stay fixed while a placement is fitted (the seams only slide it). */
  completeFixRotation: boolean;
  /** Line stiffness that holds the rotation of pieces placed by completion in the page refinement. */
  completeLinesStiffness: number;
  /** Pieces never offered a second chance: stack twins, whose gaps their twins fit as well (from the matcher). */
  twins?: Set<string>;
  traceComplete?: (p: Placement, margin: number, accepted: boolean) => void;
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
  linesBend: (1 * Math.PI) / 180,
  linesBendStiffness: 1e6,
  linesBendCost: 0.15,
  linesBendDeadZone: (0.6 * Math.PI) / 180,
  linesAnyGrid: false,
  rimMax: MATCH_DEFAULTS.rimMax,
  minContentMargin: 1,
  minReadConfidence: 0.7,
  pageLines: true,
  astrayAlong: 0.15,
  upConfidence: UP_CONFIDENCE,
  complete: true,
  completeMinScore: 100,
  completeOneSeam: Infinity,
  completeSeamScore: 60,
  completeMaxStraight: 0.4,
  completeMargin: 1.5,
  completeUpConfidence: 0.55,
  completeFixRotation: true,
  completeLinesStiffness: 1e6,
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
  if (!linesContinue(c, o)) return false;
  const t = c.text;
  if (t && t.weight >= 0.5 && t.logLR < o.minLinesLogLR) return false;
  return true;
}

/** Where both pieces carry text lines, do they continue across the join (direction, phase where measurable, up)? */
export function linesContinue(c: Candidate, o: AssembleOptions): boolean {
  const t = c.text;
  if (!t || t.weight < 0.5) return true;
  return !(t.angle > o.linesMaxAngle || t.flipped || (t.phaseValid && Math.abs(t.phase) > o.linesMaxPhase));
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
      // a read's "same" does not override the outline fit preferring another partner, nor lines that do not continue
      if (!twin && c.edge !== "cut" && ((c.marginOther ?? c.margin) < o.minContentMargin || !linesContinue(c, o))) continue;
      // and a clear one: a hesitant "same" (Muse at 0.55–0.62 on the real photo's chance fits) is no second clue
      if (!twin && content.confidence < o.minReadConfidence) continue;
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
  const lineDirs = new Map(frags.filter((f) => (o.linesAnyGrid ? lineWeight(f.text) >= 0.5 : gridTrusted(f, consensus))).map((f) => [f.id, f.text!.angle] as const));
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
  // pieces placed by the second chance against a finished page
  const completed = new Set<string>();
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
    // (dropping rivals the lines contradict, or that would stack pieces, let chance fits through on the real photo
    // and in its replays: a rival removed is protection removed from the fits it held back)
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
  const overlapRejected = clearOverlaps(members, comp, accepted, direct, acceptedIds, byId, pose, radius, consensus, o);

  /**
   * Refine a page on every seam at once. Once placed, every pair whose outlines meet is a seam: all of them count, not
   * only the accepted joins. Fibre rims: each accepted join keeps the overlap it was matched at; seams the layout
   * implies may rest at up to the page's median rim (0 where seams just touch, as on clean cuts and simulations).
   */
  function refinePage(root: string, ids: string[]): { refined: number; pageRim: number } {
    const pageJoins = accepted.filter((d) => comp.get(d.c.a) === root);
    const rims = pageJoins.map((d) => d.c.rim ?? 0).sort((x, y) => x - y);
    const pageRim = Math.min(o.rimMax, rims.length ? rims[Math.floor(rims.length / 2)] : 0);
    const implied = impliedSeams(ids, byId, pose, direct, radius, pageRim);
    const seams = [...pageJoins.map((d) => ({ a: d.c.a, b: d.c.b, rim: Math.min(o.rimMax, d.c.rim ?? 0) })), ...implied];
    // pieces given a second chance were laid by their lines: their lines keep holding their rotation
    const stiffer = new Map(ids.filter((id) => completed.has(id)).map((id) => [id, o.completeLinesStiffness] as const));
    const dirs = new Map(lineDirs);
    for (const id of stiffer.keys()) {
      const t = byId.get(id)!.f.text;
      if (t && lineWeight(t) >= 0.5) dirs.set(id, t.angle);
    }
    let refined = refine(ids, seams, byId, pose, o.refineIters, dirs, o.linesStiffness, stiffer);
    // Seams fitted through fibre rims can bend a real page: pieces whose text lines all ran straight end up turned
    // 2–3° against each other. On a page that needed the second chance (its seams were too weak for pairwise joins)
    // and where many pieces (not one piece with a poor text angle) still turn their lines more than `linesBend` off
    // the page's, the seams are less sure of the rotations than the lines: refine again with the lines stiff. (On every
    // page it cost Bench-S large a piece: there the seams are exact and small pieces' text angles a degree or two off.)
    if (o.linesBendStiffness > 0 && stiffer.size > 0 && linesBent(ids, pose, dirs, o)) {
      // …as long as the seams can afford it: on clean edges (and text angles a degree or two off, as on small pieces)
      // the seams hold the rotations better than the lines, and straightening the lines would tear them open
      const before = new Map(ids.map((id) => [id, pose.get(id)!] as const));
      const stiff = refine(ids, seams, byId, pose, o.refineIters, dirs, o.linesBendStiffness, stiffer, o.linesBendDeadZone);
      if (stiff <= refined * (1 + o.linesBendCost)) refined = stiff;
      else for (const [id, p] of before) pose.set(id, p);
    }
    return { refined, pageRim };
  }

  // A second chance for the pieces left out, against the finished pages (completePages), then the page check again
  const lone = [...members.values()].filter((ids) => ids.length === 1).map((ids) => ids[0]).filter((id) => !o.twins?.has(id));
  if (o.complete && lone.length && [...members.values()].some((ids) => ids.length >= 2)) {
    // the pages as they will be drawn, so the gaps between their pieces have their true shape
    // the seams that count as used are those of the joins still standing
    for (const [id, u] of used) {
      u.fill(0);
      for (const d of accepted) {
        if (d.c.a === id) markUsed(u, d.c.seamA, byId.get(id)!.n);
        if (d.c.b === id) markUsed(u, d.c.seamB, byId.get(id)!.n);
      }
    }
    const made = completePages({ byId, members, comp, pose, used, radius, consensus }, lone, cands, evidence, o, o.traceComplete);
    for (const p of made) {
      completed.add(p.unit);
      const s = p.seams.reduce((x, y) => (y.score > x.score ? y : x));
      const c: Candidate = {
        id: `page:${s.with}~${p.unit}`,
        a: s.with,
        b: p.unit,
        pose: s.rel,
        overlap: s.overlap,
        rms: s.rms,
        areaOverlap: s.areaOverlap,
        conditioning: s.conditioning,
        shapeRms: s.shapeRms,
        fineRms: s.fineRms,
        score: s.score,
        confidence: 1 - Math.exp(-p.support / 60),
        margin: Infinity,
        segmentsA: [],
        segmentsB: [],
        seamA: s.seamA,
        seamB: s.seamB,
        appearance: null,
        twinGroup: null,
        edge: "torn",
        text: s.text,
      };
      accepted.push({ c, combined: c.confidence, decidedBy: "geometry", content: null });
      acceptedIds.add(c.id);
      direct.add(c.a < c.b ? `${c.a}|${c.b}` : `${c.b}|${c.a}`);
      overlapRejected.delete(p.unit);
    }
    if (made.length) for (const id of clearOverlaps(members, comp, accepted, direct, acceptedIds, byId, pose, radius, consensus, o)) overlapRejected.add(id);
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
      unplaced.push({ id, reason: overlapRejected.has(id) ? "rejected" : twinMembers.has(id) ? "twin-unresolved" : withCands.has(id) ? "rejected" : "no-match" });
      continue;
    }
    const pageId = `page-${pageNo++}`;
    const pageJoins = accepted.filter((d) => comp.get(d.c.a) === root);
    const { refined, pageRim } = refinePage(root, ids);
    const implied = impliedSeams(ids, byId, pose, direct, radius, pageRim);
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
  fixRotation = false,
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
    // a rotation the text lines already fix: only the translation moves
    if (fixRotation) H[0] += 1e12;
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

/**
 * Pieces whose text lines contradict their page. The page's lines run where most of its trusted line weight agrees
 * (within `linesMaxAngle`); a trusted piece off that direction whose ink shows no lines along the page's either
 * (`linesAlong` below `astrayAlong`: its own estimate was no alias), or whose clear up vote reverses the page's reading
 * direction, is not on this page as placed, however the joins chained it there (on a real photo a piece came to sit at
 * 154° among level neighbours through a join whose line test it was just too faint for). Trusted: a grid on the
 * photo's line pitch (gridTrusted), as for the direction and phase of the pair test.
 */
export function linesAstray(
  ids: string[],
  byId: Map<string, MatchData>,
  pose: Map<string, Pose>,
  consensus: number | null,
  o: AssembleOptions,
): string[] {
  if (consensus === null) return [];
  const frag = (id: string) => byId.get(id)!.f;
  const text = (id: string) => frag(id).text!;
  const clear = ids.filter((id) => gridTrusted(frag(id), consensus));
  if (clear.length < 2) return [];
  const weight = (id: string) => lineWeight(text(id)) * Math.sqrt(text(id).ink);
  const out = new Set<string>();
  const dir = (id: string) => text(id).angle + pose.get(id)!.theta;
  // the page's lines: the direction the most line weight agrees on, then the weighted axial mean of its inliers
  let axis = 0;
  let support = -1;
  for (const k of clear) {
    const s = clear.reduce((acc, j) => acc + (axialDiff(dir(j), dir(k)) <= o.linesMaxAngle ? weight(j) : 0), 0);
    if (s > support) {
      support = s;
      axis = dir(k);
    }
  }
  let sx = 0;
  let sy = 0;
  for (const j of clear) {
    if (axialDiff(dir(j), axis) > o.linesMaxAngle) continue;
    sx += weight(j) * Math.cos(2 * dir(j));
    sy += weight(j) * Math.sin(2 * dir(j));
  }
  axis = Math.atan2(sy, sx) / 2;
  for (const id of clear) {
    if (axialDiff(dir(id), axis) <= o.linesMaxAngle) continue;
    // in its own photo frame the page's lines run at axis − θ: an estimate that locked onto columns still has them
    const along = linesAlong(frag(id), axis - pose.get(id)!.theta, consensus);
    if (along !== null && along < o.astrayAlong) out.add(id);
  }
  // reading direction: a piece that clearly knows which way is up must agree with the others that do (a net 1.5 votes)
  const ups = clear.filter((id) => !out.has(id) && text(id).up !== 0 && text(id).upConfidence >= o.upConfidence);
  const reading = (id: string) => text(id).angle + (text(id).up === -1 ? Math.PI : 0) + pose.get(id)!.theta;
  for (const id of ups) {
    let vx = 0;
    let vy = 0;
    for (const other of ups) {
      if (other === id) continue;
      vx += Math.cos(reading(other));
      vy += Math.sin(reading(other));
    }
    if (Math.hypot(vx, vy) >= 1.5 && Math.cos(reading(id) - Math.atan2(vy, vx)) < 0) out.add(id);
  }
  return [...out];
}

/** A clean straight segment: a page edge or a cut, not a stretch of tear that happens to run straight. */
const cleanStraight = (seg: Segment) => seg.kind === "straight" && seg.length >= 80 && (seg.rms ?? Infinity) <= 0.5;

/** Share of an outline range ([first, count], wrapping) on torn edges (not on any straight segment). */
function tornShare(D: MatchData, seam: [number, number]): number {
  let t = 0;
  for (let k = 0; k < seam[1]; k++) t += D.torn[(seam[0] + k) % D.n];
  return seam[1] ? t / seam[1] : 0;
}

/** A set-aside piece laid against a page: where, by which seams, and whether it may stand. */
export type Placement = {
  unit: string;
  /** Root of the page it goes on. */
  page: string;
  /** The piece's photo → that page. */
  pose: Pose;
  seams: {
    with: string;
    /** The piece's photo → the page piece's photo. */
    rel: Pose;
    score: number;
    overlap: number;
    rms: number;
    fineRms: number;
    shapeRms: number;
    conditioning: number;
    areaOverlap: number;
    seamA: [number, number];
    seamB: [number, number];
    text: TextCheck | null;
  }[];
  /** Sum of the seams' scores. */
  support: number;
  ok: boolean;
  why?: string;
  from: "candidate" | "lines";
};

/** The parts of the assembly state a second chance reads and extends. */
export type PageState = {
  byId: Map<string, MatchData>;
  members: Map<string, string[]>;
  comp: Map<string, string>;
  pose: Map<string, Pose>;
  used: Map<string, Uint8Array>;
  radius: Map<string, number>;
  consensus: number | null;
};

/**
 * A second chance once the pages exist. Pairwise matching sees one partner at a time; on a real hand-torn page many
 * true seams never become candidates (fibre rims blur the fine shape the seeds need) or lose to chance fits on margin.
 * Once a page stands, a piece left out has a gap to fill, bounded by placed pieces, with the page's lines through it.
 * Each set-aside piece (`units`; twins excluded by the caller) is tried there in every pose its candidates with page
 * pieces give, and in poses its text lines give: the rotation from the page's lines (and its reading direction), the
 * translation voted by outline points with facing normals. Each placement is refined against all the page pieces it
 * meets and judged by the page: every seam it makes (score, seams still free), no stacking, lines continuing at each
 * seam, reading the page's way, and no read against it. The strongest joins when its seams are strong enough and
 * nothing else fits that gap, nor that piece elsewhere, within `completeMargin`. Commits to `state`; returns the
 * placements made, in order.
 */
export function completePages(
  state: PageState,
  units: string[],
  cands: Candidate[],
  evidence: ContentEvidence | null,
  o: AssembleOptions,
  trace?: (p: Placement, margin: number, accepted: boolean) => void,
): Placement[] {
  const { byId, members, comp, pose, used, radius, consensus } = state;
  const made: Placement[] = [];
  // a piece bounded mostly by straight edges (scissor or shredder cuts) fits any gap of its shape along them: its place
  // is a content question, as for straight-cut joins
  const cut = (u: string) => {
    const f = byId.get(u)!.f;
    const straight = f.segments.filter((s) => s.kind === "straight").reduce((a, s) => a + s.length, 0);
    return straight > o.completeMaxStraight * (f.outline.length / 2);
  };
  const left = new Set(units.filter((u) => members.get(comp.get(u)!)?.length === 1 && !cut(u)));
  for (const u of left) pose.set(u, { theta: 0, tx: 0, ty: 0 });
  // what the reads ruled out: a "not the same" on a pair at a pose
  const refused = cands.filter((c) => (evidence?.get(c.id)?.logOdds ?? 0) < 0);
  const refusedAt = (v: string, u: string, rel: Pose) =>
    refused.some((c) => {
      const r = c.a === v && c.b === u ? c.pose : c.a === u && c.b === v ? poseInvert(c.pose) : null;
      if (!r) return false;
      const [x1, y1] = poseApply(r, ...byId.get(u)!.f.centroid);
      const [x2, y2] = poseApply(rel, ...byId.get(u)!.f.centroid);
      return Math.hypot(x1 - x2, y1 - y2) < 8 && Math.abs(Math.atan2(Math.sin(r.theta - rel.theta), Math.cos(r.theta - rel.theta))) < (2 * Math.PI) / 180;
    });
  for (let round = 0; round < 16 && left.size; round++) {
    const all: Placement[] = [];
    for (const [root, ids] of members) {
      if (ids.length < 2) continue;
      const ctx = pageContext(ids, byId, pose, o);
      for (const u of left) all.push(...placementsOn(u, root, ids, ctx));
    }
    const places = gather(all.filter((p) => p.ok));
    let committed: Placement | null = null;
    for (const best of places) {
      if (best.support < o.completeMinScore) break;
      // a gap is closed on two sides at least, by seams that each hold on their own
      if (best.seams.filter((s) => s.score >= o.completeSeamScore).length < 2 && best.support < o.completeOneSeam) continue;
      let rival = 0;
      for (const p of places) {
        if (p === best || p.support <= rival) continue;
        const rivals = p.unit === best.unit || (p.page === best.page && overlapping(byId.get(p.unit)!, p.pose, byId.get(best.unit)!, best.pose, radius, o));
        if (rivals) rival = p.support;
      }
      const margin = rival > 0 ? best.support / rival : Infinity;
      const accept = margin >= o.completeMargin;
      trace?.(best, margin, accept);
      if (accept) {
        committed = best;
        break;
      }
    }
    if (!committed) break;
    const u = committed.unit;
    const ids = members.get(committed.page)!;
    members.delete(comp.get(u)!);
    pose.set(u, committed.pose);
    comp.set(u, committed.page);
    members.set(committed.page, [...ids, u]);
    for (const s of committed.seams) {
      markUsed(used.get(s.with)!, s.seamA, byId.get(s.with)!.n);
      markUsed(used.get(u)!, s.seamB, byId.get(u)!.n);
    }
    left.delete(u);
    made.push(committed);
  }
  return made;

  /**
   * One place per piece within the page's own error (20 px at its centre, 3°): a gap between pieces placed a few px
   * off fits the piece against each of them at slightly different poses, and those seams add up. Strongest first.
   */
  function gather(ok: Placement[]): Placement[] {
    const groups: Placement[][] = [];
    for (const p of [...ok].sort((x, y) => y.support - x.support)) {
      const g = groups.find((m) => near(m[0], p, 20, 3));
      if (g) g.push(p);
      else groups.push([p]);
    }
    return groups
      .map((g) => {
        const byPiece = new Map<string, Placement["seams"][number]>();
        for (const p of g) for (const s of p.seams) if (s.score > (byPiece.get(s.with)?.score ?? 0)) byPiece.set(s.with, s);
        const seams = [...byPiece.values()];
        return { ...g[0], seams, support: seams.reduce((s, x) => s + x.score, 0) };
      })
      .sort((x, y) => y.support - x.support);
  }

  function near(p: Placement, q: Placement, px: number, deg: number): boolean {
    if (p.unit !== q.unit || p.page !== q.page) return false;
    const [x1, y1] = poseApply(p.pose, ...byId.get(p.unit)!.f.centroid);
    const [x2, y2] = poseApply(q.pose, ...byId.get(q.unit)!.f.centroid);
    const dth = Math.abs(Math.atan2(Math.sin(p.pose.theta - q.pose.theta), Math.cos(p.pose.theta - q.pose.theta)));
    return Math.hypot(x1 - x2, y1 - y2) < px && dth < (deg * Math.PI) / 180;
  }

  function samePlace(p: Placement, q: Placement): boolean {
    const [x1, y1] = poseApply(p.pose, ...byId.get(p.unit)!.f.centroid);
    const [x2, y2] = poseApply(q.pose, ...byId.get(q.unit)!.f.centroid);
    const dth = Math.abs(Math.atan2(Math.sin(p.pose.theta - q.pose.theta), Math.cos(p.pose.theta - q.pose.theta)));
    return p.page === q.page && Math.hypot(x1 - x2, y1 - y2) < 8 && dth < (2 * Math.PI) / 180;
  }

  function placementsOn(u: string, root: string, ids: string[], ctx: PageContext): Placement[] {
    const U = byId.get(u)!;
    const hyps: { pose: Pose; from: Placement["from"] }[] = [];
    const byCandidate: { theta: number; score: number }[] = [];
    for (const c of cands) {
      const v = c.a === u ? c.b : c.b === u ? c.a : null;
      if (!v || !ids.includes(v) || c.edge === "cut") continue;
      if ((evidence?.get(c.id)?.logOdds ?? 0) < 0) continue;
      const h = poseCompose(pose.get(v)!, c.b === u ? c.pose : poseInvert(c.pose));
      hyps.push({ pose: h, from: "candidate" });
      byCandidate.push({ theta: h.theta, score: c.score });
    }
    const rotations: number[] = [];
    // the page's lines fix the rotation, its reading direction the half turn
    const t = U.f.text;
    if (t && lineWeight(t) >= 0.5 && ctx.axis !== null) {
      for (const flip of [0, Math.PI]) {
        const theta = ctx.axis - t.angle + flip;
        if (ctx.reading !== null && t.up !== 0 && t.upConfidence >= o.completeUpConfidence) {
          if (Math.cos(t.angle + (t.up === -1 ? Math.PI : 0) + theta - ctx.reading) < 0) continue;
        }
        rotations.push(theta);
      }
    }
    // the lines' rotations first, then the strongest candidates': four turns searched at most
    rotations.push(...byCandidate.sort((a, b) => b.score - a.score).map((r) => r.theta));
    const seen: number[] = [];
    for (const theta of rotations) {
      if (seen.length >= 4) break;
      if (seen.some((s) => Math.abs(Math.atan2(Math.sin(s - theta), Math.cos(s - theta))) < (1.5 * Math.PI) / 180)) continue;
      seen.push(theta);
      for (const [tx, ty] of houghTranslations(U, theta, ctx)) hyps.push({ pose: { theta, tx, ty }, from: "lines" });
    }
    const out: Placement[] = [];
    for (const h of hyps) {
      // a rotation from the page's lines stays: the page's seams are a few px off, its lines are not
      const T = alignComponents(h.pose, [u], ids, byId, pose, radius, 0, o.completeFixRotation && h.from === "lines");
      if (out.some((p) => samePlace(p, { unit: u, page: root, pose: T } as Placement))) continue;
      out.push(judge(u, root, ids, T, h.from, ctx));
    }
    return out;
  }

  function judge(u: string, root: string, ids: string[], T: Pose, from: Placement["from"], ctx: PageContext): Placement {
    const U = byId.get(u)!;
    const no = (why: string): Placement => ({ unit: u, page: root, pose: T, seams: [], support: 0, ok: false, why, from });
    const [ux, uy] = poseApply(T, ...U.f.centroid);
    const seams: Placement["seams"] = [];
    for (const v of ids) {
      const V = byId.get(v)!;
      const pv = pose.get(v)!;
      const [vx, vy] = poseApply(pv, ...V.f.centroid);
      if (Math.hypot(ux - vx, uy - vy) > radius.get(u)! + radius.get(v)! + 4) continue;
      if (overlapping(U, T, V, pv, radius, o)) return no(`overlaps ${v}`);
      const rel = poseCompose(poseInvert(pv), T);
      const m = measureSeam(V, U, rel, { minOverlap: 40 });
      if (!m || m.score < 25 || m.rms > 2) continue;
      // straight edges fit each other anywhere along them: a seam says where a piece goes only where at least one side
      // is torn (a tear that runs straight for a while still meets a ragged partner)
      if (tornShare(V, m.seamA) < 0.5 && tornShare(U, m.seamB) < 0.5) continue;
      if (usedShare(used.get(v)!, m.seamA, V.n) > o.seamReuse || usedShare(used.get(u)!, m.seamB, U.n) > o.seamReuse) return no(`seam of ${v} taken`);
      const mid = (m.seamA[0] + Math.floor(m.seamA[1] / 2)) % V.n;
      const text = textCheck(V.f, U.f, rel, [V.X[mid], V.Y[mid]], consensus, o.upConfidence);
      if (text && text.weight >= 0.5 && (text.angle > o.linesMaxAngle || text.flipped || (text.phaseValid && Math.abs(text.phase) > o.linesMaxPhase))) return no(`lines off ${v}`);
      if (refusedAt(v, u, rel)) return no(`read against ${v}`);
      seams.push({ with: v, rel, score: m.score, overlap: m.overlap, rms: m.rms, fineRms: m.fineRms, shapeRms: m.shapeRms, conditioning: m.conditioning, areaOverlap: m.areaOverlap, seamA: m.seamA, seamB: m.seamB, text });
    }
    if (!seams.length) return no("no seam");
    // inside the paper: beyond no page edge of the page's pieces, and none of them beyond its own
    for (const v of ids) {
      if (beyondEdge(U, T, byId.get(v)!, pose.get(v)!)) return no(`beyond the page edge of ${v}`);
      if (beyondEdge(byId.get(v)!, pose.get(v)!, U, T)) return no(`its page edge has ${v} beyond it`);
    }
    // on the page's lines, and reading its way
    const t = U.f.text;
    if (t && consensus !== null && ctx.axis !== null && gridTrusted(U.f, consensus) && axialDiff(t.angle + T.theta, ctx.axis) > o.linesMaxAngle) {
      const along = linesAlong(U.f, ctx.axis - T.theta, consensus);
      if (along !== null && along < o.astrayAlong) return no("lines astray");
    }
    if (t && t.up !== 0 && t.upConfidence >= o.completeUpConfidence && ctx.reading !== null) {
      if (Math.cos(t.angle + (t.up === -1 ? Math.PI : 0) + T.theta - ctx.reading) < 0) return no("reads against the page");
    }
    return { unit: u, page: root, pose: T, seams, support: seams.reduce((s, x) => s + x.score, 0), ok: true, from };
  }
}

type PageContext = {
  /** Direction of the page's text lines, and its reading direction (rad, page frame), when the page knows them. */
  axis: number | null;
  reading: number | null;
  /** Free torn outline samples of the page (touching no other page piece): page coordinates and normal angle. */
  qx: Float64Array;
  qy: Float64Array;
  qa: Float64Array;
  qc: Float64Array;
  qs: Float64Array;
  /** Sample indices by normal angle, 36 bins. */
  bins: number[][];
  /** Bounds of the free samples. */
  minx: number;
  miny: number;
  maxx: number;
  maxy: number;
};

function pageContext(ids: string[], byId: Map<string, MatchData>, pose: Map<string, Pose>, o: AssembleOptions): PageContext {
  // lines: the weighted axial mean of the page's clear line directions; reading: the clear up votes' sum
  let sx = 0;
  let sy = 0;
  let rx = 0;
  let ry = 0;
  for (const id of ids) {
    const t = byId.get(id)!.f.text;
    const w = lineWeight(t);
    if (!t || w < 0.5) continue;
    const dir = t.angle + pose.get(id)!.theta;
    sx += w * Math.sqrt(t.ink) * Math.cos(2 * dir);
    sy += w * Math.sqrt(t.ink) * Math.sin(2 * dir);
    if (t.up !== 0 && t.upConfidence >= o.upConfidence) {
      rx += Math.cos(dir + (t.up === -1 ? Math.PI : 0));
      ry += Math.sin(dir + (t.up === -1 ? Math.PI : 0));
    }
  }
  const axis = sx || sy ? Math.atan2(sy, sx) / 2 : null;
  const reading = Math.hypot(rx, ry) >= 1.5 ? Math.atan2(ry, rx) : null;
  // every outline point of the page in a 4 px hash, to tell free samples from seams between page pieces
  const cell = 4;
  const owner = new Map<number, number[]>();
  const pts: [number, number, number][] = [];
  ids.forEach((id, k) => {
    const D = byId.get(id)!;
    const p = pose.get(id)!;
    for (let i = 0; i < D.n; i += 2) {
      const [x, y] = poseApply(p, D.X[i], D.Y[i]);
      pts.push([x, y, k]);
      const kk = Math.floor(x / cell) * 1000003 + Math.floor(y / cell);
      const l = owner.get(kk);
      if (l) l.push(pts.length - 1);
      else owner.set(kk, [pts.length - 1]);
    }
  });
  const touches = (x: number, y: number, k: number) => {
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const j of owner.get((cx + dx) * 1000003 + cy + dy) ?? []) {
          const [px, py, pk] = pts[j];
          if (pk !== k && (px - x) ** 2 + (py - y) ** 2 <= 16) return true;
        }
      }
    }
    return false;
  };
  const qx: number[] = [];
  const qy: number[] = [];
  const qa: number[] = [];
  const bins: number[][] = Array.from({ length: 36 }, () => []);
  ids.forEach((id, k) => {
    const D = byId.get(id)!;
    const p = pose.get(id)!;
    const c = Math.cos(p.theta);
    const s = Math.sin(p.theta);
    for (let j = 0; j < D.sample.length; j++) {
      const i = D.sample[j];
      const [x, y] = poseApply(p, D.X[i], D.Y[i]);
      if (touches(x, y, k)) continue;
      const a = Math.atan2(s * D.NX[i] + c * D.NY[i], c * D.NX[i] - s * D.NY[i]);
      bins[angleBin(a)].push(qx.length);
      qx.push(x);
      qy.push(y);
      qa.push(a);
    }
  });
  return {
    axis,
    reading,
    qx: Float64Array.from(qx),
    qy: Float64Array.from(qy),
    qa: Float64Array.from(qa),
    qc: Float64Array.from(qa, Math.cos),
    qs: Float64Array.from(qa, Math.sin),
    bins,
    minx: qx.length ? Math.min(...qx) : 0,
    miny: qy.length ? Math.min(...qy) : 0,
    maxx: qx.length ? Math.max(...qx) : 0,
    maxy: qy.length ? Math.max(...qy) : 0,
  };
}

const angleBin = (a: number) => ((Math.floor(((a + Math.PI) / (2 * Math.PI)) * 36) % 36) + 36) % 36;

/** Translations at which the piece, turned by `theta`, meets the page's free edges along the most facing points. */
function houghTranslations(U: MatchData, theta: number, ctx: PageContext, peaks = 6): [number, number][] {
  const bin = 4;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  // the piece's outline every 4 px, turned
  const m = Math.ceil(U.sample.length / 2);
  const ux = new Float64Array(m);
  const uy = new Float64Array(m);
  const ua = new Float64Array(m);
  let umin = Infinity;
  let umax = -Infinity;
  let vmin = Infinity;
  let vmax = -Infinity;
  for (let j = 0, k = 0; j < U.sample.length; j += 2, k++) {
    const i = U.sample[j];
    ux[k] = c * U.X[i] - s * U.Y[i];
    uy[k] = s * U.X[i] + c * U.Y[i];
    ua[k] = Math.atan2(s * U.NX[i] + c * U.NY[i], c * U.NX[i] - s * U.NY[i]) + Math.PI;
    umin = Math.min(umin, ux[k]);
    umax = Math.max(umax, ux[k]);
    vmin = Math.min(vmin, uy[k]);
    vmax = Math.max(vmax, uy[k]);
  }
  // translations live in [page min − piece max, page max − piece min]: one dense grid of 4 px bins
  const x0 = ctx.minx - umax - bin;
  const y0 = ctx.miny - vmax - bin;
  const nx = Math.ceil((ctx.maxx - umin - x0) / bin) + 2;
  const ny = Math.ceil((ctx.maxy - vmin - y0) / bin) + 2;
  if (!(nx > 0 && ny > 0) || nx * ny > 4e6) return [];
  const votes = new Uint16Array(nx * ny);
  const facing = Math.cos((25 * Math.PI) / 180);
  for (let k = 0; k < m; k++) {
    const opp = ua[k];
    const b0 = angleBin(opp);
    const co = Math.cos(opp);
    const so = Math.sin(opp);
    for (let db = -3; db <= 3; db++) {
      for (const q of ctx.bins[(b0 + db + 36) % 36]) {
        if (ctx.qc[q] * co + ctx.qs[q] * so < facing) continue;
        const bx = Math.round((ctx.qx[q] - ux[k] - x0) / bin);
        const by = Math.round((ctx.qy[q] - uy[k] - y0) / bin);
        const cell = by * nx + bx;
        if (votes[cell] < 65535) votes[cell]++;
      }
    }
  }
  // 3 × 3 sums at local maxima, the strongest few apart from each other
  const scored: [number, number, number][] = [];
  for (let by = 1; by < ny - 1; by++) {
    for (let bx = 1; bx < nx - 1; bx++) {
      const v = votes[by * nx + bx];
      if (v < 3) continue;
      let sum = 0;
      let peak = true;
      for (let dy = -1; dy <= 1 && peak; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const w = votes[(by + dy) * nx + bx + dx];
          if (w > v) {
            peak = false;
            break;
          }
          sum += w;
        }
      }
      if (peak) scored.push([sum, x0 + bx * bin, y0 + by * bin]);
    }
  }
  scored.sort((a, b) => b[0] - a[0]);
  const out: [number, number][] = [];
  for (const [, x, y] of scored) {
    if (out.some(([ox, oy]) => Math.hypot(ox - x, oy - y) < 16)) continue;
    out.push([x, y]);
    if (out.length >= peaks) break;
  }
  return out;
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
  consensus: number | null,
  o: AssembleOptions,
): Set<string> {
  const taken = new Set<string>();
  for (let guard = 0; guard < 64; guard++) {
    let changed = false;
    for (const [root, ids] of [...members]) {
      if (ids.length < 2) continue;
      const pairs = pageOverlaps(ids, byId, pose, radius, o);
      const astray = o.pageLines ? linesAstray(ids, byId, pose, consensus, o) : [];
      if (!pairs.length && !astray.length) continue;
      const count = new Map<string, number>();
      for (const [a, b] of pairs) for (const x of [a, b]) count.set(x, (count.get(x) ?? 0) + 1);
      // a piece whose lines run off the page's counts as more than one overlap: it cannot be on this page as it is
      for (const x of astray) count.set(x, (count.get(x) ?? 0) + 2);
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

/**
 * Does piece X (placed by px) lie beyond a page edge of piece Y (placed by py)? A clean straight segment of Y is the
 * paper's edge: nothing of the page lies outside it, along its stretch. Counts X's interior samples more than `tol` px
 * outside it there; true beyond `limit` of them.
 */
function beyondEdge(X: MatchData, px: Pose, Y: MatchData, py: Pose, tol = 20, limit = 12): boolean {
  const c = Math.cos(py.theta);
  const s = Math.sin(py.theta);
  for (const seg of Y.f.segments) {
    // the paper's own edge: long and cut straight (a straight stretch of tear wanders more: 0.6–0.9 px on the real
    // photo, against 0.3–0.5 for its page edges)
    if (!cleanStraight(seg)) continue;
    // the edge in page coordinates: a point, its direction, its outward normal (the outline's normals there)
    let mx = 0;
    let my = 0;
    let nx = 0;
    let ny = 0;
    for (let k = 0; k < seg.count; k++) {
      const i = (seg.start + k) % Y.n;
      mx += Y.X[i];
      my += Y.Y[i];
      nx += Y.NX[i];
      ny += Y.NY[i];
    }
    mx /= seg.count;
    my /= seg.count;
    const nl = Math.hypot(nx, ny) || 1;
    const [cx, cy] = poseApply(py, mx, my);
    const onx = (c * nx - s * ny) / nl;
    const ony = (s * nx + c * ny) / nl;
    // along the edge: its own stretch and a little more (page edges of distant pieces need not line up exactly: the
    // assembled page carries a few px of error per seam, and a phone photo's perspective bends a rigid layout)
    const reach = 0.5 * seg.length + 60;
    let out = 0;
    const cx2 = Math.cos(px.theta);
    const sx2 = Math.sin(px.theta);
    for (let k = 0; k < X.deep.length; k += 2) {
      const x = cx2 * X.deep[k] - sx2 * X.deep[k + 1] + px.tx - cx;
      const y = sx2 * X.deep[k] + cx2 * X.deep[k + 1] + px.ty - cy;
      if (x * onx + y * ony <= tol) continue;
      if (Math.abs(-x * ony + y * onx) > reach) continue;
      if (++out > limit) return true;
    }
  }
  return false;
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
  /** Pieces whose rotation their lines hold more firmly than seams (placed against a finished page by their lines). */
  stiffer: Map<string, number> = new Map(),
  deadZone = (0.6 * Math.PI) / 180,
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
    // the page's lines: where most of its pieces' lines agree (within 6°); a piece off them is left to its seams
    const page = linesStiffness > 0 && withLines.length >= 2 ? pageAxis(withLines, pose, lineDirs) : null;
    if (page !== null) {
      // a dead zone (±0.6° by default): text angles are good to about that, and seams that already agree are left alone
      const dz = deadZone;
      for (const id of withLines) {
        const k = 3 * index.get(id)!;
        let e = lineDirs.get(id)! + pose.get(id)!.theta - page;
        e -= Math.PI * Math.round(e / Math.PI);
        if (Math.abs(e) <= dz || Math.abs(e) > LINE_INLIER) continue;
        const ks = stiffer.get(id) ?? linesStiffness;
        H[k * N + k] += ks;
        g[k] += ks * (e - Math.sign(e) * dz);
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

const LINE_INLIER = (6 * Math.PI) / 180;

/** The direction most of these pieces' lines agree on within 6°, refined as the mean of those (null: no majority). */
function pageAxis(ids: string[], pose: Map<string, Pose>, lineDirs: Map<string, number>): number | null {
  const dir = (id: string) => lineDirs.get(id)! + pose.get(id)!.theta;
  let best = -1;
  let axis = 0;
  for (const k of ids) {
    const n = ids.filter((j) => axialDiff(dir(j), dir(k)) <= LINE_INLIER).length;
    if (n > best) {
      best = n;
      axis = dir(k);
    }
  }
  if (best < 2) return null;
  let sx = 0;
  let sy = 0;
  for (const j of ids) {
    if (axialDiff(dir(j), axis) > LINE_INLIER) continue;
    sx += Math.cos(2 * dir(j));
    sy += Math.sin(2 * dir(j));
  }
  return Math.atan2(sy, sx) / 2;
}

/**
 * Is the page bent against its text: of the pieces on the page's lines, at least 3 and 30% turned more than
 * `linesBend` off them? One piece off is more likely a poor text angle than a bent page.
 */
function linesBent(ids: string[], pose: Map<string, Pose>, lineDirs: Map<string, number>, o: AssembleOptions): boolean {
  const withLines = ids.filter((id) => lineDirs.has(id));
  if (withLines.length < 3) return false;
  const axis = pageAxis(withLines, pose, lineDirs);
  if (axis === null) return false;
  let on = 0;
  let off = 0;
  for (const id of withLines) {
    const d = axialDiff(lineDirs.get(id)! + pose.get(id)!.theta, axis);
    if (d > LINE_INLIER) continue;
    on++;
    if (d > o.linesBend) off++;
  }
  return off >= 3 && off >= 0.3 * on;
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
