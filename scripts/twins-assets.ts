// The twins beat's images from a recorded stack run: one k-way read Muse made, re-drawn from the full-resolution photo
// in the exact frame of the sheet Muse read, with transparent paper edges.
//
//   pnpm tsx scripts/twins-assets.ts <sample> <read id> [--crop Y0,Y1]
//
// Writes public/samples/<sample>/twin-{L,A,B,C}.webp (L: the left piece; A–C: the candidates in sheet order, each
// starting at the slot) and prints the manifest fields it measured (image sizes, slotX, choice, confidence) plus a
// preview of the left piece joined to Muse's pick (.apex/scratch/twins-preview.png) for placing the rings by eye.
// The pieces' masks are rebuilt from the run's outlines (1.2 px simplification), the solver's geometry is prepared
// again, and each candidate is the twin-group fit between the left piece and that partner.

import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { prepare } from "../src/lib/rejoin/solve";
import { medianPitch, renderChoiceSheet } from "../src/lib/rejoin/seam";
import type { Candidate, FragmentInput } from "../src/lib/rejoin/types";
import type { RunResult } from "../src/lib/run/types";
import { DEFAULT_SHEET_WINDOW } from "../src/lib/server/pipeline";

const [name, readId] = process.argv.slice(2);
const scan = readId === "--scan";
const cropArg = process.argv.indexOf("--crop") > 0 ? process.argv[process.argv.indexOf("--crop") + 1].split(",").map(Number) : null;
if (!name || !readId) throw new Error("usage: twins-assets.ts <sample> <read id> [--crop Y0,Y1]");
const dir = path.join("public/samples", name);
const result = JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8")) as RunResult;
const read = scan ? result.reads.find((r) => r.kind === "choice" && r.choice !== null) : result.reads.find((r) => r.id === readId);
if (!read || read.kind !== "choice" || read.choice === null) throw new Error(`${readId} is not an answered k-way read`);
const SS = 2; // supersampling for smooth paper edges
const KEY = [255, 0, 255] as const;

async function main() {
  const full = path.join("data/samples", name, "photo.jpg");
  const { data: rgb, info } = await sharp(full).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  // every piece, so the photo's median line pitch (the sheet's scale) is the one the run used
  const inputs: FragmentInput[] = [];
  for (const p of result.pieces) {
    const [x0, y0, x1, y1] = [Math.floor(p.box[0]) - 2, Math.floor(p.box[1]) - 2, Math.ceil(p.box[2]) + 3, Math.ceil(p.box[3]) + 3].map((v, i) => Math.max(0, Math.min(i % 2 ? H : W, v)));
    const w = x1 - x0;
    const h = y1 - y0;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><path d="M${p.polygon.map(([x, y]) => `${(x - x0).toFixed(2)},${(y - y0).toFixed(2)}`).join("L")}Z" fill="#fff"/></svg>`;
    const m = await sharp(Buffer.from(svg)).greyscale().raw().toBuffer();
    const mask = new Uint8Array(w * h);
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const k = r * w + c;
        mask[k] = m[k] > 127 ? 1 : 0;
        const s = 3 * ((y0 + r) * W + x0 + c);
        rgba.set([rgb[s], rgb[s + 1], rgb[s + 2], 255], 4 * k);
      }
    }
    inputs.push({ id: p.id, mask: { width: w, height: h, data: mask }, x0, y0, rgba: { width: w, height: h, data: rgba } });
  }
  const prep = prepare(inputs);
  if (scan) {
    // which reads show the left piece on the left (the twins beat needs the slot on its right)
    for (const r of result.reads) {
      if (r.kind !== "choice" || r.choice === null) continue;
      const cs = r.pieces.slice(1).map((pid) => prep.match.candidates.filter((c) => (c.a === r.pieces[0] && c.b === pid) || (c.b === r.pieces[0] && c.a === pid)).sort((x, y) => (y.twinGroup ? 1 : 0) - (x.twinGroup ? 1 : 0) || y.score - x.score)[0]);
      if (cs.some((c) => !c)) continue;
      const img = renderChoiceSheet(prep.byId, r.pieces[0], cs, { pitchHint: medianPitch(prep.fragments), sheetWidth: DEFAULT_SHEET_WINDOW[0], sheetHeight: DEFAULT_SHEET_WINDOW[1], background: [...KEY] });
      let sx = 0;
      let n = 0;
      for (let y = 20; y < 20 + DEFAULT_SHEET_WINDOW[1]; y++) for (let x = 20; x < 20 + DEFAULT_SHEET_WINDOW[0]; x++) {
        const k = 4 * (y * img.width + x);
        if (img.data[k] === KEY[0] && img.data[k + 1] === KEY[1] && img.data[k + 2] === KEY[2]) continue;
        sx += x - 20;
        n++;
      }
      console.log(`${r.id} anchor-centre-x ${(sx / Math.max(1, n) / DEFAULT_SHEET_WINDOW[0]).toFixed(2)} conf ${r.confidence} choice ${"ABC"[r.choice]} ${r.reason.slice(0, 110)}`);
    }
    return;
  }
  const anchor = read!.pieces[0];
  const partners = read!.pieces.slice(1);
  const cands: Candidate[] = partners.map((pid) => {
    const fits = prep.match.candidates.filter((c) => (c.a === anchor && c.b === pid) || (c.b === anchor && c.a === pid)).sort((x, y) => (y.twinGroup ? 1 : 0) - (x.twinGroup ? 1 : 0) || y.score - x.score);
    if (!fits.length) throw new Error(`no fit between ${anchor} and ${pid}`);
    return fits[0];
  });
  // the sheet's frame and scale, as the pipeline drew it, at SS x the resolution
  const [sw, sh] = DEFAULT_SHEET_WINDOW;
  const hint = medianPitch(prep.fragments);
  const near = (p: number | null | undefined) => !!p && (!hint || (p >= 0.6 * hint && p <= 1.6 * hint));
  const A = prep.byId.get(anchor)!;
  const first = prep.byId.get(partners[0])!;
  const pitch = [A.text?.pitch, first.text?.pitch].find(near) ?? hint ?? 32;
  const scale = Math.max(0.5, Math.min(3, 32 / pitch));
  const sheet = renderChoiceSheet(prep.byId, anchor, cands, { pitchHint: hint, sheetWidth: sw * SS, sheetHeight: sh * SS, scale: scale * SS, background: [...KEY] });
  const pad = 20;
  const gap = 34;
  const panel = async (k: number) => {
    const top = pad + (sh * SS + gap) * k;
    const out = Buffer.alloc(sw * SS * sh * SS * 4);
    for (let y = 0; y < sh * SS; y++) {
      for (let x = 0; x < sw * SS; x++) {
        const s = 4 * ((top + y) * sheet.width + pad + x);
        const d = 4 * (y * sw * SS + x);
        const key = sheet.data[s] === KEY[0] && sheet.data[s + 1] === KEY[1] && sheet.data[s + 2] === KEY[2];
        out[d] = sheet.data[s];
        out[d + 1] = sheet.data[s + 1];
        out[d + 2] = sheet.data[s + 2];
        out[d + 3] = key ? 0 : 255;
      }
    }
    // premultiplied downsample keeps the keyed colour out of the edges
    return sharp(out, { raw: { width: sw * SS, height: sh * SS, channels: 4 } }).resize(sw, sh, { kernel: "lanczos3" }).raw().toBuffer();
  };
  const panels = await Promise.all([0, 1, 2, 3].map(panel));
  const alphaCols = (buf: Buffer, rows: [number, number]) => {
    let min = sw;
    let max = -1;
    for (let y = rows[0]; y < rows[1]; y++) for (let x = 0; x < sw; x++) if (buf[4 * (y * sw + x) + 3] > 127) {
      min = Math.min(min, x);
      max = Math.max(max, x);
    }
    return [min, max];
  };
  const rows: [number, number] = cropArg ? [cropArg[0], cropArg[1]] : [0, sh];
  const ch = rows[1] - rows[0];
  const lRight = alphaCols(panels[0], rows)[1] + 1;
  const slotX = Math.min(...panels.slice(1).map((b) => alphaCols(b, rows)[0]));
  const outDir = dir;
  mkdirSync(outDir, { recursive: true });
  const save = async (buf: Buffer, left: number, width: number, file: string) => {
    await sharp(buf, { raw: { width: sw, height: sh, channels: 4 } }).extract({ left, top: rows[0], width, height: ch }).webp({ quality: 90, alphaQuality: 100 }).toFile(path.join(outDir, file));
  };
  await save(panels[0], 0, lRight, "twin-L.webp");
  const cw = sw - slotX;
  for (let k = 0; k < 3; k++) await save(panels[k + 1], slotX, cw, `twin-${"ABC"[k]}.webp`);
  // preview: the left piece with Muse's pick in the slot
  const pick = panels[1 + read!.choice!];
  const comp = Buffer.from(panels[0]);
  for (let i = 0; i < sw * sh; i++) if (pick[4 * i + 3] > comp[4 * i + 3]) pick.copy(comp, 4 * i, 4 * i, 4 * i + 4);
  mkdirSync(".apex/scratch", { recursive: true });
  await sharp(comp, { raw: { width: sw, height: sh, channels: 4 } }).extract({ left: 0, top: rows[0], width: sw, height: ch }).flatten({ background: "#5a3c28" }).png().toFile(".apex/scratch/twins-preview.png");
  const letter = (i: number) => "ABC"[i];
  console.log(
    JSON.stringify({
      images: { L: { url: `/samples/${name}/twin-L.webp`, w: lRight, h: ch }, A: { url: `/samples/${name}/twin-A.webp`, w: cw, h: ch }, B: { url: `/samples/${name}/twin-B.webp`, w: cw, h: ch }, C: { url: `/samples/${name}/twin-C.webp`, w: cw, h: ch } },
      slotX,
      choice: letter(read!.choice!),
      confidence: read!.confidence,
      words: read!.words,
      reason: read!.reason,
      anchor,
      partners,
      scale,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
