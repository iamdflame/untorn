// Size a recorded sample's images for the web and fill its manifest entry.
//
//   pnpm tsx scripts/sample-assets.ts <name>
//
// Reads data/samples/<name>/photo.jpg (the full-resolution photo the run used) and public/samples/<name>/result.json
// (scripts/record-run.ts), and writes into public/samples/<name>/:
//   photo.jpg                  the stage photo, 2400 px long side, JPEG 85 (the manifest's fallback `url`)
//   photo-{800,…,3200}.webp    stage sizes for the srcset
//   photo-full.webp            full resolution for the cut-outs and the x2 close-ups; the desk away from the pieces is
//                              flattened to its mean colour (no piece pixel changes), which halves the file
//   page-N.png                 the rebuilt pages, palette-quantised (download only)
//   result-lite.json           the recording without the seam images (scripts/make-lite-recording.mjs)
// and sets the manifest's photo {url, width, height, sources, hires, lqip}.

import { readFileSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { RunResult } from "../src/lib/run/types";

const name = process.argv[2];
if (!name) throw new Error("usage: sample-assets.ts <name>");
const dir = path.join("public/samples", name);
const full = path.join("data/samples", name, "photo.jpg");
const result = JSON.parse(readFileSync(path.join(dir, "result.json"), "utf8")) as RunResult;
const kb = (f: string) => `${Math.round(statSync(f).size / 1024)} KB`;

async function main() {
  const meta = await sharp(full).metadata();
  const W = meta.width!;
  const H = meta.height!;
  const long = Math.max(W, H);
  const fit = (s: number) => ({ width: W >= H ? s : Math.round((s * W) / H), height: W >= H ? Math.round((s * H) / W) : s });

  // stage photo and sizes
  await sharp(full).resize(fit(Math.min(2400, long))).jpeg({ quality: 85, mozjpeg: true }).toFile(path.join(dir, "photo.jpg"));
  const sources: { url: string; w: number }[] = [];
  for (const s of [800, 1200, 1600, 2400, 3200].filter((s) => s < long)) {
    const f = `photo-${s}.webp`;
    await sharp(full).resize(fit(s)).webp({ quality: 82 }).toFile(path.join(dir, f));
    sources.push({ url: `/samples/${name}/${f}`, w: fit(s).width });
    console.log(f, kb(path.join(dir, f)));
  }

  // full resolution: keep every piece and a 48 px margin (shadows, fibre rims); flatten the rest of the desk
  const raw = await sharp(full).removeAlpha().raw().toBuffer();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${result.pieces
    .map((p) => `<path d="M${p.polygon.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L")}Z" fill="#fff" stroke="#fff" stroke-width="96" stroke-linejoin="round"/>`)
    .join("")}</svg>`;
  const keep = await sharp(Buffer.from(svg)).resize(W, H).greyscale().raw().toBuffer();
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < W * H; i += 7) {
    if (keep[i] > 127) continue;
    r += raw[3 * i];
    g += raw[3 * i + 1];
    b += raw[3 * i + 2];
    n++;
  }
  const desk = [r / n, g / n, b / n].map(Math.round);
  for (let i = 0; i < W * H; i++) {
    if (keep[i] > 127) continue;
    raw[3 * i] = desk[0];
    raw[3 * i + 1] = desk[1];
    raw[3 * i + 2] = desk[2];
  }
  const hires = path.join(dir, "photo-full.webp");
  await sharp(raw, { raw: { width: W, height: H, channels: 3 } }).webp({ quality: 85 }).toFile(hires);
  console.log("photo-full.webp", kb(hires));

  // blur-up placeholder painted with the HTML
  const lq = await sharp(full).resize(fit(240)).webp({ quality: 40 }).toBuffer();
  const lqip = `data:image/webp;base64,${lq.toString("base64")}`;

  // pages: palette PNG (download only; the first screen draws the page from the cut-outs)
  for (let k = 0; k < result.pages.length; k++) {
    const f = path.join(dir, `page-${k}.png`);
    const buf = await sharp(readFileSync(f)).png({ palette: true, quality: 90, effort: 8 }).toBuffer();
    writeFileSync(f, buf);
    console.log(`page-${k}.png`, kb(f));
  }

  // the light recording
  const lite = { ...result, reads: result.reads.map((x) => ({ ...x, image: null })) };
  writeFileSync(path.join(dir, "result-lite.json"), JSON.stringify(lite));
  console.log("result-lite.json", kb(path.join(dir, "result-lite.json")), "result.json", kb(path.join(dir, "result.json")), "photo.jpg", kb(path.join(dir, "photo.jpg")));

  const mf = "public/samples/manifest.json";
  const m = JSON.parse(readFileSync(mf, "utf8"));
  if (!m.samples[name]) throw new Error(`no manifest entry for ${name}`);
  m.samples[name].photo = { url: `/samples/${name}/photo.jpg`, width: W, height: H, sources, hires: `/samples/${name}/photo-full.webp`, lqip };
  writeFileSync(mf, JSON.stringify(m, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
