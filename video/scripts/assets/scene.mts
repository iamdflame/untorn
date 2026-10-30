// The film's scene data, built by the app's own scene builder (src/lib/run/scene.ts) from a recorded run, so every
// pose, seam, edge trace, read and the order pieces come home in are the product's. Run with the app's tsx:
//   ../node_modules/.bin/tsx scripts/assets/scene.mts fdr-1927  ->  src/data/scene-fdr-1927.json
import fs from "node:fs";
import path from "node:path";
import { buildScene } from "../../../src/lib/run/scene";

const name = process.argv[2] ?? "fdr-1927";
const repo = path.resolve(import.meta.dirname, "../../..");
const lite = JSON.parse(fs.readFileSync(path.join(repo, "public/samples", name, "result-lite.json"), "utf8"));
const scene = buildScene({ photo: { width: lite.photo.width, height: lite.photo.height }, pieces: lite.pieces, pages: lite.pages, joins: lite.joins, reads: lite.reads });

const round = (v: number) => Math.round(v * 100) / 100;
const out = {
  sample: name,
  runId: lite.runId,
  photo: { width: lite.photo.width, height: lite.photo.height },
  pages: scene.pages,
  pagesBox: scene.pagesBox,
  box: scene.box,
  reads: scene.reads,
  pieces: scene.pieces.map((p) => ({ ...p, poly: p.poly.map(round) })),
  seams: scene.seams.map((s) => ({
    i: s.i,
    a: s.a,
    b: s.b,
    page: s.page,
    candidate: s.join.candidate,
    decidedBy: s.join.decidedBy,
    shape: s.join.shape,
    line: s.line.map(round),
    mid: s.mid,
    len: s.len,
    profA: s.profA,
    profB: s.profB,
    read: s.read,
  })),
  order: scene.order,
  climax: scene.climax ? { seam: scene.climax.seam, word: scene.climax.word, split: scene.climax.split } : null,
  transcript: lite.transcripts?.find((t: { ok: boolean }) => t.ok)?.text ?? null,
  timings: lite.timings,
  cost: lite.cost,
};
const file = path.resolve(import.meta.dirname, "../../src/data", `scene-${name}.json`);
fs.writeFileSync(file, JSON.stringify(out));
console.log(`${file}: ${out.pieces.length} pieces, ${out.seams.length} seams (${out.seams.filter((s) => s.read).length} read), order ${out.order.map((o) => out.pieces[o.piece].id).join(" ")}, climax ${JSON.stringify(out.climax)}, page ${JSON.stringify(out.pages[0])}`);
for (const s of out.seams) if (s.read) console.log(`  read ${out.pieces[s.a].id}~${out.pieces[s.b].id}: ${s.read.word} ${JSON.stringify(s.read.split)} (${s.read.confidence}) "${s.read.reason.slice(0, 90)}"`);
