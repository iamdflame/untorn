// Which questions to put to the content check, for stack tears.
//
// Pages torn as a stack share their tear paths, so every slot of the tear layout holds k "twins" (one per page) with the
// same outline, and every seam between two slots X and Y offers k × k joins that geometry cannot tell apart. Reading
// decides. Asking every slot from both sides ("all") costs 2k sheets per seam, about 95 sheets for a 3-page stack of
// 6–10 pieces per page.
//
// The "tree" strategy asks along a spanning tree of slots instead:
//   1. Slots are twin classes; seams between them are weighted by the best fit's score (long seams carry more text).
//   2. Round 1 asks one side of every seam on the maximum spanning tree (k sheets per seam).
//   3. A side whose k picks are decisive and all different is a consistent matching. One sheet from the other side
//      spot-checks it (the partner of the least confident pick). If it agrees, every pick is confirmed: the spot check
//      directly, the others by the permutation vote (their slot-mates' picks rule their partner out, `permutationVotes`).
//   4. A collision, a non-answer or a failed spot check asks the rest of the other side. A seam whose two sides still
//      disagree drops out, and the tree is mended with the next-best seams.
//   5. After each round a trial assembly checks that every settled seam really joined its pieces.
// It stops when the tree spans the slots or nothing is left to ask. Seams off the tree are not read: once the pages are
// built their pieces already sit side by side, and the assembler accepts those seams as loop closures.

import type { Candidate, ContentRequest, ContentVerdict } from "./types";

type ChoiceRequest = Extract<ContentRequest, { kind: "choice" }>;

export type TwinStrategy = "all" | "tree";

type PlanContext = {
  candidates: Candidate[];
  /** Piece → twin class (pieces with one outline). Pieces without twins are their own class. */
  twinClass: Map<string, string>;
  /**
   * A trial assembly from the answers so far: the pairs of pieces it joined ("a|b", sorted). A seam only counts as
   * settled when its pieces were actually joined (the assembler can still refuse a join, e.g. on a taken seam).
   */
  trial?: (reqs: ContentRequest[], verdicts: (ContentVerdict | null)[]) => Set<string>;
};

/** A seam between two slots, asked from either side. */
type SlotSeam = {
  key: string;
  ends: [string, string];
  score: number;
  /** Choice requests per side (slot id → its anchors' sheets). */
  sides: Map<string, ChoiceRequest[]>;
};

type Pick = { partner: string; candidate: string; confidence: number };
type Answers = Map<string, ContentVerdict | null>;

const DECISIVE = 0.5;
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const other = (s: SlotSeam, id: string) => (s.ends[0] === id ? s.ends[1] : s.ends[0]);

function partnerOf(c: Candidate, anchor: string): string {
  return c.a === anchor ? c.b : c.a;
}

function classMembers(twinClass: Map<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [id, cls] of twinClass) {
    const l = out.get(cls) ?? [];
    l.push(id);
    out.set(cls, l);
  }
  return out;
}

/** Group the choice requests into seams between slots, strongest first. */
function slotSeams(ctx: PlanContext, reqs: ContentRequest[]): SlotSeam[] {
  const byCand = new Map(ctx.candidates.map((c) => [c.id, c] as const));
  const slot = (id: string) => ctx.twinClass.get(id) ?? id;
  const seams = new Map<string, SlotSeam>();
  for (const r of reqs) {
    if (r.kind !== "choice" || !r.candidates.length) continue;
    const first = byCand.get(r.candidates[0]);
    if (!first) continue;
    const x = slot(r.anchor);
    const y = slot(partnerOf(first, r.anchor));
    if (x === y) continue;
    const ends: [string, string] = x < y ? [x, y] : [y, x];
    const key = ends.join("|");
    const s = seams.get(key) ?? { key, ends, score: 0, sides: new Map() };
    const l = s.sides.get(x) ?? [];
    l.push(r);
    s.sides.set(x, l);
    for (const id of r.candidates) s.score = Math.max(s.score, byCand.get(id)?.score ?? 0);
    seams.set(key, s);
  }
  return [...seams.values()].sort((p, q) => q.score - p.score || (p.key < q.key ? -1 : 1));
}

/** One sheet's decisive pick (null: not asked, failed, no choice, or not confident). */
function pickOf(byCand: Map<string, Candidate>, r: ChoiceRequest, answers: Answers): Pick | null {
  const v = answers.get(r.id);
  if (!v || v.kind !== "choice" || v.choice === null || v.choice < 0 || v.choice >= r.candidates.length || v.confidence <= DECISIVE) return null;
  const c = byCand.get(r.candidates[v.choice]);
  return c ? { partner: partnerOf(c, r.anchor), candidate: c.id, confidence: v.confidence } : null;
}

/**
 * A side forms a consistent matching when every member of its slot was asked over the whole other slot, every pick
 * is decisive and no two picks share a partner. Returns anchor → pick, or null.
 */
function matching(byCand: Map<string, Candidate>, members: Map<string, string[]>, s: SlotSeam, side: string, answers: Answers): Map<string, Pick> | null {
  const sheets = s.sides.get(side) ?? [];
  const mine = members.get(side) ?? [side];
  const theirs = members.get(other(s, side)) ?? [other(s, side)];
  if (mine.length < 2 || sheets.length !== mine.length || theirs.length !== mine.length) return null;
  if (sheets.some((r) => r.candidates.length !== theirs.length)) return null;
  const out = new Map<string, Pick>();
  const seen = new Set<string>();
  for (const r of sheets) {
    const p = pickOf(byCand, r, answers);
    if (!p || seen.has(p.partner)) return null;
    seen.add(p.partner);
    out.set(r.anchor, p);
  }
  return out;
}

/** Does any answered sheet from the other side contradict a matching (pick a different partner)? */
function contradicted(byCand: Map<string, Candidate>, s: SlotSeam, side: string, m: Map<string, Pick>, answers: Answers): boolean {
  const back = new Map([...m].map(([anchor, p]) => [p.partner, anchor] as const));
  for (const r of s.sides.get(other(s, side)) ?? []) {
    const p = pickOf(byCand, r, answers);
    if (p && back.get(r.anchor) !== p.partner) return true;
  }
  return false;
}

/** Answered sheets from the other side that agree with a matching. */
function agreeing(byCand: Map<string, Candidate>, s: SlotSeam, side: string, m: Map<string, Pick>, answers: Answers): number {
  const back = new Map([...m].map(([anchor, p]) => [p.partner, anchor] as const));
  let n = 0;
  for (const r of s.sides.get(other(s, side)) ?? []) {
    const p = pickOf(byCand, r, answers);
    if (p && back.get(r.anchor) === p.partner) n++;
  }
  return n;
}

/**
 * The permutation vote: on a side that forms a consistent matching, not contradicted from the other side, each pick
 * gains a second, independent vote from the other sheets of its slot, which rule its partner out for themselves. Its
 * weight is the least confident of those other picks. Returns that confidence per candidate id.
 */
export function permutationVotes(ctx: PlanContext, reqs: ContentRequest[], verdicts: (ContentVerdict | null)[]): Map<string, number> {
  const answers: Answers = new Map();
  reqs.forEach((r, i) => answers.set(r.id, verdicts[i] ?? null));
  const byCand = new Map(ctx.candidates.map((c) => [c.id, c] as const));
  const members = classMembers(ctx.twinClass);
  const out = new Map<string, number>();
  for (const s of slotSeams(ctx, reqs)) {
    for (const side of s.sides.keys()) {
      const m = matching(byCand, members, s, side, answers);
      if (!m || contradicted(byCand, s, side, m, answers)) continue;
      const all = [...m.values()];
      for (const p of all) out.set(p.candidate, Math.min(...all.filter((q) => q !== p).map((q) => q.confidence)));
    }
  }
  return out;
}

class Forest {
  private parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string) {
    this.parent.set(this.find(a), this.find(b));
  }
}

export type QuestionPlan = {
  /** The first round: every question for "all"; pair checks and one side of each spanning-tree seam for "tree". */
  first: ContentRequest[];
  /** The next round from the answers so far (request id → verdict); empty when done. */
  next: (answers: Answers) => ContentRequest[];
};

/** Plan the questions. `all` holds every question that could be asked (both sides of every twin seam). */
export function planQuestions(ctx: PlanContext, all: ContentRequest[], strategy: TwinStrategy): QuestionPlan {
  if (strategy === "all") return { first: all, next: () => [] };
  const byCand = new Map(ctx.candidates.map((c) => [c.id, c] as const));
  const members = classMembers(ctx.twinClass);
  const seams = slotSeams(ctx, all);
  const asked = new Set<string>();
  const askedList: ContentRequest[] = [];

  /** The side to read first: the one with a sheet for every member of its slot, then the more sheets, then by id. */
  const firstSide = (s: SlotSeam): string => {
    const rank = (id: string) => {
      const side = s.sides.get(id) ?? [];
      return (side.length === (members.get(id)?.length ?? 1) ? 1000 : 0) + side.length;
    };
    return rank(s.ends[1]) > rank(s.ends[0]) ? s.ends[1] : s.ends[0];
  };
  const unasked = (s: SlotSeam, side: string) => (s.sides.get(side) ?? []).filter((r) => !asked.has(r.id));
  const touched = (s: SlotSeam, side: string) => (s.sides.get(side) ?? []).some((r) => asked.has(r.id));

  type Status = { settled: boolean; ask: ContentRequest[] };
  const status = (s: SlotSeam, answers: Answers): Status => {
    const sides = s.ends.filter((id) => touched(s, id));
    if (!sides.length) {
      const side = firstSide(s);
      return { settled: false, ask: s.sides.get(side) ?? [] };
    }
    // a matching on a fully read side, spot-checked (or fully confirmed) from the other side
    for (const side of sides) {
      if (unasked(s, side).length) continue;
      const m = matching(byCand, members, s, side, answers);
      if (!m) continue;
      if (contradicted(byCand, s, side, m, answers)) continue;
      if (agreeing(byCand, s, side, m, answers) >= 1) return { settled: true, ask: [] };
      // the spot check: the other side's sheet for the partner of the least confident pick
      const weakest = [...m.values()].sort((p, q) => p.confidence - q.confidence)[0];
      const spot = (s.sides.get(other(s, side)) ?? []).find((r) => r.anchor === weakest.partner && !asked.has(r.id));
      const rest = unasked(s, other(s, side));
      if (spot) return { settled: false, ask: [spot] };
      if (rest.length) return { settled: false, ask: rest.slice(0, 1) };
    }
    // both sides read: every anchor of one side confirmed from the other (mutual picks)
    for (const side of sides) {
      const sheets = s.sides.get(side) ?? [];
      if (unasked(s, side).length || !sheets.length) continue;
      const back = s.sides.get(other(s, side)) ?? [];
      const mutual = sheets.every((r) => {
        const p = pickOf(byCand, r, answers);
        const q = p && back.find((b) => b.anchor === p.partner);
        return !!q && pickOf(byCand, q, answers)?.partner === r.anchor;
      });
      if (mutual) return { settled: true, ask: [] };
    }
    // otherwise read whatever is left of this seam (the rest of a side, or the other side)
    const left = s.ends.flatMap((id) => unasked(s, id));
    return { settled: false, ask: left };
  };
  const joinedAcross = (s: SlotSeam, joined: Set<string>): boolean => {
    for (const side of s.ends) {
      const theirs = members.get(other(s, side)) ?? [other(s, side)];
      for (const r of s.sides.get(side) ?? []) if (asked.has(r.id) && !theirs.some((t) => joined.has(pairKey(r.anchor, t)))) return false;
    }
    return true;
  };

  const round = (answers: Answers): ContentRequest[] => {
    const known = askedList.filter((r) => answers.has(r.id));
    const joined = ctx.trial && known.length ? ctx.trial(known, known.map((r) => answers.get(r.id) ?? null)) : null;
    const st = new Map(seams.map((s) => [s.key, status(s, answers)] as const));
    const done = (s: SlotSeam) => st.get(s.key)!.settled && (!joined || joinedAcross(s, joined));
    const forest = new Forest();
    for (const s of seams) if (done(s)) forest.union(...s.ends);
    // mend the tree, strongest seams first: a seam in progress reads its next sheets, an unread seam its first side
    const out: ContentRequest[] = [];
    for (const s of seams) {
      if (forest.find(s.ends[0]) === forest.find(s.ends[1]) || done(s)) continue;
      const next = st.get(s.key)!.ask.filter((r) => !asked.has(r.id));
      if (!next.length) continue; // read in full and still unsettled: it stays off the tree
      out.push(...next);
      forest.union(...s.ends);
    }
    for (const r of out) {
      asked.add(r.id);
      askedList.push(r);
    }
    return out;
  };

  const pairs = all.filter((r) => r.kind === "pair");
  for (const r of pairs) {
    asked.add(r.id);
    askedList.push(r);
  }
  return { first: [...pairs, ...round(new Map())], next: round };
}
