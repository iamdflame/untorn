// Eval harness for the Untorn solver on Bench-S cases.
//
//   pnpm tsx scripts/eval/solver.ts                                   # every case in scripts/bench/out, geometry only
//   pnpm tsx scripts/eval/solver.ts --family single --content oracle:0.1
//   pnpm tsx scripts/eval/solver.ts --family stack --content module:./path/to/muse-check.ts
//
// Options:
//   --root DIR          cases directory (default scripts/bench/out)
//   --family a,b        families to run (default: all but dev*)
//   --content MODE      none | oracle:<error rate> | module:<path exporting createContentCheck() or a default ContentCheck>
//   --masks sam|gt      SAM-like noisy masks (default) or exact masks
//   --limit N           first N cases per family
//   --json FILE         write per-case results as JSON
//   --renders DIR       save the content-check images of the first case (pair + choice sheets) as PNG
//   --twin-sides one|both  ask each stack slot from both classes of twins (default) or one
//   --strategy all|tree    ask every twin seam (default) or along a spanning tree of slots (plan.ts)
//   --no-twin-loops        do not accept twin seams that close a loop without a read
//   --compare RATES        compare the strategies with the oracle at each error rate (e.g. 0,0.05,0.1), --trials N
//                          oracle seeds per case (default 5); geometry is prepared once per case
//   --cuts              also match straight cuts (opt-in; for scissor-cut and ShredBench-style pieces)
//   --scale auto|K     working scale of the geometry (default auto: text lines ~32 px apart, never enlarged)
//   --match JSON, --assemble JSON   override solver options (experiments), e.g. --match '{"textSeeds":false}'
//
// Metrics: a fragment is placed correctly when its pose is within 3 px (at its centroid) and 1° of the truth, up to
// one rigid transform per page; joins are correct when the pair is adjacent on the page and the joined pose agrees
// within 4 px / 1.5°. A page is perfect when all its fragments are placed correctly in one predicted page that holds
// no foreign fragment.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fitRigid, poseApply, poseCompose, poseInvert, rng, type Pose } from "../../src/lib/rejoin/geom";
import { encodePng } from "../../src/lib/rejoin/render";
import { askPlanned, finish, photoCandidate, prepare } from "../../src/lib/rejoin/solve";
import type { Candidate, ContentCheck, ContentRequest, ContentVerdict, Fragment, SolveResult } from "../../src/lib/rejoin/types";
import type { Placement } from "../../src/lib/rejoin/assemble";
import { listCases, loadCase, trueRelative, type BenchCase, type GroundTruth } from "./cases";

type Args = {
  root: string;
  family?: string[];
  content: string;
  masks: "sam" | "gt";
  limit: number;
  json?: string;
  renders?: string;
  twinSides: "one" | "both";
  cuts: boolean;
  strategy: "all" | "tree";
  twinLoops: boolean;
  compare?: number[];
  trials: number;
  scale: number | "auto";
  match: Record<string, unknown>;
  assemble: Record<string, unknown>;
};

function parseArgs(argv: string[]): Args {
  const a: Args = {
    root: path.join(process.cwd(), "scripts/bench/out"),
    content: "none",
    masks: "sam",
    limit: 0,
    twinSides: "both",
    cuts: false,
    strategy: "all",
    twinLoops: true,
    trials: 5,
    scale: "auto",
    match: {},
    assemble: {},
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--root") a.root = v;
    else if (k === "--family") a.family = v.split(",");
    else if (k === "--content") a.content = v;
    else if (k === "--masks") a.masks = v as "sam" | "gt";
    else if (k === "--limit") a.limit = Number(v);
    else if (k === "--json") a.json = v;
    else if (k === "--renders") a.renders = v;
    else if (k === "--twin-sides") a.twinSides = v as "one" | "both";
    else if (k === "--scale") a.scale = v === "auto" ? "auto" : Number(v);
    else if (k === "--match") a.match = JSON.parse(v);
    else if (k === "--assemble") a.assemble = JSON.parse(v);
    else if (k === "--strategy") a.strategy = v as "all" | "tree";
    else if (k === "--compare") a.compare = v.split(",").map(Number);
    else if (k === "--trials") a.trials = Number(v);
    else if (k === "--no-twin-loops") {
      a.twinLoops = false;
      continue;
    } else if (k === "--cuts") {
      a.cuts = true;
      continue;
    }
    else continue;
    i++;
  }
  return a;
}

/** Is a candidate join true: same page, and the pose within tolerance of the truth (at b's centroid)? */
function isTrueJoin(gt: GroundTruth, frags: Map<string, Fragment>, a: string, b: string, pose: Pose, px = 4, deg = 1.5): boolean {
  const fa = gt.fragments.find((f) => f.id === a)!;
  const fb = gt.fragments.find((f) => f.id === b)!;
  if (fa.page !== fb.page) return false;
  const tp = trueRelative(gt, a, b)!;
  const c = frags.get(b)!.centroid;
  const [x1, y1] = poseApply(tp, c[0], c[1]);
  const [x2, y2] = poseApply(pose, c[0], c[1]);
  const dth = Math.abs(Math.atan2(Math.sin(tp.theta - pose.theta), Math.cos(tp.theta - pose.theta)));
  return Math.hypot(x1 - x2, y1 - y2) <= px && dth <= (deg * Math.PI) / 180;
}

/** An oracle content check that answers from the ground truth and errs at `rate` (deterministic per case). */
function oracle(gt: GroundTruth, frags: Map<string, Fragment>, cands: Map<string, Candidate>, rate: number, seed: number): ContentCheck {
  const rand = rng(seed);
  return async (req: ContentRequest): Promise<ContentVerdict> => {
    const err = rand() < rate;
    if (req.kind === "pair") {
      const c = cands.get(req.candidate)!;
      const truth = isTrueJoin(gt, frags, c.a, c.b, c.pose, 6, 2);
      return { kind: "pair", id: req.id, same: err ? !truth : truth, confidence: 0.9 };
    }
    const truthIdx = req.candidates.findIndex((id) => {
      const c = cands.get(id)!;
      return isTrueJoin(gt, frags, c.a, c.b, c.pose, 6, 2);
    });
    if (!err) return { kind: "choice", id: req.id, choice: truthIdx >= 0 ? truthIdx : null, confidence: 0.9 };
    const others = req.candidates.map((_, k) => k).filter((k) => k !== truthIdx);
    return { kind: "choice", id: req.id, choice: others.length ? others[Math.floor(rand() * others.length)] : null, confidence: 0.9 };
  };
}

async function loadModule(spec: string): Promise<ContentCheck> {
  const mod = await import(pathToFileURL(path.resolve(spec)).href);
  if (typeof mod.createContentCheck === "function") return await mod.createContentCheck();
  if (typeof mod.default === "function") return mod.default as ContentCheck;
  throw new Error(`${spec} exports neither createContentCheck() nor a default ContentCheck`);
}

type CaseResult = {
  name: string;
  family: string;
  fragments: number;
  placed: number;
  correct: number;
  /** Assembled consistently with the truth, but in a group separate from the page's main one. */
  split: number;
  misplaced: number;
  unplaced: number;
  pages: number;
  perfectPages: number;
  /** Rebuilt pages (each true page's best one) that stand upright: their rotation within ±10° of the truth. */
  pagesUpright: number;
  pagesScored: number;
  gtPages: number;
  joinsAccepted: number;
  joinsCorrect: number;
  gtJoins: number;
  twinSeams: number;
  twinSeamsDetected: number;
  twinGroups: number;
  /** Twin groups where pixel appearance alone (ink continuing, paper tone) ranks the true twin first. */
  twinAppearanceHits: number;
  twinAppearanceGroups: number;
  contentAsked: number;
  ms: { analyse: number; match: number; assemble: number; total: number };
};

/** Score a result against the ground truth. */
function score(c: BenchCase, frags: Map<string, Fragment>, res: SolveResult): Omit<CaseResult, "contentAsked" | "ms"> {
  const gt = c.gt;
  const gtOf = new Map(gt.fragments.map((f) => [f.id, f] as const));
  const pageOfPred = new Map<string, string>();
  for (const p of res.pages) for (const f of p.fragments) pageOfPred.set(f.id, p.id);
  const correct = new Set<string>();
  const consistent = new Set<string>();
  let perfect = 0;
  let pagesUpright = 0;
  let pagesScored = 0;
  for (let g = 0; g < gt.pages.length; g++) {
    const gtIds = gt.fragments.filter((f) => f.page === g && frags.has(f.id)).map((f) => f.id);
    let bestCorrect: string[] = [];
    let bestPage: SolveResult["pages"][number] | null = null;
    for (const p of res.pages) {
      const mine = p.fragments.filter((f) => gtOf.get(f.id)!.page === g);
      // a predicted page belongs to the true page holding a strict majority of its pieces; pieces of any other page
      // in it are misplaced, and a placement needs at least two pieces consistent with the truth
      if (2 * mine.length <= p.fragments.length) continue;
      const ok = alignedFragments(mine, gtOf, frags);
      if (ok.length < 2) continue;
      // a group of this page's pieces consistent with the truth, in a predicted page that holds nothing else
      if (mine.length === p.fragments.length) for (const id of ok) consistent.add(id);
      if (ok.length > bestCorrect.length) {
        bestCorrect = ok;
        bestPage = p;
      }
    }
    for (const id of bestCorrect) correct.add(id);
    if (bestPage && bestCorrect.length === gtIds.length && bestPage.fragments.length === gtIds.length) perfect++;
    // upright: "placed correctly" forgives one rigid move per page, a half turn included; the reader does not
    if (bestPage && bestCorrect.length >= 2) {
      pagesScored++;
      let sx = 0;
      let sy = 0;
      for (const id of bestCorrect) {
        const pred = bestPage.fragments.find((f) => f.id === id)!.pose.theta;
        const e = -gtOf.get(id)!.pose.theta - pred;
        sx += Math.cos(e);
        sy += Math.sin(e);
      }
      if (Math.abs(Math.atan2(sy, sx)) <= (10 * Math.PI) / 180) pagesUpright++;
    }
  }
  const placed = res.pages.reduce((s, p) => s + p.fragments.length, 0);
  const split = [...consistent].filter((id) => !correct.has(id)).length;
  let joinsCorrect = 0;
  for (const j of res.joins) if (isTrueJoin(gt, frags, j.a, j.b, j.pose)) joinsCorrect++;
  // twin seams: true joins of stacked pages; detected when a twin group holds the true candidate
  let twinSeams = 0;
  let detected = 0;
  if (gt.kind === "stack") {
    const cands = new Map(res.candidates.map((x) => [x.id, x] as const));
    for (const j of gt.joins) {
      const a = gt.fragments[j.a].id;
      const b = gt.fragments[j.b].id;
      twinSeams++;
      const hit = res.twinGroups.some((tg) =>
        tg.candidates.some((id) => {
          const x = cands.get(id)!;
          return ((x.a === a && x.b === b) || (x.a === b && x.b === a)) && isTrueJoin(gt, frags, x.a, x.b, x.pose, 6, 2);
        }),
      );
      if (hit) detected++;
    }
  }
  // can pixel appearance alone pick the true twin? (the baseline the reading clue has to beat)
  let appHits = 0;
  let appGroups = 0;
  if (gt.kind === "stack") {
    const cands = new Map(res.candidates.map((x) => [x.id, x] as const));
    for (const tg of res.twinGroups) {
      const members = tg.candidates.map((id) => cands.get(id)!).filter((x) => x.appearance?.ink !== null && x.appearance !== null);
      const truth = members.filter((x) => isTrueJoin(gt, frags, x.a, x.b, x.pose, 6, 2));
      if (members.length < 2 || truth.length !== 1) continue;
      appGroups++;
      const best = members.reduce((p, q) => (q.appearance!.score > p.appearance!.score ? q : p));
      if (best === truth[0]) appHits++;
    }
  }
  return {
    twinAppearanceHits: appHits,
    twinAppearanceGroups: appGroups,
    name: c.name,
    family: gt.family,
    fragments: c.inputs.length,
    placed,
    correct: correct.size,
    split,
    misplaced: placed - correct.size - split,
    unplaced: c.inputs.length - placed,
    pages: res.pages.length,
    perfectPages: perfect,
    pagesUpright,
    pagesScored,
    gtPages: gt.pages.length,
    joinsAccepted: res.joins.length,
    joinsCorrect,
    gtJoins: gt.joins.length,
    twinSeams,
    twinSeamsDetected: detected,
    twinGroups: res.twinGroups.length,
  };
}

/** The largest set of a predicted page's fragments consistent with the truth under one rigid transform. */
function alignedFragments(mine: { id: string; pose: Pose }[], gtOf: Map<string, GroundTruth["fragments"][number]>, frags: Map<string, Fragment>): string[] {
  // photo → true page is the inverse of the generator's pose (page → photo)
  const truth = new Map(mine.map((m) => [m.id, poseInvert(gtOf.get(m.id)!.pose)] as const));
  const check = (G: Pose) =>
    mine.filter((m) => {
      const c = frags.get(m.id)!.centroid;
      const pred = poseCompose(G, m.pose);
      const tr = truth.get(m.id)!;
      const [x1, y1] = poseApply(pred, c[0], c[1]);
      const [x2, y2] = poseApply(tr, c[0], c[1]);
      const dth = Math.abs(Math.atan2(Math.sin(pred.theta - tr.theta), Math.cos(pred.theta - tr.theta)));
      return Math.hypot(x1 - x2, y1 - y2) <= 3 && dth <= Math.PI / 180;
    });
  let best: typeof mine = [];
  for (const k of mine) {
    const G = poseCompose(truth.get(k.id)!, poseInvert(k.pose));
    let ok = check(G);
    if (ok.length >= 2) {
      // refine the page transform on the inliers' outlines, then recount
      const a: number[] = [];
      const b: number[] = [];
      for (const m of ok) {
        const f = frags.get(m.id)!;
        const tr = truth.get(m.id)!;
        for (let i = 0; i < f.outline.length; i += 40) {
          const p = poseApply(m.pose, f.outline[i], f.outline[i + 1]);
          const q = poseApply(tr, f.outline[i], f.outline[i + 1]);
          a.push(p[0], p[1]);
          b.push(q[0], q[1]);
        }
      }
      const fit = fitRigid(Float64Array.from(a), Float64Array.from(b));
      const ok2 = check(fit.pose);
      if (ok2.length >= ok.length) ok = ok2;
    }
    if (ok.length > best.length) best = ok;
  }
  return best.map((m) => m.id);
}

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");

/** Strategies × oracle error rates × seeds, on geometry prepared once per case. */
async function compare(args: Args) {
  const all = listCases(args.root);
  const fams = args.family ?? [...new Set(all.map((d) => d.replace(/-\d+$/, "")))].filter((f) => !f.startsWith("dev"));
  type Acc = { frags: number; correct: number; split: number; misplaced: number; unplaced: number; perfect: number; pages: number; reads: number[]; joinsOk: number; joins: number };
  const acc = new Map<string, Acc>();
  for (const fam of fams) {
    for (const name of listCases(args.root, [fam]).slice(0, args.limit || undefined)) {
      const c = loadCase(path.join(args.root, name), args.masks);
      const base = prepare(c.inputs, { twinSides: args.twinSides, match: { cuts: args.cuts, ...args.match }, assemble: { twinLoops: args.twinLoops, ...args.assemble }, scale: args.scale });
      // the truth and the result are in photo px; the solver works at base.scale
      const k = base.scale;
      const shapes = new Map(
        base.fragments.map((f) => [f.id, k === 1 ? f : ({ ...f, centroid: [f.centroid[0] / k, f.centroid[1] / k], outline: f.outline.map((v) => v / k) } as Fragment)] as const),
      );
      const cands = new Map(base.match.candidates.map((x) => [x.id, photoCandidate(x, k)] as const));
      for (const strategy of ["all", "tree"] as const) {
        const prep = { ...base, options: { ...base.options, twinStrategy: strategy } };
        for (const rate of args.compare!) {
          for (let t = 0; t < args.trials; t++) {
            const check = oracle(c.gt, shapes, cands, rate, c.gt.seed + 7919 * t);
            const { reqs, verdicts } = await askPlanned(prep, check, 8);
            const res = finish(prep, reqs, verdicts);
            const s = score(c, shapes, res);
            const key = `${strategy} ${rate}`;
            const a = acc.get(key) ?? { frags: 0, correct: 0, split: 0, misplaced: 0, unplaced: 0, perfect: 0, pages: 0, reads: [], joinsOk: 0, joins: 0 };
            a.frags += s.fragments;
            a.correct += s.correct;
            a.split += s.split;
            a.misplaced += s.misplaced;
            a.unplaced += s.unplaced;
            a.perfect += s.perfectPages;
            a.pages += s.gtPages;
            a.joinsOk += s.joinsCorrect;
            a.joins += s.joinsAccepted;
            a.reads.push(reqs.length);
            acc.set(key, a);
          }
        }
      }
      process.stdout.write(`${name} `);
    }
  }
  console.log(`

| Strategy | Oracle error | Runs | Placed correctly | Split off | Mis-placed | Unplaced | Join precision | Perfect pages | Reads median (mean, max) |`);
  console.log("|---|---|---|---|---|---|---|---|---|---|");
  for (const [key, a] of acc) {
    const [strategy, rate] = key.split(" ");
    const r = [...a.reads].sort((x, y) => x - y);
    const mean = r.reduce((x, y) => x + y, 0) / r.length;
    console.log(`| ${strategy} | ${(100 * Number(rate)).toFixed(0)}% | ${r.length} | ${pct(a.correct, a.frags)} | ${a.split} | ${a.misplaced} | ${a.unplaced} | ${pct(a.joinsOk, a.joins)} | ${a.perfect}/${a.pages} | ${r[Math.floor(r.length / 2)]} (${mean.toFixed(1)}, ${r[r.length - 1]}) |`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.compare) return compare(args);
  const all = listCases(args.root);
  const fams = args.family ?? [...new Set(all.map((d) => d.replace(/-\d+$/, "")))].filter((f) => !f.startsWith("dev"));
  const external = args.content.startsWith("module:") ? await loadModule(args.content.slice(7)) : null;
  const results: CaseResult[] = [];
  for (const fam of fams) {
    const names = listCases(args.root, [fam]).slice(0, args.limit || undefined);
    for (const name of names) {
      const c = loadCase(path.join(args.root, name), args.masks);
      const t0 = performance.now();
      // TRACE_COMPLETE=1: print each placement the second chance weighs (seams marked against the truth)
      let shapesForTrace: Map<string, Fragment> | null = null;
      let kForTrace = 1;
      const traceComplete = process.env.TRACE_COMPLETE
        ? (p: Placement, margin: number, accepted: boolean) => {
            const marks = p.seams.map((sm) => {
              const rel = { theta: sm.rel.theta, tx: sm.rel.tx / kForTrace, ty: sm.rel.ty / kForTrace };
              const t = trueRelative(c.gt, sm.with, p.unit);
              let err = "not adjacent";
              if (t && shapesForTrace) {
                const [cx, cy] = shapesForTrace.get(p.unit)!.centroid;
                const [x1, y1] = poseApply(t, cx, cy);
                const [x2, y2] = poseApply(rel, cx, cy);
                err = `${Math.hypot(x1 - x2, y1 - y2).toFixed(0)}px/${((Math.abs(Math.atan2(Math.sin(t.theta - rel.theta), Math.cos(t.theta - rel.theta))) * 180) / Math.PI).toFixed(1)}°`;
              }
              return `${sm.with}:${sm.score.toFixed(0)} c${sm.conditioning.toFixed(2)} f${sm.fineRms.toFixed(2)}(${err})`;
            });
            console.log(`  ${name} ${accepted ? "ACCEPT" : "reject"} ${p.unit} support ${p.support.toFixed(0)} margin ${margin.toFixed(2)} ${marks.join(" ")}`);
          }
        : undefined;
      const prep = prepare(c.inputs, {
        twinSides: args.twinSides,
        twinStrategy: args.strategy,
        match: { cuts: args.cuts, ...args.match },
        assemble: { twinLoops: args.twinLoops, ...args.assemble, ...(traceComplete ? { traceComplete } : {}) },
        scale: args.scale,
      });
      // the solver works at prep.scale; the truth and the result are in photo px
      const k = prep.scale;
      kForTrace = k;
      const shapes = new Map(
        prep.fragments.map((f) => [f.id, k === 1 ? f : ({ ...f, centroid: [f.centroid[0] / k, f.centroid[1] / k], outline: f.outline.map((v) => v / k) } as Fragment)] as const),
      );
      shapesForTrace = shapes;
      let reqs: ContentRequest[] = [];
      let verdicts: (ContentVerdict | null)[] = [];
      if (args.content !== "none") {
        const cands = new Map(prep.match.candidates.map((x) => [x.id, photoCandidate(x, k)] as const));
        const check = external ?? oracle(c.gt, shapes, cands, Number(args.content.split(":")[1] ?? 0.1), c.gt.seed);
        ({ reqs, verdicts } = await askPlanned(prep, check, 8));
        if (args.renders && !results.length) {
          mkdirSync(args.renders, { recursive: true });
          reqs.slice(0, 12).forEach((r, k) => writeFileSync(path.join(args.renders!, `${name}-${k}-${r.kind}.png`), encodePng(r.render())));
        }
      }
      const res = finish(prep, reqs, verdicts);
      const total = performance.now() - t0;
      const s = score(c, shapes, res);
      const row: CaseResult = {
        ...s,
        contentAsked: reqs.length,
        ms: { analyse: res.timings.analyse, match: res.timings.match, assemble: res.timings.assemble, total: total - (res.timings.content ?? 0) },
      };
      results.push(row);
      console.log(
        `${name.padEnd(12)} frags ${String(row.fragments).padStart(3)}  correct ${String(row.correct).padStart(3)}  split ${row.split}  misplaced ${row.misplaced}  unplaced ${row.unplaced}  ` +
          `pages ${row.pages}/${row.gtPages} perfect ${row.perfectPages} upright ${row.pagesUpright}/${row.pagesScored}  joins ${row.joinsCorrect}/${row.joinsAccepted} of ${row.gtJoins}  ` +
          (row.twinSeams ? `twins ${row.twinSeamsDetected}/${row.twinSeams} groups ${row.twinGroups} appearance-picks ${row.twinAppearanceHits}/${row.twinAppearanceGroups}  ` : "") +
          (reqs.length ? `asked ${reqs.length}  ` : "") +
          `${row.ms.total.toFixed(0)} ms` +
          (k !== 1 ? `  scale ${k.toFixed(2)}` : ""),
      );
    }
  }
  // summary table per family
  console.log("\n| Family | Cases | Fragments | Placed correctly | Split off | Mis-placed | Unplaced | Join precision | Join recall | Perfect pages | Pages upright | Twin seams detected | Runtime median (max) |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const fam of fams) {
    const r = results.filter((x) => x.family === fam);
    if (!r.length) continue;
    const sum = (k: keyof CaseResult) => r.reduce((s, x) => s + (x[k] as number), 0);
    const ms = r.map((x) => x.ms.total).sort((a, b) => a - b);
    console.log(
      `| ${fam} | ${r.length} | ${sum("fragments")} | ${pct(sum("correct"), sum("fragments"))} | ${sum("split")} | ${sum("misplaced")} | ${sum("unplaced")} | ${pct(sum("joinsCorrect"), sum("joinsAccepted"))} | ` +
        `${pct(sum("joinsCorrect"), sum("gtJoins"))} | ${sum("perfectPages")}/${sum("gtPages")} | ${sum("pagesUpright")}/${sum("pagesScored")} | ${sum("twinSeams") ? pct(sum("twinSeamsDetected"), sum("twinSeams")) : "–"} | ` +
        `${(ms[Math.floor(ms.length / 2)] / 1000).toFixed(2)} s (${(ms[ms.length - 1] / 1000).toFixed(2)} s) |`,
    );
  }
  if (args.json) writeFileSync(args.json, JSON.stringify({ args, results }, null, 1));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
