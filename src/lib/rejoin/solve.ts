// The solver pipeline: analyse fragments → match torn edges → ask the content clue where it matters → assemble.
//
//   const result = await solve(inputs, { content: museCheck });           // one call
// or, staged (the UI can show progress and run model calls itself):
//   const prep = prepare(inputs);                                          // sync: geometry
//   const reqs = contentRequests(prep);                                    // sync: what to ask
//   const verdicts = await Promise.all(reqs.map(museCheck));               // async: S2's callback
//   const result = finish(prep, reqs, verdicts);                           // sync: assembly

import { assemble, ASSEMBLE_DEFAULTS, linesContinue, type AssembleOptions, type ContentEvidence } from "./assemble";
import { permutationVotes, planQuestions, type QuestionPlan, type TwinStrategy } from "./plan";
import { analyzeFragment, type FragmentOptions } from "./fragment";
import { matchFragments, type MatchOptions, type MatchResult } from "./match";
import type { Pose } from "./geom";
import { downscaleInput, workingScale, type ScaleOptions } from "./scale";
import { medianPitch, renderChoiceSheet, renderSeam, type SeamRenderOptions } from "./seam";
import type { Candidate, ContentCheck, ContentRequest, ContentVerdict, Fragment, FragmentInput, SolveResult, Unplaced } from "./types";

export type SolveOptions = {
  /** The content ("crossword") check, injected; stream S2 implements it with Muse Spark. */
  content?: ContentCheck;
  /** Most pair checks to ask (the strongest plausible joins first). Twin groups are always asked. */
  maxPairChecks?: number;
  /** Ask pair checks at all (twin groups are asked either way). */
  pairChecks?: boolean;
  /**
   * Stack tears: a slot between two classes of twins (pieces sharing an outline) can be asked from the pieces of one
   * class ("one", half the calls) or of both ("both", every pick confirmed from the other side).
   */
  twinSides?: "one" | "both";
  /**
   * Stack tears: "all" asks every twin seam (from `twinSides`); "tree" asks along a spanning tree of slots, one side
   * first, and re-asks only where the reads disagree (plan.ts).
   */
  twinStrategy?: TwinStrategy;
  /** Parallel content calls. */
  concurrency?: number;
  fragment?: FragmentOptions;
  match?: Partial<MatchOptions>;
  assemble?: Partial<AssembleOptions>;
  render?: SeamRenderOptions;
  /**
   * Working scale of the geometry (photo px × scale, never above 1). "auto" (default): text lines about
   * `scaleOptions.targetPitch` px apart, measured on the pieces; without text, by the pieces' size. Poses, lengths and
   * page sizes in the result are always in photo px.
   */
  scale?: number | "auto";
  scaleOptions?: Partial<ScaleOptions>;
  onProgress?: (stage: "analyse" | "match" | "content" | "assemble", done: number, total: number) => void;
};

export type Prepared = {
  /** The pieces analysed at the working scale (their coordinates are photo px × scale). */
  fragments: Fragment[];
  byId: Map<string, Fragment>;
  /** The working scale, and the median text-line pitch it was set from (photo px; null without text). */
  scale: number;
  pitch: number | null;
  /** The pieces as given, in photo px: page renders use these with the result's poses. */
  photo: Map<string, { input: FragmentInput }>;
  /** Inputs whose masks gave no usable outline. */
  unusable: Unplaced[];
  match: MatchResult;
  timings: Record<string, number>;
  options: SolveOptions;
};

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Geometry: outlines, edges, text angles, and ranked candidate joins with twin groups. Synchronous. */
export function prepare(inputs: FragmentInput[], options: SolveOptions = {}): Prepared {
  const t0 = now();
  const { scale, pitch } =
    typeof options.scale === "number" ? { scale: Math.min(1, Math.max(0.05, options.scale)), pitch: null } : workingScale(inputs, options.scaleOptions);
  const work = scale < 1 ? inputs.map((inp) => downscaleInput(inp, scale)) : inputs;
  const tScale = now();
  const fragments: Fragment[] = [];
  const unusable: Unplaced[] = [];
  work.forEach((inp, i) => {
    const f = analyzeFragment(inp, i, options.fragment);
    if (f) fragments.push(f);
    else unusable.push({ id: inp.id, reason: "no-match" });
    options.onProgress?.("analyse", i + 1, inputs.length);
  });
  const t1 = now();
  const match = matchFragments(fragments, options.match);
  const t2 = now();
  options.onProgress?.("match", 1, 1);
  return {
    fragments,
    byId: new Map(fragments.map((f) => [f.id, f] as const)),
    scale,
    pitch,
    photo: new Map(inputs.map((inp) => [inp.id, { input: inp }] as const)),
    unusable,
    match,
    timings: { scale: tScale - t0, analyse: t1 - tScale, match: t2 - t1 },
    options,
  };
}

/** A working-scale pose (coordinates photo px × k on both sides) in photo px. */
export function photoPose(p: Pose, k: number): Pose {
  return k === 1 ? p : { theta: p.theta, tx: p.tx / k, ty: p.ty / k };
}

/** A candidate with its pose and lengths in photo px (a copy: requests keep rendering from the working one). */
export function photoCandidate(c: Candidate, k: number): Candidate {
  if (k === 1) return c;
  return { ...c, pose: photoPose(c.pose, k), overlap: c.overlap / k, rms: c.rms / k, shapeRms: c.shapeRms / k, fineRms: c.fineRms / k, areaOverlap: c.areaOverlap / (k * k) };
}

/**
 * What to ask the content check: one k-way choice per twin group (geometry is tied there), and pair checks for the
 * strongest plausible joins (two-clue joins), each with a `render()` that draws the image the model reads.
 */
export function contentRequests(prep: Prepared): ContentRequest[] {
  const o = { ...prep.options, render: { pitchHint: medianPitch(prep.fragments), ...prep.options.render } };
  const minScore = (o.assemble?.minContentScore ?? ASSEMBLE_DEFAULTS.minContentScore);
  const byCand = new Map(prep.match.candidates.map((c) => [c.id, c] as const));
  const upKnown = (id: string) => {
    const t = prep.byId.get(id)?.text;
    return !!t && t.confidence >= 0.4 && t.up !== 0;
  };
  const reqs: ContentRequest[] = [];
  const cls = prep.match.twinClass;
  const asked = new Map<string, number>(); // anchor + partner class → best score already asked
  const groups = [...prep.match.twinGroups].sort((x, y) => (byCand.get(y.candidates[0])?.score ?? 0) - (byCand.get(x.candidates[0])?.score ?? 0));
  for (const g of groups) {
    const cands = g.candidates.map((id) => byCand.get(id)!).filter(Boolean);
    if (!cands.length) continue;
    const partner = cands[0].a === g.anchor ? cands[0].b : cands[0].a;
    const mine = cls.get(g.anchor);
    const theirs = cls.get(partner);
    // one question per anchor and class of partners (partial seams make duplicates)
    const key = `${g.anchor}|${theirs ?? partner}`;
    if (asked.has(key)) continue;
    asked.set(key, cands[0].score);
    // "one": ask each slot from the class with the smaller id (a piece whose twins were not all found keeps its question)
    if ((o.twinStrategy ?? "all") === "all" && (o.twinSides ?? "both") === "one" && mine !== undefined && theirs !== undefined && mine > theirs) continue;
    reqs.push({
      kind: "choice",
      id: `choice:${g.id}`,
      anchor: g.anchor,
      twinGroup: g.id,
      candidates: cands.map((c) => c.id),
      uprightKnown: upKnown(g.anchor),
      render: () => renderChoiceSheet(prep.byId, g.anchor, cands, o.render),
    });
  }
  if (o.pairChecks ?? true) {
    // torn joins first (geometry already strong), then straight cuts (only content can confirm them)
    // a join whose text lines run apart can never be accepted (assemble's linesContinue, with a read or without):
    // reading it would only cost time
    const ao = { ...ASSEMBLE_DEFAULTS, ...o.assemble };
    const pairs = prep.match.candidates
      .filter((c) => !c.twinGroup && c.score >= minScore && c.margin >= 0.7 && (c.edge === "cut" || linesContinue(c, ao)))
      .sort((x, y) => (x.edge === y.edge ? y.score - x.score : x.edge === "torn" ? -1 : 1))
      .slice(0, o.maxPairChecks ?? 48);
    for (const c of pairs) {
      reqs.push({
        kind: "pair",
        id: `pair:${c.id}`,
        candidate: c.id,
        a: c.a,
        b: c.b,
        uprightKnown: upKnown(c.a),
        render: () => renderSeam(prep.byId, c, o.render),
      });
    }
  }
  return reqs;
}

const logit = (p: number) => Math.log(Math.max(1e-3, p) / Math.max(1e-3, 1 - p));

/** Fold verdicts into per-candidate log-odds: a pick adds evidence for it and against the others in its sheet. */
export function fuseVerdicts(reqs: ContentRequest[], verdicts: (ContentVerdict | null)[], prep?: Prepared): ContentEvidence {
  const ev: ContentEvidence = new Map();
  const add = (id: string, lo: number) => {
    const e = ev.get(id) ?? { logOdds: 0, votes: 0, pos: 0 };
    e.logOdds += lo;
    e.votes++;
    if (lo > 0) e.pos = (e.pos ?? 0) + 1;
    ev.set(id, e);
  };
  reqs.forEach((r, i) => {
    const v = verdicts[i];
    if (!v) return;
    const conf = Math.min(0.99, Math.max(0.5, v.confidence));
    if (r.kind === "pair" && v.kind === "pair") {
      if (v.same === null) return;
      add(r.candidate, (v.same ? 1 : -1) * logit(conf));
    } else if (r.kind === "choice" && v.kind === "choice") {
      if (v.choice === null || v.choice < 0 || v.choice >= r.candidates.length) return;
      r.candidates.forEach((id, k) => add(id, k === v.choice ? logit(conf) : -logit(conf)));
    }
  });
  // a pick on a side that forms a consistent matching (and that no read from the other side contradicts) is confirmed
  // by the other picks of its slot: with every twin of one slot read, each pick rules its partner out for the others
  if (prep) {
    const extra = permutationVotes({ candidates: prep.match.candidates, twinClass: prep.match.twinClass }, reqs, verdicts);
    for (const [id, conf] of extra) {
      if ((ev.get(id)?.pos ?? 0) < 2) add(id, logit(Math.min(0.99, Math.max(0.5, conf))));
    }
  }
  return ev;
}

/** Ask the content check for every request, `concurrency` at a time. Failures count as "can't tell". */
export async function askAll(reqs: ContentRequest[], check: ContentCheck, concurrency = 6, onDone?: (n: number) => void): Promise<(ContentVerdict | null)[]> {
  const out: (ContentVerdict | null)[] = new Array(reqs.length).fill(null);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < reqs.length) {
      const i = next++;
      try {
        out[i] = await check(reqs[i]);
      } catch {
        out[i] = null;
      }
      onDone?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, reqs.length) }, worker));
  return out;
}

/** The questions to ask, round by round (see plan.ts). */
export function questionPlan(prep: Prepared): QuestionPlan {
  const trial = (reqs: ContentRequest[], verdicts: (ContentVerdict | null)[]) => {
    const quiet = { ...prep, options: { ...prep.options, onProgress: undefined, assemble: { ...prep.options.assemble, trace: undefined } } };
    return new Set(finish(quiet, reqs, verdicts).joins.map((j) => (j.a < j.b ? `${j.a}|${j.b}` : `${j.b}|${j.a}`)));
  };
  return planQuestions({ candidates: prep.match.candidates, twinClass: prep.match.twinClass, trial }, contentRequests(prep), prep.options.twinStrategy ?? "all");
}

/** Ask the planned questions round by round; returns every question asked and its verdict. */
export async function askPlanned(
  prep: Prepared,
  check: ContentCheck,
  concurrency = 6,
  opts: { onDone?: (n: number) => void; onRound?: (round: ContentRequest[], k: number) => void; stop?: () => boolean } = {},
): Promise<{ reqs: ContentRequest[]; verdicts: (ContentVerdict | null)[] }> {
  const plan = questionPlan(prep);
  const reqs: ContentRequest[] = [];
  const verdicts: (ContentVerdict | null)[] = [];
  const answers = new Map<string, ContentVerdict | null>();
  let round = plan.first;
  let done = 0;
  for (let k = 0; round.length && k < 12; k++) {
    opts.onRound?.(round, k);
    const vs = await askAll(round, check, concurrency, () => opts.onDone?.(++done));
    round.forEach((r, i) => {
      reqs.push(r);
      verdicts.push(vs[i]);
      answers.set(r.id, vs[i]);
    });
    if (opts.stop?.()) break;
    round = plan.next(answers);
  }
  return { reqs, verdicts };
}

/** Assemble pages from the prepared geometry and the content verdicts (if any). Synchronous. */
export function finish(prep: Prepared, reqs: ContentRequest[] = [], verdicts: (ContentVerdict | null)[] = []): SolveResult {
  const t0 = now();
  const evidence = verdicts.some((v) => v) ? fuseVerdicts(reqs, verdicts, prep) : null;
  // stack twins never get a second chance against a finished page: their twins fit the gap as well
  const twins = new Set(prep.match.twinClass.keys());
  const r = assemble(prep.fragments, prep.match.data, prep.match.candidates, evidence, { ...prep.options.assemble, twins });
  const t1 = now();
  prep.options.onProgress?.("assemble", 1, 1);
  // everything back in photo px
  const k = prep.scale;
  return {
    pages: r.pages.map((p) =>
      k === 1 ? p : { ...p, width: p.width / k, height: p.height / k, rms: p.rms / k, fragments: p.fragments.map((f) => ({ ...f, pose: photoPose(f.pose, k) })) },
    ),
    joins: r.joins.map((j) => (k === 1 ? j : { ...j, pose: photoPose(j.pose, k), geometry: { ...j.geometry, rms: j.geometry.rms / k, overlap: j.geometry.overlap / k } })),
    unplaced: [...prep.unusable, ...r.unplaced],
    twinGroups: prep.match.twinGroups,
    candidates: prep.match.candidates.map((c) => photoCandidate(c, k)),
    content: { asked: reqs.length, answered: verdicts.filter((v) => v).length },
    timings: { ...prep.timings, assemble: t1 - t0 },
  };
}

/** The whole pipeline. Without `options.content` it is geometry only (twins stay unresolved). */
export async function solve(inputs: FragmentInput[], options: SolveOptions = {}): Promise<SolveResult> {
  const prep = prepare(inputs, options);
  if (!options.content) return finish(prep);
  const t0 = now();
  let total = 0;
  const { reqs, verdicts } = await askPlanned(prep, options.content, options.concurrency ?? 6, {
    onRound: (round) => (total += round.length),
    onDone: (n) => options.onProgress?.("content", n, total),
  });
  prep.timings.content = now() - t0;
  return finish(prep, reqs, verdicts);
}

/** Candidates by id, for callers holding a request. */
export function candidateById(prep: Prepared, id: string): Candidate | undefined {
  return prep.match.candidates.find((c) => c.id === id);
}
