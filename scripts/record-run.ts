// Record a real run of the pipeline on a sample photo, for the first screen's replay (and as a test fixture).
//
//   pnpm tsx scripts/record-run.ts [sample=chouteau-1903] [--photo FILE] [--out DIR] [--events FILE]
//                                  [--strategy all|tree] [--sheet stacked|joined] [--window WxH] [--read-deadline MS] [--concurrency N]
//                                  [--seam-prompt v2|v3] [--lines-floor N|off]
//
// Runs the same pipeline as POST /api/runs with the real models (about $0.10 for a 10-piece page), and writes DIR
// (default public/samples/<sample>/) with photo.jpg, page-N.png and result.json; asset URLs point at /samples/<sample>/.
// --events also saves the raw NDJSON event stream with its timing. Prints stage timings, joins and cost.
// --strategy, --read-deadline and --concurrency override the live defaults (a stack recording may read for longer).
// scripts/sample-assets.ts then sizes the images for the web; scripts/score-sample.ts scores the run.

import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { loadEnv } from "./lib/env";
import { liveDeps } from "../src/lib/server/live";
import { runPipeline } from "../src/lib/server/pipeline";
import { normalisePhoto } from "../src/lib/server/intake";
import { SAMPLES } from "../src/lib/run/samples";
import type { RunEvent } from "../src/lib/run/types";

async function main() {
  loadEnv();
  const argv = process.argv.slice(2);
  const opt = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const name = argv[0] && !argv[0].startsWith("--") ? argv[0] : "chouteau-1903";
  const sample = SAMPLES[name];
  const photoFile = opt("--photo") ?? sample?.file;
  if (!photoFile) throw new Error(`unknown sample ${name}; pass --photo`);
  const out = opt("--out") ?? path.join("public/samples", name);
  const urlBase = out.replace(/\\/g, "/").startsWith("public/") ? "/" + out.replace(/\\/g, "/").slice("public/".length) : null;
  mkdirSync(out, { recursive: true });
  const eventsFile = opt("--events");
  if (eventsFile) writeFileSync(eventsFile, "");

  const putAsset = async (file: string, bytes: Uint8Array) => {
    writeFileSync(path.join(out, file), bytes);
    return urlBase ? `${urlBase}/${file}` : file;
  };
  const deps = liveDeps(putAsset);
  const runId = `rec-${name}-${randomBytes(3).toString("hex")}`;
  const t0 = Date.now();
  const log = (e: RunEvent) => {
    if (eventsFile) appendFileSync(eventsFile, JSON.stringify(e) + "\n");
    const t = ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
    if (e.type === "stage") console.log(`${t}s  ${e.stage} ${e.status}${e.ms !== undefined ? ` (${e.ms} ms)` : ""}`);
    else if (e.type === "segment") console.log(`${t}s  ${e.pieces.length} pieces`);
    else if (e.type === "match") console.log(`${t}s  ${e.candidates.length} candidates, ${e.asks.length} questions`);
    else if (e.type === "read") console.log(`${t}s  read ${e.read.id} ${e.read.ok ? (e.read.kind === "pair" ? `same=${e.read.same}` : `choice=${e.read.choice}`) : `FAILED ${e.read.error}`} ${e.read.confidence} ${JSON.stringify(e.read.words)} (${e.read.ms} ms)`);
    else if (e.type === "assemble") console.log(`${t}s  ${e.pages.length} pages (${e.pages.map((p) => p.pieces.length).join(", ")} pieces), ${e.joins.length} joins, ${e.unplaced.length} unplaced`);
    else if (e.type === "transcribe") console.log(`${t}s  transcript ${e.transcript.page}: ${e.transcript.ok ? e.transcript.text.slice(0, 80).replace(/\n/g, " ") : e.transcript.error}`);
    else if (e.type === "warning") console.log(`${t}s  warning ${e.warning.code}`);
  };
  const strategy = opt("--strategy");
  if (strategy && strategy !== "all" && strategy !== "tree") throw new Error("--strategy all|tree");
  // as the upload route does: sniff, cap and normalise (HEIC → JPEG) before the pipeline
  const tIntake = Date.now();
  const photo = await normalisePhoto(new Uint8Array(readFileSync(photoFile)));
  console.log(`intake ${photo.kind} ${photo.width}×${photo.height} in ${Date.now() - tIntake} ms`);
  const result = await runPipeline(
    photo.bytes,
    deps,
    {
      runId,
      source: "sample",
      sample: name,
      caption: sample?.caption,
      twinStrategy: strategy as "all" | "tree" | undefined,
      choiceSheet: opt("--sheet") as "stacked" | "joined" | undefined,
      sheetWindow: opt("--window") ? (opt("--window")!.split("x").map(Number) as [number, number]) : undefined,
      readDeadlineMs: opt("--read-deadline") ? Number(opt("--read-deadline")) : undefined,
      concurrency: opt("--concurrency") ? Number(opt("--concurrency")) : undefined,
      seamPrompt: opt("--seam-prompt") as "v2" | "v3" | undefined,
      minLinesLogLR: opt("--lines-floor") === "off" ? -Infinity : opt("--lines-floor") ? Number(opt("--lines-floor")) : undefined,
    },
    log,
  );
  console.log(
    JSON.stringify({
      runId,
      totalMs: result.timings.total,
      timings: result.timings,
      pieces: result.pieces.length,
      pages: result.pages.map((p) => p.pieces.length),
      joins: result.joins.map((j) => `${j.a}-${j.b}:${j.decidedBy}${j.read ? (j.read.agrees ? "+read" : "-read") : ""}`),
      unplaced: result.unplaced,
      cost: result.cost,
      stats: result.stats,
      out,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
