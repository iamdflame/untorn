// Rebuilds public/kit/ (gitignored) from the app's own files, so a fresh checkout can render the film:
//   fdr/          cut-outs of the 1927 letter's 10 pieces (the product's cutPiece), the full photo, the rebuilt page,
//                 and the three seam images Muse read in the recorded run (decoded from its result.json)
//   twins/        cut-outs of the stack's anchor p3 and the three scraps p1, p21, p5
//   aside/        the stack scrap the run set aside (p4)
//   twins-sheet/  the app's own twin-A/B/C/L stills (public/samples/stack-3-letters)
//   shredbench/   ShredBench's official image news_041 (Apache-2.0), from the S5 benchmark workspace
//   node scripts/assets/kit.mjs [part ...]      (parts: fdr twins aside sheet shredbench; default all)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const APP = path.resolve(ROOT, "..");
const KIT = path.join(ROOT, "public/kit");
const want = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ["fdr", "twins", "aside", "sheet", "shredbench"]);
const mk = (d) => fs.mkdirSync(d, { recursive: true });
const cutouts = (scene, photo, out, only) =>
  execFileSync(process.execPath, [path.join(ROOT, "scripts/assets/cutouts.mjs"), scene, photo, out, "1", ...(only ? [only] : [])], { cwd: ROOT, stdio: "inherit" });

if (want.has("fdr")) {
  const out = path.join(KIT, "fdr");
  mk(out);
  cutouts("src/data/scene-fdr-1927.json", path.join(APP, "data/samples/fdr-1927/photo.jpg"), out);
  fs.copyFileSync(path.join(APP, "data/samples/fdr-1927/photo.jpg"), path.join(out, "photo.jpg"));
  fs.copyFileSync(path.join(APP, "public/samples/fdr-1927/page-0.png"), path.join(out, "page-0.png"));
  const run = JSON.parse(fs.readFileSync(path.join(APP, "public/samples/fdr-1927/result.json"), "utf8"));
  for (const id of ["pair:p0~p1#0", "pair:p2~p8#0", "pair:p7~p9#0"]) {
    const rd = run.reads.find((r) => r.id === id);
    if (!rd?.image?.startsWith("data:image/jpeg;base64,")) throw new Error(`no image for read ${id}`);
    const name = `seam-${id.replace(":", "-").replace("~", "_").replace("#", "_")}.jpg`.replace("seam-pair-", "seam-pair_");
    fs.writeFileSync(path.join(out, name), Buffer.from(rd.image.split(",")[1], "base64"));
  }
}
if (want.has("twins")) {
  const out = path.join(KIT, "twins");
  mk(out);
  cutouts("src/data/scene-stack-3-letters.json", path.join(APP, "data/samples/stack-3-letters/photo.jpg"), out, "p1,p21,p3,p5");
}
if (want.has("aside")) {
  const out = path.join(KIT, "aside");
  mk(out);
  cutouts("src/data/scene-stack-3-letters.json", path.join(APP, "data/samples/stack-3-letters/photo.jpg"), out, "p4");
}
if (want.has("sheet")) {
  const out = path.join(KIT, "twins-sheet");
  mk(out);
  for (const k of ["A", "B", "C", "L"]) fs.copyFileSync(path.join(APP, `public/samples/stack-3-letters/twin-${k}.webp`), path.join(out, `twin-${k}.webp`));
}
if (want.has("shredbench")) {
  const out = path.join(KIT, "shredbench");
  mk(out);
  // the main checkout's S5 workspace holds ShredBench's official renders (github.com/ythere-y/ShredBench, Apache-2.0)
  const src = process.env.SHREDBENCH_IMAGE ?? path.resolve(APP, "../../rr/.apex/build/S5-shredbench/official/data_8/news_041.jpg");
  if (!fs.existsSync(src)) throw new Error(`news_041.jpg not found at ${src}: set SHREDBENCH_IMAGE to ShredBench's official data_8/news_041.jpg`);
  fs.copyFileSync(src, path.join(out, "news_041.jpg"));
}
console.log(`kit rebuilt: ${[...want].join(", ")}`);
