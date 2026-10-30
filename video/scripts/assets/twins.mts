// The twins trick's data, from the recorded stack run and the solver itself: the anchor piece Muse read against, the
// three scraps that share its torn edge (one per letter), and each scrap's fit into the slot as the solver's
// geometry placed it (the twin-group candidate pose), plus the scene (page poses) for the whole stack.
//   ../node_modules/.bin/tsx scripts/assets/twins.mts  ->  src/data/twins.json, src/data/scene-stack-3-letters.json
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { poseInvert } from "../../../src/lib/rejoin/geom";
import { prepare } from "../../../src/lib/rejoin/solve";
import type { FragmentInput } from "../../../src/lib/rejoin/types";
import { buildScene } from "../../../src/lib/run/scene";

const repo = path.resolve(import.meta.dirname, "../../..");
const name = "stack-3-letters";
const READ = "choice:twin-p3-65";
const result = JSON.parse(fs.readFileSync(path.join(repo, "public/samples", name, "result.json"), "utf8"));
const read = result.reads.find((r: { id: string }) => r.id === READ);
const [anchor, ...partners] = read.pieces as string[];

const { data: rgb, info } = await sharp(path.join(repo, "data/samples", name, "photo.jpg")).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width;
const H = info.height;
const inputs: FragmentInput[] = [];
for (const p of result.pieces) {
  const [x0, y0, x1, y1] = [Math.floor(p.box[0]) - 2, Math.floor(p.box[1]) - 2, Math.ceil(p.box[2]) + 3, Math.ceil(p.box[3]) + 3].map((v, i) => Math.max(0, Math.min(i % 2 ? H : W, v)));
  const w = x1 - x0;
  const h = y1 - y0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><path d="M${p.polygon.map(([x, y]: number[]) => `${(x - x0).toFixed(2)},${(y - y0).toFixed(2)}`).join("L")}Z" fill="#fff"/></svg>`;
  const m = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer();
  const mask = new Uint8Array(w * h);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const k = r * w + c;
      mask[k] = m[k] > 127 ? 1 : 0;
      const s = 3 * ((y0 + r) * W + x0 + c);
      rgba.set([rgb[s], rgb[s + 1], rgb[s + 2], 255], 4 * k);
    }
  inputs.push({ id: p.id, mask: { width: w, height: h, data: mask }, x0, y0, rgba: { width: w, height: h, data: rgba } });
}
const prep = prepare(inputs);
const fits = partners.map((pid, k) => {
  const c = prep.match.candidates
    .filter((x) => (x.a === anchor && x.b === pid) || (x.b === anchor && x.a === pid))
    .sort((x, y) => (y.twinGroup ? 1 : 0) - (x.twinGroup ? 1 : 0) || y.score - x.score)[0];
  if (!c) throw new Error(`no fit between ${anchor} and ${pid}`);
  // candidate.pose maps b's photo coordinates into a's; we want the scrap's coordinates in the anchor's
  const pose = c.a === anchor ? c.pose : poseInvert(c.pose);
  return { key: "ABC"[k], id: pid, pose, score: c.score, rms: c.rms, fineRms: c.fineRms, overlap: c.overlap, twinGroup: c.twinGroup };
});

const scene = buildScene({ photo: { width: result.photo.width, height: result.photo.height }, pieces: result.pieces, pages: result.pages, joins: result.joins, reads: result.reads });
const pageOf = (id: string) => result.pages.findIndex((p: { pieces: { id: string }[] }) => p.pieces.some((f) => f.id === id));
const poseOf = (id: string) => {
  const pg = result.pages[pageOf(id)];
  return pg?.pieces.find((f: { id: string }) => f.id === id)?.pose ?? null;
};
const out = {
  sample: name,
  runId: result.runId,
  read: READ,
  anchor: { id: anchor, page: pageOf(anchor), pagePose: poseOf(anchor) },
  candidates: fits.map((f) => ({ ...f, page: pageOf(f.id), pagePose: poseOf(f.id) })),
  choice: "ABC"[read.choice],
  confidence: read.confidence,
  words: read.words,
  reason: read.reason,
};
fs.writeFileSync(path.resolve(import.meta.dirname, "../../src/data/twins.json"), JSON.stringify(out, null, 1));
const round = (v: number) => Math.round(v * 100) / 100;
const pick = new Set([anchor, ...partners]);
fs.writeFileSync(
  path.resolve(import.meta.dirname, "../../src/data/scene-stack-3-letters.json"),
  JSON.stringify({ sample: name, runId: result.runId, photo: result.photo, pages: scene.pages, pagesBox: scene.pagesBox, box: scene.box, pieces: scene.pieces.map((p) => ({ ...p, poly: p.poly.map(round) })), twinIds: [...pick] }),
);
console.log(JSON.stringify(out, null, 1));
