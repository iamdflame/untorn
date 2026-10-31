// The first screen's recorded run, captured frame by frame at exact times through the hero's own seek hook (no
// model calls): photo -> SAM's outlines -> assembly with reads -> climax -> the whole page -> the twins -> the
// transcript. 30 fps, 3840x2160 JPEG. For the backup cut (the whole run, or any window of it).
//   node scripts/capture/hero-recorded.mjs [sample] [from] [to]   ->  capture/hero/<sample>/f00000.jpg ...
// from/to: seconds, or one of the hero's beats plus an offset ("tx0-0.5", "tx0+4"); frames keep their index in the run.
import path from "node:path";
import { APP, CAPTURE, ensureDir, heroAt, heroReady, launch, laptop, writeJson } from "./lib.mjs";

const [sample = "", fromArg, toArg] = process.argv.slice(2);
const OUT = ensureDir(path.join(CAPTURE, "hero", sample || "default"));
const browser = await launch();
const ctx = await laptop(browser);
const page = await ctx.newPage();
await page.goto(`${APP}/${sample ? `?sample=${sample}` : ""}`, { waitUntil: "load" });
await heroReady(page);
const T = await page.evaluate(() => window.untorn.T);
const at = (v, fallback) => {
  if (v === undefined) return fallback;
  const m = /^([a-zA-Z]\w*)?([+-][\d.]+)?$/.exec(v);
  return m && m[1] ? T[m[1]] + Number(m[2] ?? 0) : Number(v);
};
const start = Math.max(0, Math.floor(at(fromArg, 0) * 30));
const n = Math.ceil(at(toArg, T.end + 1.0) * 30);
for (let i = start; i <= n; i++) {
  await heroAt(page, i / 30);
  await page.screenshot({ path: path.join(OUT, `f${String(i).padStart(5, "0")}.jpg`), type: "jpeg", quality: 92, scale: "device" });
  if (i % 150 === 0) console.log(i, "/", n);
}
writeJson(path.join(OUT, "timeline.json"), { T, first: start, frames: n + 1, fps: 30 });
await browser.close();
console.log("done", n + 1 - start, "frames from", start);
