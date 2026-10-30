// Renders through Remotion's Node API, so the gitignored captures can be linked into the bundle (a junction to
// video/capture at public/capture inside the bundle; Remotion copies the public folder but cannot copy a junction on
// Windows without admin rights).
//   node scripts/render.mjs still <Composition> <frame|frames,...> [out dir] [--scale 1]
//   node scripts/render.mjs video <Composition> <out.mp4> [--frames a-b] [--scale 1] [--crf 14]
//   node scripts/render.mjs sheet <Composition> <every N frames> <out.png>      (contact sheet)
import fs from "node:fs";
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderFrames, renderMedia, renderStill, selectComposition } from "@remotion/renderer";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const [mode, compId] = args;

let cached = null;
async function getBundle() {
  if (cached) return cached;
  const dir = await bundle({ entryPoint: path.join(ROOT, "src/index.ts"), publicDir: path.join(ROOT, "public"), onProgress: () => {} });
  const link = path.join(dir, "public", "capture");
  if (!fs.existsSync(link) && fs.existsSync(path.join(ROOT, "capture"))) fs.symlinkSync(path.join(ROOT, "capture"), link, "junction");
  cached = dir;
  return dir;
}

const chromiumOptions = { gl: "angle", enableMultiProcessOnLinux: true };
const scale = Number(opt("scale", 1));

async function main() {
  const serveUrl = await getBundle();
  const composition = await selectComposition({ serveUrl, id: compId, chromiumOptions });
  if (mode === "still") {
    const frames = String(args[2]).split(",").map(Number);
    const outDir = args[3] && !args[3].startsWith("--") ? args[3] : path.join(ROOT, "out", "stills");
    fs.mkdirSync(outDir, { recursive: true });
    for (const f of frames) {
      const output = path.join(outDir, `${compId}-${String(f).padStart(5, "0")}.png`);
      await renderStill({ serveUrl, composition, frame: f, output, scale, chromiumOptions, imageFormat: "png", timeoutInMilliseconds: 180000 });
      console.log(output);
    }
  } else if (mode === "video") {
    const out = args[2];
    const fr = opt("frames", null);
    const frameRange = fr ? fr.split("-").map(Number) : null;
    const t0 = Date.now();
    await renderMedia({
      serveUrl,
      composition,
      codec: "h264",
      outputLocation: out,
      crf: Number(opt("crf", 14)),
      pixelFormat: "yuv420p",
      audioCodec: "aac",
      audioBitrate: "320k",
      x264Preset: opt("preset", "slow"),
      frameRange: frameRange ? [frameRange[0], frameRange[1]] : undefined,
      scale,
      chromiumOptions,
      concurrency: Number(opt("concurrency", 6)),
      timeoutInMilliseconds: 300000,
      onProgress: ({ progress }) => {
        if (Math.round(progress * 100) % 10 === 0) process.stdout.write(`\r${Math.round(progress * 100)}%   `);
      },
    });
    console.log(`\n${out} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  } else if (mode === "frames") {
    // image sequence (for contact sheets): every Nth frame
    const every = Number(args[2]);
    const outDir = args[3];
    fs.mkdirSync(outDir, { recursive: true });
    const list = [];
    for (let f = 0; f < composition.durationInFrames; f += every) list.push(f);
    for (const f of list) {
      const output = path.join(outDir, `f${String(f).padStart(5, "0")}.jpg`);
      await renderStill({ serveUrl, composition, frame: f, output, scale, chromiumOptions, imageFormat: "jpeg", jpegQuality: 90, timeoutInMilliseconds: 180000 });
    }
    console.log(`${list.length} frames in ${outDir}`);
  } else {
    console.log("usage: render.mjs still|video|frames <Composition> ...");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
