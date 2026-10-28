// ShredBench, end to end: SAM 3.1 finds the pieces, the straight-edge solver and Muse put them back together, Muse
// reads the rebuilt page, and ShredBench's own NED scores the text. docs/SHREDBENCH.md has the method and the numbers.
//
//   pnpm tsx scripts/eval/shredbench.ts <stage> [options]
//
// Stages (each caches its output, so a rerun only does what is missing):
//   segment    segmentFragments (SAM 3.1) on every image          → <root>/segments/<key>.json
//
// Options:
//   --root DIR          data and runs (default scripts/bench/shredbench/out, or $SHREDBENCH_ROOT)
//   --set official|replica, --pieces 8,12,16, --domains news_en,code, --split dev|test|all, --only <substr,…>,
//   --limit N, --concurrency N

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { segmentFragments } from "../../src/lib/server/segment";
import { loadEnv } from "../lib/env";
import { argValue, DEFAULT_ROOT } from "./shredbench/args";
import { Ledger } from "./shredbench/ledger";
import { selectSamples, type Sample } from "./shredbench/samples";

const argv = process.argv.slice(2);
const stage = argv[0];
const root = argValue("--root") ?? DEFAULT_ROOT;
const list = (k: string) => argValue(k)?.split(",").filter(Boolean);
const concurrency = Number(argValue("--concurrency") ?? 3);

const segFile = (s: Sample) => path.join(root, "segments", `${s.key}.json`);

async function mapLimit<T>(items: T[], limit: number, fn: (x: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

async function segmentStage(samples: Sample[], ledger: Ledger) {
  await mapLimit(samples, concurrency, async (s) => {
    const out = segFile(s);
    if (existsSync(out)) return;
    const r = await segmentFragments(new Uint8Array(readFileSync(s.image)), { variant: "auto" });
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(
      out,
      JSON.stringify({
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
      }),
    );
    ledger.add({ stage: "segment", sample: s.key, fn: "segmentFragments", cost: r.costUsd, ms: r.timings.totalMs, sam: r.samCalls });
    console.log(`${s.key}: ${r.fragments.length}/${s.pieces} pieces, ${r.timings.totalMs} ms, ${r.samCalls} SAM call(s)${r.warnings.length ? `; ${r.warnings.join(" | ")}` : ""}`);
  });
}

async function main() {
  const samples = selectSamples(root, {
    set: argValue("--set"),
    pieces: list("--pieces")?.map(Number),
    domains: list("--domains"),
    split: argValue("--split") ?? "all",
    only: list("--only"),
    limit: argValue("--limit") ? Number(argValue("--limit")) : undefined,
  });
  if (!samples.length) throw new Error(`no samples under ${root} (run scripts/bench/shredbench/fetch.ts first)`);
  const ledger = new Ledger(root);
  if (stage === "segment") {
    loadEnv();
    await segmentStage(samples, ledger);
  } else {
    throw new Error(`unknown stage "${stage}"`);
  }
  console.log(`spent so far: $${ledger.total.toFixed(4)} (${ledger.file})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
