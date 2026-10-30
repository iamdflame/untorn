// Review set from a rendered film: a contact sheet (one frame every N s) and full-resolution stills at given times.
//   node scripts/tools/review.mjs <film.mp4> <out dir> [--every 4] [--stills 3,30,110]
import fs from "node:fs";
import path from "node:path";
import { ffmpeg, probe } from "../lib/ffmpeg.mjs";

const [film, outDir] = process.argv.slice(2);
const opt = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const every = Number(opt("every", 4));
const stills = String(opt("stills", "3,30,110")).split(",").map(Number);
const dur = Number(probe(film).format.duration);
const fr = path.join(outDir, "frames");
fs.mkdirSync(fr, { recursive: true });
for (let t = 0; t < dur; t += every) {
  const tc = Math.round(t * 30);
  ffmpeg(["-y", "-ss", String(t), "-i", path.resolve(film), "-frames:v", "1", "-q:v", "3", path.resolve(fr, `f${String(tc).padStart(5, "0")}.jpg`)]);
}
for (const s of stills) {
  const name = `still-${Math.floor(s / 60)}m${String(Math.floor(s % 60)).padStart(2, "0")}s.png`;
  ffmpeg(["-y", "-ss", String(s), "-i", path.resolve(film), "-frames:v", "1", path.resolve(outDir, name)]);
}
console.log(`frames every ${every} s and ${stills.length} stills in ${outDir}`);
