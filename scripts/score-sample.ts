// Score any recorded run (a stored RunResult) against its tear's ground truth.
//
//   pnpm tsx scripts/score-sample.ts <result.json> <gt.json | key.json> [--text ref-page0.txt,ref-page1.txt,…] [--json out.json]
//
// gt.json is the tear generator's truth (scripts/gen/tear.py); key.json is an answer key (data/samples/*/key.json).
// --text gives the reference transcript of each true page (in page order) for the character error rate.
// Prints a table and exits 0; the numbers are what the sample's report quotes.

import { readFileSync, writeFileSync } from "node:fs";
import { answerKeyFromTruth, cer, scoreDetailed, scoreRun, type AnswerKey, type TearTruth } from "../src/lib/server/accuracy";
import type { RunResult } from "../src/lib/run/types";

const argv = process.argv.slice(2);
const opt = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const [resultFile, truthFile] = argv;
if (!resultFile || !truthFile) throw new Error("usage: score-sample.ts <result.json> <gt.json|key.json> [--text a.txt,b.txt] [--json out.json]");
const result = JSON.parse(readFileSync(resultFile, "utf8")) as RunResult;
const raw = JSON.parse(readFileSync(truthFile, "utf8")) as TearTruth | AnswerKey;
const truth = "page_size" in raw ? (raw as TearTruth) : undefined;
const key = truth ? answerKeyFromTruth(truth) : (raw as AnswerKey);
const s = scoreDetailed(result, key, truth);
const legacy = scoreRun(result, key);

const refs = (opt("--text") ?? "").split(",").filter(Boolean).map((f) => readFileSync(f, "utf8"));
const transcripts = result.transcripts.map((t) => {
  const page = s.pageMap[t.page] ?? null;
  const ref = page !== null ? refs[page] : undefined;
  return { page: t.page, truePage: page, ok: t.ok, chars: t.text.length, cer: ref !== undefined && t.ok ? Math.round(cer(t.text, ref) * 1000) / 1000 : null };
});

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");
console.log(`run ${result.runId}  (${result.sample ?? result.source})  ${(result.timings.total / 1000).toFixed(1)} s  $${result.cost.usd.toFixed(3)}  SAM ${result.cost.samCalls}  Muse ${result.cost.museCalls}`);
console.log(`pieces: ${s.pieces.found} found, ${s.pieces.matched}/${s.pieces.truth} matched to the truth, ${s.pieces.duplicates} duplicates`);
for (const p of s.pages) console.log(`true page ${p.page}: ${p.placedCorrectly}/${p.pieces} placed correctly${p.splitOff ? `, ${p.splitOff} split off` : ""}`);
console.log(`placed correctly ${s.placedCorrectly}/${s.pieces.truth} (${pct(s.placedCorrectly, s.pieces.truth)}), split off ${s.splitOff}, misplaced ${s.misplaced.length}, unplaced ${s.unplaced}`);
for (const m of s.misplaced) console.log(`  misplaced ${m.id} (true page ${m.truePage}) on ${m.resultPage}`);
console.log(`joins right ${s.joins.correct}/${s.joins.total}  ${Object.entries(s.joins.byClue).map(([k, v]) => `${k} ${v.correct}/${v.total}`).join(", ")}`);
console.log(`reads ${s.reads.total} (pair ${s.reads.pair}, k-way ${s.reads.choice}), failed ${s.reads.failed}, decisive ${s.reads.decisive}, right ${s.reads.correct}/${s.reads.judged} judged`);
if (result.stats) console.log(`strategy ${result.stats.twinStrategy}, ${result.stats.readRounds} rounds, ${result.stats.twinGroups} twin groups in ${result.stats.twinClasses} classes`);
for (const t of transcripts) console.log(`transcript ${t.page} → true page ${t.truePage}: ${t.ok ? `${t.chars} chars` : "failed"}${t.cer !== null ? `, CER ${(100 * t.cer).toFixed(1)}%` : ""}`);
console.log(`stages ${Object.entries(result.timings).map(([k, v]) => `${k} ${((v ?? 0) / 1000).toFixed(1)} s`).join(", ")}`);
if (opt("--json")) writeFileSync(opt("--json")!, JSON.stringify({ ...s, legacy, transcripts, cost: result.cost, timings: result.timings, stats: result.stats ?? null }, null, 1));
