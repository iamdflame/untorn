// Short cuts of the finished film for social posts (X autoplays muted, so the burned-in captions carry them).
// Picture: hard cuts between the ranges. Sound: the incoming range comes up within `--ramp` s of the cut, so no first
// word is lost, and the outgoing one rings on for `--tail` s under it, fading, so the score never clicks. Pick cuts
// where no one is speaking in the tail.
//   node scripts/tools/xcut.mjs <film.mp4> <out.mp4> <from-to>[,<from-to>...] [--ramp 0.05] [--tail 0.15] [--out 0.3] [--crf 17]
// Times are the film's own, in seconds (scene starts: scripts/tools/timeline.mts; lines: out/untorn-demo.srt).
import path from "node:path";
import { ffmpeg, probe } from "../lib/ffmpeg.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const [filmArg, outArg, rangesArg] = args;
const film = path.resolve(filmArg);
const out = path.resolve(outArg);
const FPS = 30;
const snap = (s) => Math.round(s * FPS) / FPS;
const ramp = opt("ramp", 0.05);
const tail = opt("tail", 0.15);
const fadeOut = opt("out", 0.3);
const filmDur = Number(probe(film).format.duration);

const segs = rangesArg.split(",").map((r) => {
  const [a, b] = r.split("-").map(Number);
  return { a: snap(a), b: snap(Math.min(b, filmDur)) };
});

const inputs = [];
const graph = [];
let at = 0;
segs.forEach((s, k) => {
  const d = snap(s.b - s.a);
  inputs.push("-ss", s.a.toFixed(4), "-t", d.toFixed(4), "-i", film);
  // the sound starts at the cut and rings on `tail` s past the next one, inside the film's own bounds
  const last = k === segs.length - 1;
  const aa = s.a;
  const ab = last ? s.b : Math.min(filmDur, s.b + tail);
  const L = ab - aa;
  const fin = ramp;
  const fout = last ? fadeOut : ab - s.b;
  const place = at;
  inputs.push("-ss", aa.toFixed(4), "-t", L.toFixed(4), "-i", film);
  const ai = 2 * k + 1;
  graph.push(
    `[${ai}:a]volume='max(0,min(1,min(t/${fin.toFixed(3)},(${L.toFixed(3)}-t)/${fout.toFixed(3)})))':eval=frame,` +
      `adelay=${Math.round(place * 1000)}:all=1[a${k}]`,
  );
  s.d = d;
  at += d;
});
graph.push(`${segs.map((_, k) => `[${2 * k}:v]`).join("")}concat=n=${segs.length}:v=1:a=0[v]`);
graph.push(`${segs.map((_, k) => `[a${k}]`).join("")}amix=inputs=${segs.length}:normalize=0:duration=longest,atrim=0:${at.toFixed(4)}[a]`);

ffmpeg([
  "-y",
  ...inputs,
  "-filter_complex",
  graph.join(";"),
  "-map", "[v]",
  "-map", "[a]",
  "-c:v", "libx264", "-preset", "slow", "-crf", String(opt("crf", 17)), "-pix_fmt", "yuv420p", "-profile:v", "high", "-r", String(FPS),
  "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
  "-movflags", "+faststart",
  out,
]);
const p = probe(out);
console.log(`${out}  ${Number(p.format.duration).toFixed(2)} s  ${(Number(p.format.size) / 1e6).toFixed(1)} MB  (cuts at ${segs.slice(0, -1).map((s, k) => segs.slice(0, k + 1).reduce((x, y) => x + y.d, 0).toFixed(2)).join(", ") || "none"} s)`);
