// ShredBench, end to end: SAM 3.1 finds the pieces, the straight-edge solver and Muse put them back together, Muse
// reads the rebuilt page, and ShredBench's own NED scores the text. docs/SHREDBENCH.md has the method and the numbers.
//
//   pnpm tsx scripts/eval/shredbench.ts <stage> [options]
//
// Stages (each caches its output under <root>, so a rerun only does what is missing):
//   segment    segmentFragments (SAM 3.1) on every image                      → segments/<key>.json
//   solve      straight-edge solver + Muse seam readings (verifySeam)        → runs/<run>/<key>/solve.json, read.png
//   read       readPage on the rebuilt page (or the sheet of parts)          → runs/<run>/<key>/pred.md
//   baseline   Muse alone on the scattered photo, ShredBench's prompt        → runs/baseline/<key>/pred.md
//   score      NED (their metric), pieces, placement, cost, latency          → runs/<run>/report.json, report.md
//   all        segment, solve, read, score
//
// Options:
//   --root DIR          data and runs (default scripts/bench/shredbench/out, or $SHREDBENCH_ROOT)
//   --run NAME          run name (default main); --budget USD stops new live work past this total spend (default 24)
//   --set official|replica, --pieces 8,12,16, --domains news_en,news_zh,code,table, --split dev|test|all,
//   --only <substr,…>, --every K (every K-th document per domain), --limit N, --concurrency N, --max-reads N (seam readings per sample, default 2N − 2)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { SegmentedFragment } from "../../src/lib/rejoin/adapters";
import { encodePng } from "../../src/lib/rejoin/render";
import type { SeamVerdict } from "../../src/lib/rejoin/tiling";
import type { Rgba } from "../../src/lib/rejoin/types";
import { readPage, verifySeam } from "../../src/lib/server/muse";
import { segmentFragments } from "../../src/lib/server/segment";
import { loadEnv } from "../lib/env";
import { loadPhoto } from "./cases";
import { argValue, DEFAULT_ROOT } from "./shredbench/args";
import { museAlone } from "./shredbench/baseline";
import { Ledger } from "./shredbench/ledger";
import { ned, readText } from "./shredbench/ned";
import { pageImage, partsSheet, rotate180, scaleDown, solveSample, SOLVE_DEFAULTS } from "./shredbench/pipeline";
import { placementScore, type PlacedPage } from "./shredbench/placement";
import { selectSamples, type Sample } from "./shredbench/samples";

const argv = process.argv.slice(2);
const stage = argv[0];
const root = argValue("--root") ?? DEFAULT_ROOT;
const run = argValue("--run") ?? "main";
const budget = Number(argValue("--budget") ?? 24);
const list = (k: string) => argValue(k)?.split(",").filter(Boolean);
const concurrency = Number(argValue("--concurrency") ?? 3);
// seam readings per sample: 2N − 2 by default (14 for 8 pieces), or --max-reads
const maxReadsFor = (pieces: number) => Number(argValue("--max-reads") ?? 2 * pieces - 2);

const segFile = (s: Sample) => path.join(root, "segments", `${s.key}.json`);
const runDir = (s: Sample, r = run) => path.join(root, "runs", r, s.key);
const readJson = <T>(f: string): T => JSON.parse(readFileSync(f, "utf8")) as T;
const writeJson = (f: string, v: unknown) => {
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(v, null, 1));
};

async function mapLimit<T>(items: T[], limit: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          await fn(items[i], i);
        } catch (e) {
          console.error(`sample ${i}: ${(e as Error).stack ?? (e as Error).message}`);
        }
      }
    }),
  );
}

const quiet = { onLog: () => {} };
const overBudget = (ledger: Ledger) => ledger.total >= budget;

// ---------------------------------------------------------------------------------------------------------------

async function segmentStage(samples: Sample[], ledger: Ledger) {
  await mapLimit(samples, concurrency, async (s) => {
    const out = segFile(s);
    if (existsSync(out) || overBudget(ledger)) return;
    const r = await segmentFragments(new Uint8Array(readFileSync(s.image)), { variant: "auto" });
    writeJson(out, {
      image: s.image,
      width: r.width,
      height: r.height,
      fragments: r.fragments.map((f) => ({
        id: `f${f.id}`,
        box: f.box,
        area: f.area,
        confidence: f.confidence,
        method: f.method,
        refined: f.refined,
        snap: f.snap ?? null,
        polygon: f.polygon,
        mask: { ...f.mask, data: Buffer.from(f.mask.data).toString("base64") },
      })),
      pass1: r.pass1,
      timings: r.timings,
      samCalls: r.samCalls,
      costUsd: r.costUsd,
      warnings: r.warnings,
    });
    ledger.add({ stage: "segment", sample: s.key, fn: "segmentFragments", cost: r.costUsd, ms: r.timings.totalMs, sam: r.samCalls });
    console.log(`${s.key}: ${r.fragments.length}/${s.pieces} pieces, ${r.timings.totalMs} ms`);
  });
}

type SegFile = { image: string; width: number; height: number; fragments: { id: string; mask: { x: number; y: number; width: number; height: number; data: string } }[]; timings: { totalMs: number } };

function segmentsOf(s: Sample): SegmentedFragment[] {
  const j = readJson<SegFile>(segFile(s));
  return j.fragments.map((f) => ({ id: f.id, mask: { ...f.mask, data: Buffer.from(f.mask.data, "base64") } }));
}

const png = (img: Rgba) => ({ data: encodePng(img), mime: "image/png" as const });

async function solveStage(samples: Sample[], ledger: Ledger) {
  await mapLimit(samples, concurrency, async (s) => {
    const dir = runDir(s);
    if (existsSync(path.join(dir, "solve.json")) || !existsSync(segFile(s))) return;
    if (overBudget(ledger)) return;
    const known = new Map<string, SeamVerdict>(existsSync(path.join(dir, "verdicts.json")) ? Object.entries(readJson<Record<string, SeamVerdict>>(path.join(dir, "verdicts.json"))) : []);
    const photo = loadPhoto(s.image);
    const t0 = performance.now();
    let readMs = 0;
    const reader = async (seam: Rgba, uprightKnown: boolean, c: { id: string }): Promise<SeamVerdict | null> => {
      if (overBudget(ledger)) return null;
      const out = await verifySeam(png(seam), { ...quiet, rotated: uprightKnown ? undefined : png(rotate180(seam)) });
      ledger.add({ stage: "solve", run, sample: s.key, fn: "verifySeam", cost: out.meta.costUsd, ms: out.meta.ms, ok: out.ok, candidate: c.id });
      readMs = Math.max(readMs, out.meta.ms);
      return out.ok ? { same: out.value.same_place, confidence: out.value.confidence } : null;
    };
    const sol = await solveSample(photo, segmentsOf(s), reader, known, { ...SOLVE_DEFAULTS, maxReads: maxReadsFor(s.pieces) });
    const ms = performance.now() - t0;
    writeJson(path.join(dir, "verdicts.json"), Object.fromEntries(sol.verdicts));
    const n = sol.frags.length;
    const complete = sol.result.pages.length === 1 && sol.result.pages[0].fragments.length === n;
    let flipped = false;
    let margins = null;
    let img: Rgba;
    if (complete) {
      const p = pageImage(sol.result.pages[0], sol.frags, true);
      img = p.img;
      flipped = p.flipped;
      margins = p.margins;
    } else img = partsSheet(sol);
    // what Muse reads: at most 2,000 px wide
    if (img.width > 2000) img = scaleDown(img, 2000 / img.width);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "read.png"), encodePng(img));
    writeJson(path.join(dir, "solve.json"), {
      key: s.key,
      pieces: n,
      complete,
      flipped,
      margins,
      pages: sol.result.pages.map((p) => ({ id: p.id, fragments: p.fragments, width: p.width, height: p.height, upright: p.upright })),
      unplaced: sol.result.unplaced,
      joins: sol.result.joins.map((j) => ({ candidate: j.candidate, a: j.a, b: j.b, decidedBy: j.decidedBy, loop: j.loop })),
      reads: sol.reads,
      candidates: sol.cands.length,
      ms: Math.round(ms),
      readWallMs: Math.round(readMs),
    });
    const placed = Math.max(0, ...sol.result.pages.map((p) => p.fragments.length));
    console.log(`${s.key}: ${complete ? "complete" : `largest ${placed}/${n}, ${sol.result.pages.length} group(s), ${sol.result.unplaced.length} loose`}, ${sol.reads.length} reads, ${(ms / 1000).toFixed(1)} s`);
  });
}

async function readStage(samples: Sample[], ledger: Ledger) {
  await mapLimit(samples, concurrency, async (s) => {
    const dir = runDir(s);
    const out = path.join(dir, "pred.md");
    if (existsSync(out) || !existsSync(path.join(dir, "solve.json")) || overBudget(ledger)) return;
    const solved = readJson<{ complete: boolean; joins: { candidate: string }[]; unplaced: { id: string }[] }>(path.join(dir, "solve.json"));
    // --reuse RUN: when that run rebuilt exactly the same page (same joins, same loose pieces), its reading of the
    // identical image stands (no second call for the same picture)
    const reuse = argValue("--reuse");
    if (reuse) {
      const other = runDir(s, reuse);
      if (existsSync(path.join(other, "solve.json")) && existsSync(path.join(other, "pred.md"))) {
        const o = readJson<typeof solved>(path.join(other, "solve.json"));
        const key = (x: typeof solved) => JSON.stringify([x.joins.map((j) => j.candidate).sort(), x.unplaced.map((u) => u.id).sort()]);
        if (key(o) === key(solved)) {
          writeFileSync(out, readFileSync(path.join(other, "pred.md")));
          if (existsSync(path.join(other, "read.json"))) writeFileSync(path.join(dir, "read.json"), readFileSync(path.join(other, "read.json")));
          console.log(`${s.key}: same page as ${reuse}, its reading reused`);
          return;
        }
      }
    }
    const image = { data: new Uint8Array(readFileSync(path.join(dir, "read.png"))), mime: "image/png" as const, detail: "high" as const };
    const r = await readPage(image, { ...quiet, prompt: solved.complete ? "markdown" : "parts", maxOutputTokens: 12000 });
    ledger.add({ stage: "read", run, sample: s.key, fn: "readPage", cost: r.meta.costUsd, ms: r.meta.ms, ok: r.ok });
    if (!r.ok) {
      console.log(`${s.key}: read failed (${r.error.code})`);
      return;
    }
    writeFileSync(out, r.value.text);
    writeJson(path.join(dir, "read.json"), { ms: r.meta.ms, cost: r.meta.costUsd, usage: r.meta.usage, language: r.value.language, uncertain: r.value.uncertain, prompt: solved.complete ? "markdown" : "parts" });
    console.log(`${s.key}: read ${r.value.text.length} chars, ${(r.meta.ms / 1000).toFixed(1)} s, $${r.meta.costUsd.toFixed(4)}`);
  });
}

async function baselineStage(samples: Sample[], ledger: Ledger) {
  await mapLimit(samples, concurrency, async (s) => {
    const dir = runDir(s, "baseline");
    const out = path.join(dir, "pred.md");
    if (existsSync(out) || overBudget(ledger)) return;
    // their inference script: RGB, long side at most 2,048 px (Lanczos), JPEG quality 95
    const jpeg = await sharp(readFileSync(s.image)).resize(2048, 2048, { fit: "inside", kernel: "lanczos3" }).jpeg({ quality: 95 }).toBuffer();
    const r = await museAlone({ data: new Uint8Array(jpeg), mime: "image/jpeg" }, quiet);
    ledger.add({ stage: "baseline", sample: s.key, fn: "museAlone", cost: r.meta.costUsd, ms: r.meta.ms, ok: r.ok });
    if (!r.ok) {
      console.log(`${s.key}: baseline failed (${r.error.code})`);
      return;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(out, r.value.markdown);
    writeJson(path.join(dir, "read.json"), { ms: r.meta.ms, cost: r.meta.costUsd, usage: r.meta.usage });
    console.log(`${s.key}: baseline ${r.value.markdown.length} chars, ${(r.meta.ms / 1000).toFixed(1)} s`);
  });
}

// ---------------------------------------------------------------------------------------------------------------

type Row = {
  key: string;
  set: string;
  pieces: number;
  domain: string;
  split: string;
  found: number | null;
  placedInLargest: number | null;
  complete: boolean | null;
  placedCorrectly: number | null;
  reads: number | null;
  ned: number | null;
  baselineNed: number | null;
  cost: number;
  latencyMs: number | null;
};

function scoreStage(samples: Sample[], ledger: Ledger) {
  const costs = new Map<string, number>();
  if (existsSync(ledger.file)) {
    for (const line of readFileSync(ledger.file, "utf8").split("\n").filter(Boolean)) {
      const e = JSON.parse(line) as { sample: string; stage: string; cost: number; run?: string };
      // this run's own calls, plus the segmentation it reuses (older entries carry no run: an upper bound)
      if (e.stage === "baseline" || (e.run !== undefined && e.run !== run)) continue;
      costs.set(e.sample, (costs.get(e.sample) ?? 0) + (e.cost || 0));
    }
  }
  const rows: Row[] = samples.map((s) => {
    const dir = runDir(s);
    const solved = existsSync(path.join(dir, "solve.json")) ? readJson<{ pieces: number; complete: boolean; pages: PlacedPage[]; reads: unknown[]; ms: number }>(path.join(dir, "solve.json")) : null;
    const seg = existsSync(segFile(s)) ? readJson<SegFile>(segFile(s)) : null;
    const gt = s.gt && existsSync(s.gt) ? readText(readFileSync(s.gt, "utf8")) : null;
    const pred = existsSync(path.join(dir, "pred.md")) ? readText(readFileSync(path.join(dir, "pred.md"), "utf8")) : null;
    const base = existsSync(path.join(runDir(s, "baseline"), "pred.md")) ? readText(readFileSync(path.join(runDir(s, "baseline"), "pred.md"), "utf8")) : null;
    const reading = existsSync(path.join(dir, "read.json")) ? readJson<{ ms: number }>(path.join(dir, "read.json")) : null;
    const placedCorrectly = solved && s.truth && seg ? placementScore(readJson(s.truth), segmentsOf(s), solved.pages) : null;
    return {
      key: s.key,
      set: s.set,
      pieces: s.pieces,
      domain: s.domain,
      split: s.split,
      found: seg ? seg.fragments.length : null,
      placedInLargest: solved ? Math.max(0, ...solved.pages.map((p) => p.fragments.length)) : null,
      complete: solved ? solved.complete : null,
      placedCorrectly,
      reads: solved ? solved.reads.length : null,
      ned: gt !== null && pred !== null ? ned(pred, gt) : null,
      baselineNed: gt !== null && base !== null ? ned(base, gt) : null,
      cost: costs.get(s.key) ?? 0,
      latencyMs: seg && solved && reading ? seg.timings.totalMs + solved.ms + reading.ms : null,
    };
  });
  writeJson(path.join(root, "runs", run, "report.json"), rows);
  const groups = new Map<string, Row[]>();
  for (const r of rows) for (const k of [`${r.set}|${r.split}|${r.pieces}|${r.domain}`, `${r.set}|${r.split}|${r.pieces}|all`]) groups.set(k, [...(groups.get(k) ?? []), r]);
  const mean = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const fmt = (x: number | null, d = 3) => (x === null ? "–" : x.toFixed(d));
  const lines = ["| set | split | pieces | domain | n | NED Untorn | NED Muse alone | complete pages | placed correctly | reads/sample | $/sample | latency s |", "|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const [k, rs] of [...groups.entries()].sort()) {
    const [set, split, pieces, domain] = k.split("|");
    lines.push(
      `| ${set} | ${split} | ${pieces} | ${domain} | ${rs.length} | ${fmt(mean(rs.map((r) => r.ned)))} | ${fmt(mean(rs.map((r) => r.baselineNed)))} | ${rs.filter((r) => r.complete).length}/${rs.length} | ${fmt(mean(rs.map((r) => (r.placedCorrectly === null ? null : r.placedCorrectly / r.pieces))))} | ${fmt(mean(rs.map((r) => r.reads)), 1)} | ${fmt(mean(rs.map((r) => r.cost)), 4)} | ${fmt(mean(rs.map((r) => (r.latencyMs === null ? null : r.latencyMs / 1000))), 1)} |`,
    );
  }
  writeFileSync(path.join(root, "runs", run, "report.md"), lines.join("\n") + "\n");
  console.log(lines.join("\n"));
}

async function main() {
  if (!["segment", "solve", "read", "baseline", "score", "all"].includes(stage)) throw new Error(`unknown stage "${stage}"`);
  const samples = selectSamples(root, {
    set: argValue("--set"),
    pieces: list("--pieces")?.map(Number),
    domains: list("--domains"),
    split: argValue("--split") ?? "all",
    only: list("--only"),
    limit: argValue("--limit") ? Number(argValue("--limit")) : undefined,
    every: argValue("--every") ? Number(argValue("--every")) : undefined,
  });
  if (!samples.length) throw new Error(`no samples under ${root} (run scripts/bench/shredbench/fetch.ts first)`);
  const ledger = new Ledger(root);
  if (stage !== "score") loadEnv();
  if (stage === "segment" || stage === "all") await segmentStage(samples, ledger);
  if (stage === "solve" || stage === "all") await solveStage(samples, ledger);
  if (stage === "read" || stage === "all") await readStage(samples, ledger);
  if (stage === "baseline") await baselineStage(samples, ledger);
  if (stage === "score" || stage === "all") scoreStage(samples, ledger);
  console.log(`spent so far: $${ledger.total.toFixed(4)} of $${budget} (${ledger.file})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
