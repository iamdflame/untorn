// Paper cut-outs for the film, made by the product's own pixel code (src/components/hero/cutouts-core.ts) running in
// Chrome on the full-resolution photo: the lit exposure, the plain photo pixels, the edge light and both shadows, per
// piece. Same look as the app, at full resolution.
//   node scripts/assets/cutouts.mjs <scene json> <photo> <out dir> [scale]
//   e.g. node scripts/assets/cutouts.mjs src/data/scene-fdr-1927.json ../data/samples/fdr-1927/photo.jpg public/kit/fdr
import fs from "node:fs";
import path from "node:path";
import { transformSync } from "esbuild";
import { chromium } from "playwright";

const [sceneFile, photoFile, outDir, scaleArg, onlyArg] = process.argv.slice(2);
const only = onlyArg ? new Set(onlyArg.split(",")) : null;
if (!sceneFile || !photoFile || !outDir) throw new Error("usage: cutouts.mjs <scene json> <photo> <out dir> [scale]");
const scale = Number(scaleArg ?? 1);
const scene = JSON.parse(fs.readFileSync(sceneFile, "utf8"));
const core = fs.readFileSync(path.resolve(import.meta.dirname, "../../../src/components/hero/cutouts-core.ts"), "utf8");
const js = transformSync(core, { loader: "ts", format: "esm", target: "es2022" }).code.replace(/^export /gm, "");
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
const photoBuf = fs.readFileSync(photoFile);
const mime = photoFile.endsWith(".webp") ? "image/webp" : photoFile.endsWith(".png") ? "image/png" : "image/jpeg";
await page.route("http://kit.local/**", (r) => (r.request().url().endsWith("/photo") ? r.fulfill({ body: photoBuf, contentType: mime }) : r.fulfill({ body: "<!doctype html><title>kit</title>", contentType: "text/html" })));
await page.goto("http://kit.local/");
await page.addScriptTag({ content: `${js}\nwindow.cutPiece = cutPiece;` });
await page.evaluate(async () => {
  const im = new Image();
  im.src = "http://kit.local/photo";
  await im.decode();
  window.__photo = im;
});
const meta = {};
for (const p of scene.pieces.filter((q) => !only || only.has(q.id))) {
  const res = await page.evaluate(
    async ({ p, scale }) => {
      const r = window.cutPiece(window.__photo, scale, { c: p.c, poly: p.poly, bbox: p.bbox }, (w, h) => new OffscreenCanvas(w, h));
      const png = async (c) => {
        const b = await c.convertToBlob({ type: "image/png" });
        const buf = new Uint8Array(await b.arrayBuffer());
        let s = "";
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
        return btoa(s);
      };
      return {
        lit: await png(r.lit),
        plain: await png(r.plain),
        edge: await png(r.edge),
        shadow: await png(r.shadow),
        contact: await png(r.contact),
        meta: { off: r.off, scale: r.scale, w: r.w, h: r.h, pad: r.pad, shScale: r.shScale, edgePad: r.edgePad },
      };
    },
    { p, scale },
  );
  for (const k of ["lit", "plain", "edge", "shadow", "contact"]) fs.writeFileSync(path.join(outDir, `${p.id}-${k}.png`), Buffer.from(res[k], "base64"));
  meta[p.id] = res.meta;
  console.log(p.id, res.meta.w + "x" + res.meta.h);
}
fs.writeFileSync(path.join(outDir, "cutouts.json"), JSON.stringify(meta, null, 1));
if (process.env.META_OUT) fs.writeFileSync(process.env.META_OUT, JSON.stringify(meta, null, 1));
await browser.close();
