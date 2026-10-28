// The solver pipeline: analyse fragments → match torn edges → ask the content clue where it matters → assemble.
//
//   const result = await solve(inputs, { content: museCheck });           // one call
// or, staged (the UI can show progress and run model calls itself):
//   const prep = prepare(inputs);                                          // sync: geometry
//   const reqs = contentRequests(prep);                                    // sync: what to ask
//   const verdicts = await Promise.all(reqs.map(museCheck));               // async: S2's callback
//   const result = finish(prep, reqs, verdicts);                           // sync: assembly

import { assemble, ASSEMBLE_DEFAULTS, type AssembleOptions, type ContentEvidence } from "./assemble";
import { analyzeFragment, type FragmentOptions } from "./fragment";
import { matchFragments, type MatchOptions, type MatchResult } from "./match";
import { renderChoiceSheet, renderSeam, type SeamRenderOptions } from "./seam";
import type { Candidate, ContentCheck, ContentRequest, ContentVerdict, Fragment, FragmentInput, SolveResult, Unplaced } from "./types";

export type SolveOptions = {
  /** The content ("crossword") check, injected; stream S2 implements it with Muse Spark. */
  content?: ContentCheck;
  /** Most pair checks to ask (the strongest plausible joins first). Twin groups are always asked. */
  maxPairChecks?: number;
  /** Ask pair checks at all (twin groups are asked either way). */
  pairChecks?: boolean;
  /** Parallel content calls. */
  concurrency?: number;
  fragment?: FragmentOptions;
  match?: Partial<MatchOptions>;
  assemble?: Partial<AssembleOptions>;
  render?: SeamRenderOptions;
  onProgress?: (stage: "analyse" | "match" | "content" | "assemble", done: number, total: number) => void;
};

export type Prepared = {
  fragments: Fragment[];
  byId: Map<string, Fragment>;
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
  const fragments: Fragment[] = [];
  const unusable: Unplaced[] = [];
  inputs.forEach((inp, i) => {
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
    unusable,
    match,
    timings: { analyse: t1 - t0, match: t2 - t1 },
    options,
  };
}

/**
 * What to ask the content check: one k-way choice per twin group (geometry is tied there), and pair checks for the
 * strongest plausible joins (two-clue joins), each with a `render()` that draws the image the model reads.
 */
export function contentRequests(prep: Prepared): ContentRequest[] {
  const o = prep.options;
  const minScore = (o.assemble?.minContentScore ?? ASSEMBLE_DEFAULTS.minContentScore);
  const byCand = new Map(prep.match.candidates.map((c) => [c.id, c] as const));
  const reqs: ContentRequest[] = [];
  for (const g of prep.match.twinGroups) {
    const cands = g.candidates.map((id) => byCand.get(id)!).filter(Boolean);
    reqs.push({
      kind: "choice",
      id: `choice:${g.id}`,
      anchor: g.anchor,
      twinGroup: g.id,
      candidates: cands.map((c) => c.id),
      render: () => renderChoiceSheet(prep.byId, g.anchor, cands, o.render),
    });
  }
  if (o.pairChecks ?? true) {
    const pairs = prep.match.candidates
      .filter((c) => !c.twinGroup && c.score >= minScore && c.margin >= 0.7)
      .slice(0, o.maxPairChecks ?? 48);
    for (const c of pairs) {
      reqs.push({ kind: "pair", id: `pair:${c.id}`, candidate: c.id, a: c.a, b: c.b, render: () => renderSeam(prep.byId, c, o.render) });
    }
  }
  return reqs;
}

const logit = (p: number) => Math.log(Math.max(1e-3, p) / Math.max(1e-3, 1 - p));

/** Fold verdicts into per-candidate log-odds: a pick adds evidence for it and against the others in its sheet. */
export function fuseVerdicts(reqs: ContentRequest[], verdicts: (ContentVerdict | null)[]): ContentEvidence {
  const ev: ContentEvidence = new Map();
  const add = (id: string, lo: number) => {
    const e = ev.get(id) ?? { logOdds: 0, votes: 0 };
    e.logOdds += lo;
    e.votes++;
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

/** Assemble pages from the prepared geometry and the content verdicts (if any). Synchronous. */
export function finish(prep: Prepared, reqs: ContentRequest[] = [], verdicts: (ContentVerdict | null)[] = []): SolveResult {
  const t0 = now();
  const evidence = verdicts.some((v) => v) ? fuseVerdicts(reqs, verdicts) : null;
  const r = assemble(prep.fragments, prep.match.data, prep.match.candidates, evidence, prep.options.assemble);
  const t1 = now();
  prep.options.onProgress?.("assemble", 1, 1);
  return {
    pages: r.pages,
    joins: r.joins,
    unplaced: [...prep.unusable, ...r.unplaced],
    twinGroups: prep.match.twinGroups,
    candidates: prep.match.candidates,
    content: { asked: reqs.length, answered: verdicts.filter((v) => v).length },
    timings: { ...prep.timings, assemble: t1 - t0 },
  };
}

/** The whole pipeline. Without `options.content` it is geometry only (twins stay unresolved). */
export async function solve(inputs: FragmentInput[], options: SolveOptions = {}): Promise<SolveResult> {
  const prep = prepare(inputs, options);
  if (!options.content) return finish(prep);
  const reqs = contentRequests(prep);
  const t0 = now();
  const verdicts = await askAll(reqs, options.content, options.concurrency ?? 6, (n) => options.onProgress?.("content", n, reqs.length));
  prep.timings.content = now() - t0;
  return finish(prep, reqs, verdicts);
}

/** Candidates by id, for callers holding a request. */
export function candidateById(prep: Prepared, id: string): Candidate | undefined {
  return prep.match.candidates.find((c) => c.id === id);
}
