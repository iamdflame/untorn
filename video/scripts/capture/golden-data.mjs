// Phase 3 of the golden path: turn a replay capture into the two small data files the film reads.
//   src/data/golden-frames.json  per frame: [frame, sequence, run ms on the replay clock (waits cut), scrollY],
//                                the cuts, and when the run's done event really arrived (the clock stops there)
//   src/data/golden-run.json     a summary of the run's done event (the full event log stays in the capture)
//   node scripts/capture/golden-data.mjs [capture dir, default capture/golden-prod] [frames file, default golden-frames.json]
//   (the real-tear variant: node scripts/capture/golden-data.mjs capture/golden-real golden-frames-real.json)
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const root = path.join(import.meta.dirname, "../..");
const dir = path.resolve(root, process.argv[2] ?? "capture/golden-prod");
const log = JSON.parse(fs.readFileSync(path.join(dir, "replay-log.json"), "utf8"));
const rec = JSON.parse(fs.readFileSync(path.join(dir, "run-events.json"), "utf8"));

const t0 = rec.meta.runStart;
const lines = rec.events.map((e) => ({ at: e.at - t0, ev: JSON.parse(e.line) }));
const done = lines.find((l) => l.ev.type === "done");
if (!done) throw new Error("no done event in run-events.json");
const r = done.ev.result;

const rel = path.relative(root, dir).split(path.sep).join("/");

// The replay sometimes catches the stage between two paints (a single frame with no pieces on it, at a read's
// arrival). Find them by the stage's brightness against both neighbours; the film shows the frame before instead.
const lum = new Map();
for (const f of log.frames) {
  if (f.seg !== "seq-live") continue;
  const st = await sharp(path.join(dir, f.seg, f.file)).extract({ left: 1700, top: 200, width: 2000, height: 1700 }).resize(100, 85).stats();
  lum.set(f.frame, (st.channels[0].mean + st.channels[1].mean + st.channels[2].mean) / 3);
}
const blank = [];
for (const [n, m] of lum) {
  const a = lum.get(n - 1);
  const b = lum.get(n + 1);
  if (a != null && b != null && m < 0.7 * Math.min(a, b)) blank.push(n);
}
const frames = {
  dir: rel,
  step: log.step,
  cuts: log.cuts,
  doneReal: Math.round(done.at),
  blank,
  frames: log.frames.map((f) => [f.frame, f.seg.replace(/^seq-/, ""), f.runMs, f.scrollY]),
};
const framesFile = process.argv[3] ?? "golden-frames.json";
fs.writeFileSync(path.join(root, "src/data", framesFile), JSON.stringify(frames));

const host = (() => {
  try {
    return new URL(rec.meta.session.body.url).host;
  } catch {
    return null;
  }
})();
const run = {
  note: `The live run filmed for the golden path (${host ?? "the app"}, phone page to laptop). Summary of its done event; the full event log stays in ${rel}/run-events.json (gitignored).`,
  runId: r.runId,
  session: rec.code,
  url: rec.meta.session.body.url,
  source: r.source,
  createdAt: r.createdAt,
  photo: `${process.env.GOLDEN_PHOTO ?? rec.photo}, sent from the phone page in an emulated iPhone 15 Pro`,
  arrived: { doneMs: Math.round(done.at) },
  timings: r.timings,
  cost: r.cost,
  pieces: r.pieces.length,
  joins: r.joins.length,
  unplaced: r.unplaced.length,
  reads: r.reads.length,
  pages: r.pages.length,
};
fs.writeFileSync(path.join(root, "src/data", framesFile.replace("golden-frames", "golden-run")), JSON.stringify(run, null, 1) + "\n");
console.log(`${framesFile}: ${frames.frames.length} frames from ${rel}; done arrived at ${(done.at / 1000).toFixed(2)} s; blank stage frames: ${blank.join(", ") || "none"}`);
console.log(`golden-run.json: ${run.runId} ${run.url} ${run.pieces} pieces ${run.joins} joins $${run.cost.usd}`);
