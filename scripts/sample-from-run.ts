// Turn a stored production run into a recorded sample, with no model call: the run's own outlines, reads, joins and
// poses, its photo, and its page image re-drawn from those outlines and poses (the run's page-N.png is gone with the
// run after 24 hours).
//
//   pnpm tsx scripts/sample-from-run.ts <name> <run.json> <photo.jpg>
//
// <run.json> is a RunResult, or a capture whose last event is the run's `done` line ({ events: [{ line }] }).
// <photo.jpg> must be the photo the run saw (same width and height as the result says).
// Writes data/samples/<name>/photo.jpg (no metadata), public/samples/<name>/page-N.png and result.json with its
// URLs pointing at the sample's files. Then add the manifest entry and run scripts/sample-assets.ts <name>.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { renderPage } from "../src/lib/rejoin/render";
import type { Page, Rgba } from "../src/lib/rejoin/types";
import type { RunResult } from "../src/lib/run/types";

const [name, runFile, photoFile] = process.argv.slice(2);
if (!name || !runFile || !photoFile) throw new Error("usage: sample-from-run.ts <name> <run.json> <photo.jpg>");

/** The page render the pipeline uses (src/lib/server/pipeline.ts: PAGE_MARGIN, PAGE_LONG_SIDE). */
const PAGE_MARGIN = 8;
const PAGE_LONG_SIDE = 3000;

function readResult(file: string): RunResult {
  const j = JSON.parse(readFileSync(file, "utf8"));
  if (j.version === 1 && j.pieces) return j as RunResult;
  const last = j.events?.at(-1)?.line;
  const done = typeof last === "string" ? JSON.parse(last) : last;
  if (done?.type !== "done" || !done.result) throw new Error("no done event with a result in " + file);
  return done.result as RunResult;
}

async function main() {
  const result = readResult(runFile);
  const meta = await sharp(photoFile).metadata();
  const W = meta.width!;
  const H = meta.height!;
  if (W !== result.photo.width || H !== result.photo.height) throw new Error(`photo is ${W}×${H}, the run saw ${result.photo.width}×${result.photo.height}`);

  // the photo the live sample run reads, re-encoded without any metadata
  const dataDir = path.join("data/samples", name);
  mkdirSync(dataDir, { recursive: true });
  await sharp(photoFile).jpeg({ quality: 92, mozjpeg: true }).toFile(path.join(dataDir, "photo.jpg"));

  // each piece: its outline rasterised over its box, with the photo under it
  const raw = await sharp(photoFile).removeAlpha().ensureAlpha().raw().toBuffer();
  const inputs = new Map<string, { input: { id: string; mask: { width: number; height: number; data: Uint8Array }; x0: number; y0: number; rgba: Rgba } }>();
  for (const p of result.pieces) {
    const xs = p.polygon.map(([x]) => x);
    const ys = p.polygon.map(([, y]) => y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)) - 1);
    const y0 = Math.max(0, Math.floor(Math.min(...ys)) - 1);
    const w = Math.min(W, Math.ceil(Math.max(...xs)) + 2) - x0;
    const h = Math.min(H, Math.ceil(Math.max(...ys)) + 2) - y0;
    const d = `M${p.polygon.map(([x, y]) => `${(x - x0).toFixed(2)},${(y - y0).toFixed(2)}`).join("L")}Z`;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><path d="${d}" fill="#fff"/></svg>`;
    const grey = await sharp(Buffer.from(svg)).resize(w, h).greyscale().raw().toBuffer();
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) mask[i] = grey[i] > 127 ? 1 : 0;
    const rgba = new Uint8Array(w * h * 4);
    for (let r = 0; r < h; r++) rgba.set(raw.subarray(4 * ((y0 + r) * W + x0), 4 * ((y0 + r) * W + x0 + w)), 4 * r * w);
    inputs.set(p.id, { input: { id: p.id, mask: { width: w, height: h, data: mask }, x0, y0, rgba: { width: w, height: h, data: rgba } } });
  }

  const outDir = path.join("public/samples", name);
  mkdirSync(outDir, { recursive: true });
  const pages = await Promise.all(
    result.pages.map(async (pg, k) => {
      const page: Page = { id: pg.id, fragments: pg.pieces.map((x) => ({ id: x.id, pose: x.pose })), width: pg.width, height: pg.height, confidence: pg.confidence } as Page;
      const img = renderPage(page, inputs as never, { margin: PAGE_MARGIN, scale: Math.min(1, PAGE_LONG_SIDE / (Math.max(pg.width, pg.height) + 2 * PAGE_MARGIN)) });
      const f = path.join(outDir, `page-${k}.png`);
      await sharp(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length), { raw: { width: img.width, height: img.height, channels: 4 } }).png({ compressionLevel: 9 }).toFile(f);
      console.log(`page-${k}.png ${img.width}×${img.height}`);
      return { ...pg, image: `/samples/${name}/page-${k}.png` };
    }),
  );

  const out: RunResult = { ...result, photo: { ...result.photo, url: `/samples/${name}/photo.jpg` }, pages };
  writeFileSync(path.join(outDir, "result.json"), JSON.stringify(out));
  console.log(`result.json: run ${result.runId} of ${result.createdAt} (${result.source}), ${result.pieces.length} pieces, ${result.reads.length} reads, ${result.joins.length} joins`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
