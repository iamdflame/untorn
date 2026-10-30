// Probe: load the first screen, read the hero's timeline, and take a few stills at chosen times.
//   node scripts/capture/probe-hero.mjs [width height] [sample]
import path from "node:path";
import { APP, CAPTURE, heroAt, heroReady, launch, laptop, shot, writeJson } from "./lib.mjs";

const width = Number(process.argv[2] ?? 1920);
const height = Number(process.argv[3] ?? 1080);
const sample = process.argv[4] ?? "";
const browser = await launch();
const ctx = await laptop(browser, { width, height });
const page = await ctx.newPage();
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
const t0 = Date.now();
await page.goto(`${APP}/${sample ? `?sample=${sample}` : ""}`, { waitUntil: "load" });
await heroReady(page);
console.log("ready in", Date.now() - t0, "ms");
const info = await page.evaluate(() => ({ T: window.untorn.T, TW: window.untorn.TW, beats: window.untorn.beats(), state: window.untorn.state() }));
const out = path.join(CAPTURE, "probe", `${sample || "default"}-${width}x${height}`);
writeJson(path.join(out, "timeline.json"), info);
console.log(JSON.stringify({ T: { ...info.T, stepT: info.T.stepT.map((v) => +v.toFixed(2)) }, climax: info.state.climax, beats: info.beats.length }, null, 0));
const times = [0.3, 1.2, 2.3, 3.2, 4.5, info.beats[0] ? info.beats[0].t0 + 0.8 : 6, info.T.cl0 + 1.5, info.T.cl0 + 2.6, info.T.whole + 0.8, info.T.tw0 + 1, info.T.tw0 + 4.5, info.T.tw1 - 1, info.T.tx1 + 0.1];
for (const t of times) {
  await heroAt(page, t);
  await shot(page, path.join(out, `t${t.toFixed(2).padStart(6, "0")}.jpg`));
}
await browser.close();
console.log("stills in", out);
