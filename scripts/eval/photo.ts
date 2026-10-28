// Run the solver on any photo of torn pieces, once they are segmented, and write the rebuilt pages.
//
//   pnpm tsx scripts/eval/photo.ts <photo.jpg> [--masks labels.png | --segments segments.json | --threshold] [--out DIR]
//                                  [--cuts] [--content module:<path>]
//
// Segmentation inputs:
//   --masks FILE      label PNG, 0 = background, k = piece k (Bench-S format)
//   --segments FILE   JSON like S2's segmentFragments result: { fragments: [{ id, mask: { x, y, width, height,
//                     data: number[] | base64 string } }] }
//   --threshold       a stand-in segmentation for light paper on a darker ground (Otsu + connected components);
//                     the app uses SAM 3.1 (S2's segmentFragments) instead
// --cuts                 also match straight cuts (scissor cuts, ShredBench's Voronoi cuts); only content accepts them
// --content module:PATH  a module exporting createContentCheck() or a default ContentCheck (e.g. S2's Muse check)
// Writes DIR/result.json (pages, joins, unplaced, twin groups) and DIR/page-N.png.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { decode as decodePng } from "fast-png";
import { fragmentsFromSegments, type SegmentedFragment } from "../../src/lib/rejoin/adapters";
import { encodePng, renderPage } from "../../src/lib/rejoin/render";
import { askAll, contentRequests, finish, prepare } from "../../src/lib/rejoin/solve";
import type { ContentCheck, ContentRequest, ContentVerdict, FragmentInput, Rgba } from "../../src/lib/rejoin/types";
import { pathToFileURL } from "node:url";
import { fragmentsFromLabels, loadPhoto } from "./cases";

/** Otsu threshold on luminance, then 8-connected components larger than 0.2% of the photo. */
export function thresholdSegments(photo: Rgba): SegmentedFragment[] {
  const { width: W, height: H, data } = photo;
  const lum = new Uint8Array(W * H);
  const hist = new Float64Array(256);
  for (let i = 0; i < W * H; i++) {
    const v = Math.round(0.299 * data[4 * i] + 0.587 * data[4 * i + 1] + 0.114 * data[4 * i + 2]);
    lum[i] = v;
    hist[v]++;
  }
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let wB = 0;
  let sB = 0;
  let best = 0;
  let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = W * H - wB;
    if (!wF) break;
    sB += t * hist[t];
    const mB = sB / wB;
    const mF = (sum - sB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  const fg = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) fg[i] = lum[i] > thr ? 1 : 0;
  const label = new Int32Array(W * H);
  const out: SegmentedFragment[] = [];
  const stack: number[] = [];
  let next = 0;
  for (let i = 0; i < W * H; i++) {
    if (!fg[i] || label[i]) continue;
    next++;
    let x1 = W;
    let y1 = H;
    let x2 = -1;
    let y2 = -1;
    let area = 0;
    stack.push(i);
    label[i] = next;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % W;
      const y = (p - x) / W;
      area++;
      if (x < x1) x1 = x;
      if (y < y1) y1 = y;
      if (x > x2) x2 = x;
      if (y > y2) y2 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (fg[q] && !label[q]) {
            label[q] = next;
            stack.push(q);
          }
        }
      }
    }
    if (area < 0.002 * W * H) continue;
    const w = x2 - x1 + 1;
    const h = y2 - y1 + 1;
    const m = new Uint8Array(w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) m[r * w + c] = label[(y1 + r) * W + x1 + c] === next ? 1 : 0;
    out.push({ id: `s${out.length}`, mask: { x: x1, y: y1, width: w, height: h, data: m } });
  }
  return out;
}

function readSegments(file: string): SegmentedFragment[] {
  const j = JSON.parse(readFileSync(file, "utf8")) as { fragments: { id: string; mask: { x: number; y: number; width: number; height: number; data: number[] | string } }[] };
  return j.fragments.map((f) => ({
    id: f.id,
    mask: { ...f.mask, data: typeof f.mask.data === "string" ? Uint8Array.from(Buffer.from(f.mask.data, "base64")) : f.mask.data },
  }));
}

async function main() {
  const argv = process.argv.slice(2);
  const photoFile = argv[0];
  if (!photoFile) throw new Error("usage: photo.ts <photo.jpg> [--masks labels.png | --segments segments.json | --threshold] [--out DIR]");
  const opt = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const out = opt("--out") ?? path.join("scripts/eval/out", path.basename(photoFile).replace(/\.\w+$/, ""));
  mkdirSync(out, { recursive: true });
  const photo = loadPhoto(photoFile);
  let inputs: FragmentInput[];
  if (opt("--masks")) {
    const png = decodePng(readFileSync(opt("--masks")!));
    inputs = fragmentsFromLabels({ width: png.width, height: png.height, data: png.data as Uint8Array }, photo, new Map());
  } else if (opt("--segments")) inputs = fragmentsFromSegments(photo, readSegments(opt("--segments")!));
  else inputs = fragmentsFromSegments(photo, thresholdSegments(photo));
  const t0 = performance.now();
  const prep = prepare(inputs, { match: { cuts: argv.includes("--cuts") } });
  let reqs: ContentRequest[] = [];
  let verdicts: (ContentVerdict | null)[] = [];
  const contentSpec = opt("--content");
  if (contentSpec?.startsWith("module:")) {
    const mod = await import(pathToFileURL(path.resolve(contentSpec.slice(7))).href);
    const check: ContentCheck = typeof mod.createContentCheck === "function" ? await mod.createContentCheck() : mod.default;
    reqs = contentRequests(prep);
    verdicts = await askAll(reqs, check, 8);
  }
  const res = finish(prep, reqs, verdicts);
  const ms = performance.now() - t0 - (prep.timings.content ?? 0);
  res.pages.forEach((p, k) => writeFileSync(path.join(out, `page-${k}.png`), encodePng(renderPage(p, prep.fragments, { background: [255, 255, 255, 255] }))));
  const summary = {
    photo: photoFile,
    pieces: inputs.length,
    pages: res.pages.map((p) => ({ id: p.id, fragments: p.fragments.length, size: [p.width, p.height], confidence: p.confidence, completeness: p.completeness, upright: p.upright })),
    joins: res.joins.map((j) => ({ a: j.a, b: j.b, decidedBy: j.decidedBy, score: Math.round(j.geometry.score), loop: j.loop })),
    unplaced: res.unplaced,
    twinGroups: res.twinGroups.length,
    candidates: res.candidates.length,
    straightEdges: prep.fragments.map((f) => f.segments.filter((s) => s.kind === "straight").length),
    cutCandidates: prep.match.candidates.filter((c) => c.edge === "cut").length,
    contentAsked: reqs.length,
    ms: Math.round(ms),
  };
  writeFileSync(path.join(out, "result.json"), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify({ ...summary, joins: summary.joins.length }, null, 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
