// The first screen's recorded run, captured frame by frame at exact times through the hero's own seek hook (no
// model calls): photo -> SAM's outlines -> assembly with reads -> climax -> the whole page -> the twins -> the
// transcript. 30 fps, 3840x2160 JPEG. For the backup cut.
//   node scripts/capture/hero-recorded.mjs [sample]   ->  capture/hero/<sample>/f00000.jpg ...
import path from "node:path";
import { APP, CAPTURE, ensureDir, heroAt, heroReady, launch, laptop, writeJson } from "./lib.mjs";

const sample = process.argv[2] ?? "";
const OUT = ensureDir(path.join(CAPTURE, "hero", sample || "default"));
const browser = await launch();
const ctx = await laptop(browser);
const page = await ctx.newPage();
await page.goto(`${APP}/${sample ? `?sample=${sample}` : ""}`, { waitUntil: "load" });
await heroReady(page);
const T = await page.evaluate(() => window.untorn.T);
const end = T.end + 1.0;
const n = Math.ceil(end * 30);
for (let i = 0; i <= n; i++) {
  await heroAt(page, i / 30);
  await page.screenshot({ path: path.join(OUT, `f${String(i).padStart(5, "0")}.jpg`), type: "jpeg", quality: 92, scale: "device" });
  if (i % 150 === 0) console.log(i, "/", n);
}
writeJson(path.join(OUT, "timeline.json"), { T, frames: n + 1, fps: 30 });
await browser.close();
console.log("done", n + 1, "frames");
