// Assembly for straight cuts: the pieces tile one page, so every accepted join must keep the page consistent.
//
// Two clues per join, never forced:
// - geometry: the side pair lines up end to end at matching corners (and the text lines agree);
// - content: the ink continues across the cut, or Muse read across it and said "same".
// Joins are accepted best first. A join between two groups is refused when it would make placed pieces overlap; a
// join inside one group must agree with the placement it closes a loop on. A side with no ink on either piece (a blank
// margin) has no content clue; it is accepted only when a second side of the same piece agrees with the same placement
// (two geometric clues). Pieces that join nothing stay unplaced.

import { axialDiff, poseApply, poseCompose, poseInvert, wrapAngle, type Pose } from "./geom";
import { readingDirection, type PieceShape, type StraightCandidate } from "./straight";
import type { Clue, Fragment, Join, Page, Unplaced } from "./types";

export type TilingOptions = {
  /** The geometry clue: at least this score (corner alignment, text agreement, overlap). */
  minGeometry: number;
  /** The content clue from the ink alone: at least this score. */
  minContent: number;
  /** A side pair with no corner aligned: shortest overlap (px) for its geometry to count (with a reading). */
  freeOverlap: number;
  /** Ink evidence below this speaks against a join (blank-seam pass). */
  maxDoubt: number;
  /** Loop closure: px at the piece's centroid and degrees. */
  loopPx: number;
  loopDeg: number;
  /** Deep overlap allowed between two placed pieces: px² plus a share of the smaller piece. */
  overlapPx: number;
  overlapShare: number;
  /** Depth (px) and grid step (px) of the interior samples used for overlaps. */
  deepPx: number;
  step: number;
  /** Ascender-vote confidence that counts towards a group's reading direction. */
  minUp: number;
  /** Two blank seams that agree on a placement must cross at least this angle (degrees). */
  minSeamAngle: number;
};

export const TILING_DEFAULTS: TilingOptions = {
  minGeometry: 1.5,
  minContent: 1.2,
  freeOverlap: 150,
  maxDoubt: -1.5,
  loopPx: 14,
  loopDeg: 1.5,
  overlapPx: 400,
  overlapShare: 0.012,
  deepPx: 8,
  step: 6,
  minUp: 0.8,
  minSeamAngle: 20,
};

/** A content verdict on one candidate (Muse's verifySeam): same place or not, with its confidence. */
export type SeamVerdict = { same: boolean | null; confidence: number };

export type TilingResult = { pages: Page[]; joins: Join[]; unplaced: Unplaced[]; trace: { id: string; outcome: string }[] };

type Group = { id: number; members: string[]; pose: Map<string, Pose> };

function deepSamples(f: Fragment, deepPx: number, step: number): Float64Array {
  const { mask, x0, y0 } = f.input;
  const out: number[] = [];
  for (let r = 1; r < mask.height; r += step) {
    for (let c = 1; c < mask.width; c += step) if (f.depth[r * mask.width + c] >= deepPx) out.push(x0 + c + 0.5, y0 + r + 0.5);
  }
  return Float64Array.from(out);
}

/** Area (px²) of B's deep interior landing deep inside A, with B at poseB and A at poseA (both photo → frame). */
function overlapArea(A: Fragment, poseA: Pose, B: Fragment, deepB: Float64Array, poseB: Pose, o: TilingOptions): number {
  const rel = poseCompose(poseInvert(poseA), poseB);
  const c = Math.cos(rel.theta);
  const s = Math.sin(rel.theta);
  const { mask, x0, y0 } = A.input;
  let hits = 0;
  for (let k = 0; k < deepB.length; k += 2) {
    const x = c * deepB[k] - s * deepB[k + 1] + rel.tx - x0;
    const y = s * deepB[k] + c * deepB[k + 1] + rel.ty - y0;
    const col = Math.floor(x);
    const row = Math.floor(y);
    if (col < 0 || row < 0 || col >= mask.width || row >= mask.height) continue;
    if (A.depth[row * mask.width + col] >= o.deepPx) hits++;
  }
  return hits * o.step * o.step;
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Assemble pages from straight-side candidates and (optional) Muse verdicts keyed by candidate id. */
export function assembleTiles(shapes: PieceShape[], cands: StraightCandidate[], verdicts: Map<string, SeamVerdict> | null, options: Partial<TilingOptions> = {}): TilingResult {
  const o = { ...TILING_DEFAULTS, ...options };
  const byId = new Map(shapes.map((s) => [s.f.id, s] as const));
  const deep = new Map(shapes.map((s) => [s.f.id, deepSamples(s.f, o.deepPx, o.step)] as const));
  const groupOf = new Map<string, Group>();
  shapes.forEach((s, k) => groupOf.set(s.f.id, { id: k, members: [s.f.id], pose: new Map([[s.f.id, { theta: 0, tx: 0, ty: 0 }]]) }));
  const trace: { id: string; outcome: string }[] = [];
  const accepted: { c: StraightCandidate; decidedBy: Clue; loop: boolean; content: Join["content"] }[] = [];
  const joined = new Set<string>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  // the clues of each candidate
  const scored = cands.map((c) => {
    const v = verdicts?.get(c.id) ?? null;
    const muse = v && v.same !== null ? (v.same ? 1 : -1) * 4 * Math.max(0.5, Math.min(0.99, v.confidence)) : 0;
    // a corner-aligned side pair is the geometry clue. A pair with no corner aligned slides freely along the cut, and
    // text lines make the ink along a cut nearly periodic (one line further along correlates almost as well), so its
    // content clue can only come from reading across the seam
    const free = c.straight.ends === 0;
    const geometry = free ? c.straight.overlap >= o.freeOverlap && c.straight.textDiff !== null : c.straight.geometry >= o.minGeometry;
    // and the ink, which mostly says "text lines at the same height", only confirms the strongest geometry: both
    // corners aligned and the lengths equal. A single shared corner (or a T) leaves room for a lucky line phase.
    const inkClue = c.straight.ends === 2 && c.straight.content >= o.minContent;
    const museSaysNo = v?.same === false;
    const content = !museSaysNo && (inkClue || v?.same === true);
    return { c, v, geometry, content, museSaysNo, total: c.straight.geometry + c.straight.content + muse };
  });

  /** Try to place B's group against A's through candidate c; returns the reason it was refused, or null when placed. */
  const tryJoin = (c: StraightCandidate, decidedBy: Clue, content: Join["content"], read = false): string | null => {
    const ga = groupOf.get(c.a)!;
    const gb = groupOf.get(c.b)!;
    if (joined.has(pairKey(c.a, c.b))) return "pair-joined";
    const poseA = ga.pose.get(c.a)!;
    if (ga === gb) {
      // a loop: the candidate must agree with the placement already there
      const predicted = poseCompose(poseA, c.pose);
      const have = gb.pose.get(c.b)!;
      const [cx, cy] = byId.get(c.b)!.f.centroid;
      const [x1, y1] = poseApply(predicted, cx, cy);
      const [x2, y2] = poseApply(have, cx, cy);
      if (Math.hypot(x1 - x2, y1 - y2) > o.loopPx || Math.abs(wrapAngle(predicted.theta - have.theta)) > (o.loopDeg * Math.PI) / 180) return "loop-disagrees";
      joined.add(pairKey(c.a, c.b));
      accepted.push({ c, decidedBy, loop: true, content });
      return null;
    }
    // B's group moves into A's frame: T maps B-group frame → A-group frame
    const T = poseCompose(poseCompose(poseA, c.pose), poseInvert(gb.pose.get(c.b)!));
    // text lines are axial, so a group turned 180° still lines up: both groups must read the same way up by the
    // pooled ascender votes of their pieces (a group whose votes disagree abstains)
    const va = groupReading(ga, byId, o.minUp);
    const vb = groupReading(gb, byId, o.minUp);
    // (a reading across the seam that said "same" saw the words run on, which settles the way up)
    if (!read && va && vb && Math.cos(vb.angle + T.theta - va.angle) < 0) return "flip";
    for (const x of ga.members) {
      for (const y of gb.members) {
        const X = byId.get(x)!.f;
        const Y = byId.get(y)!.f;
        const py = poseCompose(T, gb.pose.get(y)!);
        const px = ga.pose.get(x)!;
        const allowed = o.overlapPx + o.overlapShare * Math.min(X.area, Y.area);
        const area = overlapArea(X, px, Y, deep.get(y)!, py, o);
        if (area > allowed) return `overlap ${x}/${y} ${Math.round(area)}>${Math.round(allowed)}`;
      }
    }
    for (const y of gb.members) {
      ga.pose.set(y, poseCompose(T, gb.pose.get(y)!));
      ga.members.push(y);
      groupOf.set(y, ga);
    }
    joined.add(pairKey(c.a, c.b));
    accepted.push({ c, decidedBy, loop: false, content });
    return null;
  };

  // pass 1 · both clues
  const firm = scored.filter((s) => s.geometry && s.content).sort((x, y) => y.total - x.total);
  for (const s of firm) {
    const content = { same: true, confidence: sigmoid(s.c.straight.content + (s.v?.same ? 2 : 0)), votes: s.v ? 1 : 0 };
    const why = tryJoin(s.c, "geometry+content", content, s.v?.same === true);
    trace.push({ id: s.c.id, outcome: why ?? "accepted" });
  }

  // pass 2 · seams the ink cannot judge (blank paper, or a cut along the text lines): two geometry-only sides that agree
  //          on the same placement of a group
  // (the second side may have a weak ink reading, as long as it does not speak against the join)
  const blank = scored.filter((s) => s.geometry && s.c.straight.ends > 0 && !s.content && !s.museSaysNo && s.c.straight.content > o.maxDoubt);
  let progress = true;
  while (progress) {
    progress = false;
    for (let i = 0; i < blank.length && !progress; i++) {
      const s = blank[i].c;
      const ga = groupOf.get(s.a)!;
      const gb = groupOf.get(s.b)!;
      if (ga === gb) continue;
      const T = poseCompose(poseCompose(ga.pose.get(s.a)!, s.pose), poseInvert(gb.pose.get(s.b)!));
      /** Direction (rad, axial) of a candidate's seam in group A's frame. */
      const seamAngle = (c: StraightCandidate, g: Group) => {
        const d = byId.get(c.a)!.poly.sides[c.straight.sideA].dir;
        const th = g.pose.get(c.a)!.theta + (g === ga ? 0 : T.theta);
        return Math.atan2(d[1], d[0]) + th;
      };
      const sAngle = seamAngle(s, ga);
      // a second candidate between the same two groups, through a different pair of pieces or sides, that agrees and
      // pins the placement independently: its seam must not run parallel to the first (two fits along one line, say
      // against two collinear page edges, leave the piece free to be wrong together)
      const second = blank.find((t, j) => {
        if (j === i) return false;
        const c = t.c;
        const g1 = groupOf.get(c.a)!;
        const g2 = groupOf.get(c.b)!;
        let T2: Pose;
        if (g1 === ga && g2 === gb) T2 = poseCompose(poseCompose(ga.pose.get(c.a)!, c.pose), poseInvert(gb.pose.get(c.b)!));
        else if (g1 === gb && g2 === ga) T2 = poseInvert(poseCompose(poseCompose(gb.pose.get(c.a)!, c.pose), poseInvert(ga.pose.get(c.b)!)));
        else return false;
        if (c.a === s.a && c.b === s.b && c.straight.sideA === s.straight.sideA) return false;
        if (axialDiff(seamAngle(c, g1), sAngle) < (o.minSeamAngle * Math.PI) / 180) return false;
        const [cx, cy] = byId.get(s.b)!.f.centroid;
        const pb = gb.pose.get(s.b)!;
        const [x0, y0] = poseApply(pb, cx, cy);
        const [x1, y1] = poseApply(T, x0, y0);
        const [x2, y2] = poseApply(T2, x0, y0);
        return Math.hypot(x1 - x2, y1 - y2) <= o.loopPx && Math.abs(wrapAngle(T.theta - T2.theta)) <= (o.loopDeg * Math.PI) / 180;
      });
      if (!second) continue;
      const why = tryJoin(s, "geometry", null);
      trace.push({ id: s.id, outcome: why ? `blank-${why}` : "accepted-two-sides" });
      if (!why) progress = true;
    }
  }

  // loop joins implied by the final placement (reported, they do not move anything)
  for (const s of scored) {
    if (!s.geometry || s.museSaysNo || joined.has(pairKey(s.c.a, s.c.b))) continue;
    const ga = groupOf.get(s.c.a)!;
    if (ga !== groupOf.get(s.c.b)) continue;
    tryJoin(s.c, s.content ? "geometry+content" : "geometry", null);
  }

  // pages: one per group with at least two pieces, turned upright
  const groups = [...new Set(groupOf.values())];
  const pages: Page[] = [];
  const unplaced: Unplaced[] = [];
  const joins: Join[] = [];
  for (const g of groups) {
    if (g.members.length < 2) {
      unplaced.push({ id: g.members[0], reason: "no-match" });
      continue;
    }
    const id = `page-${pages.length}`;
    const up = uprightPoses(g, byId);
    const { width, height, poses } = normalise(g, byId, up.rot);
    const mine = accepted.filter((a) => g.members.includes(a.c.a));
    const usedLen = mine.reduce((s, a) => s + a.c.straight.overlap, 0);
    const straightLen = g.members.reduce((s, m) => s + byId.get(m)!.poly.straightLength, 0);
    pages.push({
      id,
      fragments: g.members.map((m) => ({ id: m, pose: poses.get(m)! })),
      width,
      height,
      confidence: mine.length ? Math.min(...mine.map((a) => a.content?.confidence ?? 0.5)) : 0,
      completeness: straightLen ? Math.min(1, (2 * usedLen) / straightLen) : 0,
      pageCorners: 0,
      upright: up.upright,
      rms: 0,
    });
    for (const a of mine) {
      joins.push({
        candidate: a.c.id,
        a: a.c.a,
        b: a.c.b,
        pose: a.c.pose,
        geometry: { score: a.c.score, confidence: sigmoid(a.c.straight.geometry - 1), rms: 0, overlap: a.c.straight.overlap, margin: Infinity },
        appearance: a.c.appearance,
        content: a.content,
        decidedBy: a.decidedBy,
        confidence: sigmoid(a.c.straight.geometry + a.c.straight.content - 2),
        loop: a.loop,
        page: id,
      });
    }
  }
  return { pages, joins, unplaced, trace };
}

/** A group's reading direction (rad, group frame) from its pieces' clear ascender votes, when they agree. */
function groupReading(g: Group, byId: Map<string, PieceShape>, minUp: number): { angle: number } | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const id of g.members) {
    const r = readingDirection(byId.get(id)!, minUp);
    if (r === null) continue;
    const a = r + g.pose.get(id)!.theta;
    sx += Math.cos(a);
    sy += Math.sin(a);
    n++;
  }
  if (!n || Math.hypot(sx, sy) < 0.6 * n) return null;
  return { angle: Math.atan2(sy, sx) };
}

/** Rotation that makes the group's text lines horizontal and reading left to right (when the up vote is clear). */
function uprightPoses(g: Group, byId: Map<string, PieceShape>): { rot: number; upright: Page["upright"] } {
  let sx = 0;
  let sy = 0;
  let wt = 0;
  for (const id of g.members) {
    const t = byId.get(id)!.f.text;
    if (!t || t.confidence < 0.3) continue;
    const a = 2 * (t.angle + g.pose.get(id)!.theta);
    const w = t.confidence * Math.sqrt(t.ink);
    sx += w * Math.cos(a);
    sy += w * Math.sin(a);
    wt += w;
  }
  if (!wt || Math.hypot(sx, sy) / wt < 0.5) return { rot: 0, upright: { by: "none", flipKnown: false } };
  const axis = Math.atan2(sy, sx) / 2;
  let vote = 0;
  for (const id of g.members) {
    const t = byId.get(id)!.f.text;
    if (!t || t.up === 0 || t.confidence < 0.3) continue;
    const reading = t.angle + (t.up === 1 ? 0 : Math.PI) + g.pose.get(id)!.theta;
    vote += Math.sign(Math.cos(reading - axis)) * t.upConfidence * t.confidence * Math.sqrt(t.ink);
  }
  return { rot: -axis + (vote < 0 ? Math.PI : 0), upright: { by: "text", flipKnown: Math.abs(vote) > 0.25 * wt } };
}

/** Poses photo → page: the group rotated by `rot`, shifted so the placed pieces start at (0, 0). */
function normalise(g: Group, byId: Map<string, PieceShape>, rot: number): { width: number; height: number; poses: Map<string, Pose> } {
  const R: Pose = { theta: rot, tx: 0, ty: 0 };
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const id of g.members) {
    const f = byId.get(id)!.f;
    const p = poseCompose(R, g.pose.get(id)!);
    for (let i = 0; i < f.outline.length; i += 8) {
      const [x, y] = poseApply(p, f.outline[i], f.outline[i + 1]);
      minx = Math.min(minx, x);
      maxx = Math.max(maxx, x);
      miny = Math.min(miny, y);
      maxy = Math.max(maxy, y);
    }
  }
  const poses = new Map<string, Pose>();
  for (const id of g.members) poses.set(id, poseCompose({ theta: 0, tx: -minx, ty: -miny }, poseCompose(R, g.pose.get(id)!)));
  return { width: Math.ceil(maxx - minx), height: Math.ceil(maxy - miny), poses };
}
