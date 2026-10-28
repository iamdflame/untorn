// Reading bench: accuracy, empty-output rate and latency of verifySeam / chooseContinuation through the Muse client.
// Usage: pnpm tsx scripts/bench/reading-bench.mts <set> <binary|kway> [model=muse-spark-1.3] [effort] [prompt] [orient] [concurrency=4]
//   set:    cw1 / cw3 (the spike's own items) or a folder under <OUT_ROOT>/reading made by scripts/gen/seams.py
//   prompt: seam v1|v2|flush, choice v1|v2|joined (default: the function's default)
//   orient: up (as generated) | both (upright + a 180° copy) | flipped (the image turned 180°, plus the upright copy)
//           | down (turned 180°, nothing else)
// Writes <OUT_ROOT>/reading/results/<tag>.json and appends the spend to the ledger.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rotate180Jpeg } from "../../src/lib/server/images";
import { chooseContinuation, verifySeam, type AttemptLog, type MuseModel, type ReasoningEffort } from "../../src/lib/server/muse";
import { mapLimit } from "../../src/lib/server/segment";
import type { ChoicePromptVersion, SeamPromptVersion } from "../../src/lib/server/prompts";
import { ledger, loadEnv, median, OUT_ROOT, quantile, SPIKES, writeJson } from "../lib/env";

loadEnv();
const [set, fn, modelArg, effortArg, promptArg, orientArg, concArg] = process.argv.slice(2);
if (!set || (fn !== "binary" && fn !== "kway")) throw new Error("usage: reading-bench.mts <set> <binary|kway> [model] [effort] [prompt] [orient] [concurrency]");
const model = (modelArg || "muse-spark-1.3") as MuseModel;
const effort = (effortArg || undefined) as ReasoningEffort | undefined;
const prompt = promptArg || undefined;
const orient = (orientArg || "up") as "up" | "both" | "flipped" | "down";
const concurrency = Number(concArg || 4);

const dir = set === "cw1" || set === "cw3" ? join(SPIKES, set) : join(OUT_ROOT, "reading", set);
type Item = { file: string; truth: string };
const only = process.env.ONLY?.split(",").filter(Boolean);
const allItems: Item[] = existsSync(join(dir, "manifest.json"))
  ? JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).items
  : readdirSync(dir)
      .filter((f) => f.endsWith(".jpg"))
      .sort()
      .map((file) => ({ file, truth: /-(true|false)\.jpg$/.exec(file)?.[1] ?? /truth-([A-Z])\.jpg$/.exec(file)![1] }));
const items = only ? allItems.filter((it) => only.some((o) => it.file.startsWith(o))) : allItems;
const k = fn === "kway" ? 3 : 2;

const tag = [set, fn, model, effort ?? "default", prompt ?? "default", orient].join("_") + (only ? `_only-${process.env.ONLY_TAG ?? "subset"}` : "");
console.log(`${tag}: ${items.length} items`);
const rows = await mapLimit(items, concurrency, async (it) => {
  const raw = new Uint8Array(readFileSync(join(dir, it.file)));
  const turned = orient === "up" ? null : await rotate180Jpeg(raw);
  const main = orient === "flipped" || orient === "down" ? turned! : raw;
  const second = orient === "both" ? turned! : orient === "flipped" ? raw : null;
  const attempts: AttemptLog[] = [];
  const opts = {
    model,
    ...(effort ? { effort } : {}),
    ...(second ? { rotated: { data: second, mime: "image/jpeg" as const } } : {}),
    onLog: (e: AttemptLog) => attempts.push(e),
  };
  const img = { data: main, mime: "image/jpeg" as const };
  const r =
    fn === "binary"
      ? await verifySeam(img, { ...opts, ...(prompt ? { prompt: prompt as SeamPromptVersion } : {}) })
      : await chooseContinuation(img, k, { ...opts, ...(prompt ? { prompt: prompt as ChoicePromptVersion } : {}) });
  const answer = !r.ok ? null : fn === "binary" ? String((r.value as { same_place: boolean }).same_place) : (r.value as { choice: string }).choice;
  const row = {
    file: it.file,
    truth: it.truth,
    answer,
    correct: answer === null ? null : answer === it.truth,
    confidence: r.ok ? r.value.confidence : null,
    words: r.ok ? r.value.words_across : null,
    reason: r.ok ? r.value.reason : null,
    error: r.ok ? null : `${r.error.code}: ${r.error.message}`,
    ms: r.meta.ms,
    attempts: r.meta.attempts,
    lanes: r.meta.lanes,
    attemptErrors: attempts.filter((a) => a.error).map((a) => a.error),
    attemptMessages: attempts.filter((a) => a.error).map((a) => `${a.error} ${a.ms}ms ${a.message ?? ""}`.slice(0, 140)),
    tokens: r.meta.usage,
    cost: r.meta.costUsd,
  };
  console.log(`  ${it.file} truth ${it.truth} → ${answer ?? row.error} ${row.correct === null ? "" : row.correct ? "OK" : "WRONG"} ${(row.ms / 1000).toFixed(1)}s`);
  return row;
});

const answered = rows.filter((r) => r.correct !== null);
const allAttempts = rows.flatMap((r) => Array.from({ length: r.attempts }, (_, i) => r.attemptErrors[i] ?? "ok"));
const emptyish = allAttempts.filter((e) => e === "empty" || e === "incomplete" || e === "unparseable").length;
const ms = rows.map((r) => r.ms);
const summary = {
  set, fn, model, effort: effort ?? "default", prompt: prompt ?? "default", orient,
  items: rows.length,
  answered: answered.length,
  correct: answered.filter((r) => r.correct).length,
  accuracy: answered.length ? Math.round((answered.filter((r) => r.correct).length / answered.length) * 1000) / 1000 : null,
  ...(fn === "binary"
    ? {
        trueAccepted: answered.filter((r) => r.truth === "true" && r.correct).length + "/" + answered.filter((r) => r.truth === "true").length,
        falseRejected: answered.filter((r) => r.truth === "false" && r.correct).length + "/" + answered.filter((r) => r.truth === "false").length,
      }
    : {}),
  failedCalls: rows.length - answered.length,
  attempts: allAttempts.length,
  emptyOrUnparseableAttempts: emptyish,
  emptyRate: Math.round((emptyish / Math.max(1, allAttempts.length)) * 1000) / 1000,
  networkOrHttpRetries: allAttempts.filter((e) => e !== "ok" && e !== "empty" && e !== "incomplete" && e !== "unparseable").length,
  hedged: rows.filter((r) => r.lanes > 1).length,
  medianMs: Math.round(median(ms)),
  p90Ms: Math.round(quantile(ms, 0.9)),
  maxMs: Math.max(...ms),
  meanOutputTokens: Math.round(rows.reduce((s, r) => s + r.tokens.outputTokens, 0) / rows.length),
  costUsd: Math.round(rows.reduce((s, r) => s + r.cost, 0) * 10000) / 10000,
};
writeJson(join(OUT_ROOT, "reading", "results", `${tag}.json`), { summary, rows });
ledger({ what: `reading ${tag}`, calls: rows.length, cost: summary.costUsd });
console.log(JSON.stringify(summary));
