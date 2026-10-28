// Segmentation bench: run segmentFragments' variants on simulated tear photos with known ground truth.
// Usage: pnpm tsx scripts/bench/segment-bench.mts <photoSet[,photoSet]> <variant[,variant]> [pass1LongSide=1280] [reps=1]
// photo sets: t1 (the spike photo), or a folder name under <OUT_ROOT>/photos (sim12, sim12b, stack30).
// Writes <OUT_ROOT>/segment/<set>-<variant>-<longSide>-r<rep>.json and appends to the spend ledger.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluateMasks } from "../../src/lib/server/mask-eval";
import { segmentFragments, type SegmentVariant } from "../../src/lib/server/segment";
import { ledger, loadEnv, OUT_ROOT, SPIKES, writeJson } from "../lib/env";

loadEnv();
const [setsArg, variantsArg, sideArg, repsArg] = process.argv.slice(2);
const sets = (setsArg ?? "t1").split(",");
const variants = (variantsArg ?? "crops").split(",") as SegmentVariant[];
const longSide = Number(sideArg ?? 1280);
const reps = Number(repsArg ?? 1);
const tile = (process.env.TILE ?? "auto") as "auto" | "always" | "never";
const dirOf = (s: string) => (s === "t1" ? join(SPIKES, "t1") : join(OUT_ROOT, "photos", s));

for (const set of sets) {
  const dir = dirOf(set);
  const photo = readFileSync(join(dir, "photo.jpg"));
  const gt = JSON.parse(readFileSync(join(dir, "gt.json"), "utf8"));
  for (const variant of variants) {
    for (let rep = 1; rep <= reps; rep++) {
      const r = await segmentFragments(photo, { variant, pass1LongSide: longSide, tile });
      const ev = evaluateMasks(gt.pieces, r.fragments.map((f) => f.mask));
      const row = {
        set, variant, longSide, rep,
        size: [r.width, r.height], pieces: gt.pieces.length,
        pass1: r.pass1, found: r.fragments.length, refined: r.fragments.filter((f) => f.refined).length,
        timings: r.timings, samCalls: r.samCalls, costUsd: r.costUsd, warnings: r.warnings,
        callMs: r.calls.map((c) => `${c.stage}:${c.ok ? "ok" : "fail"}:${c.ms}`),
        eval: ev.summary, perPiece: ev.pieces,
        polygonPoints: r.fragments.map((f) => f.polygon.length),
      };
      writeJson(join(OUT_ROOT, "segment", `${set}-${variant}-${longSide}-${tile}-r${rep}.json`), row);
      ledger({ what: `segment ${set} ${variant} ${longSide}`, sam: r.samCalls, cost: r.costUsd });
      const s = ev.summary;
      console.log(
        `${set} ${variant} @${longSide} tile=${tile} (median piece ${r.pass1.medianPieceSide}px) r${rep}: ${r.fragments.length}/${gt.pieces.length} found (pass1 ${r.pass1.count}${r.pass1.tiled ? ` → ${r.pass1.afterTiles} with tiles` : ""}), ` +
          `detected ${s.detected}, missed [${s.missed}], extra [${s.unmatchedMasks}]; IoU ${s.meanIoU}, median boundary ${s.medianBoundaryPx} px ` +
          `(pooled ${s.pooledMedianBoundaryPx}, worst p90 ${s.worstP90BoundaryPx}); total ${r.timings.totalMs} ms ` +
          `(decode ${r.timings.decodeMs}, pass1 ${r.timings.pass1Ms}, tiles ${r.timings.tilesMs}, pass2 ${r.timings.pass2Ms}, outline ${r.timings.outlineMs}); ` +
          `${r.sentToSam} sent to SAM; ${r.samCalls} SAM calls $${r.costUsd.toFixed(4)}${r.warnings.length ? `; warnings: ${r.warnings.join(" | ")}` : ""}`,
      );
    }
  }
}
