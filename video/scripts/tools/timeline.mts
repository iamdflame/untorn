// Prints the film's timeline (from the narration timestamps) and writes the SRT.
//   node_modules/.bin/tsx scripts/tools/timeline.mts [--srt out/untorn-demo.srt]
import fs from "node:fs";
import path from "node:path";
import { buildTimeline } from "../../src/film/timeline";
import { toSrt } from "../../src/components/Captions";

const tl = buildTimeline();
const mmss = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
for (const s of tl.scenes) console.log(s.id.padEnd(7), "start", mmss(s.start), "dur", s.dur.toFixed(2));
console.log("TOTAL", mmss(tl.total), `(${tl.total.toFixed(2)} s)`);
let lastEnd = 0;
for (const c of tl.clips) {
  const gap = c.at - lastEnd;
  console.log(mmss(c.at).padStart(8), (c.to - c.from).toFixed(2).padStart(5), gap > 1 ? `gap ${gap.toFixed(2)}` : "        ", c.shown.slice(0, 70));
  lastEnd = c.at + (c.to - c.from);
}
console.log("cues", JSON.stringify({ sacks: tl.sacks, twins: tl.twins, proof: tl.proof, golden: tl.golden, hood: tl.hood, peak: tl.peak }, (k, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v)));
const i = process.argv.indexOf("--srt");
if (i > 0) {
  fs.mkdirSync(path.dirname(process.argv[i + 1]), { recursive: true });
  fs.writeFileSync(process.argv[i + 1], toSrt(tl.clips));
  console.log("wrote", process.argv[i + 1]);
}
