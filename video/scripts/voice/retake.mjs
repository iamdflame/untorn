// Re-takes of one scene, auditioned before anything is replaced: each take goes to out/retakes/<scene>/<n>.mp3 (with its
// alignment), and the report says whether it starts and ends in silence (a take that starts mid-sound clips its first
// word). `--use <n>` installs a take as the scene's narration; then run scripts/audio/tempo.mjs and the mix.
//   node scripts/voice/retake.mjs proof 2          (two new takes of the proof scene)
//   node scripts/voice/retake.mjs proof --use 1    (install take 1)
import fs from "node:fs";
import path from "node:path";
import { tts } from "./tts.mjs";
import { ffmpeg } from "../lib/ffmpeg.mjs";
import { readWav } from "../lib/audio.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const voice = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/voice.json"), "utf8"));
const nar = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/narration.json"), "utf8"));
const [id, arg, n] = process.argv.slice(2);
const i = nar.scenes.findIndex((s) => s.id === id);
if (i < 0) throw new Error(`no scene ${id}`);
const dir = path.join(ROOT, "out/retakes", id);
const textOf = (sc) => sc.chunks.map((c) => c[0]).join(" ");
const sentences = (s) => s.split(/(?<=[.!?:”])\s+/);

/** Loudness (dBFS RMS) of the first and last 10 ms of a take, decoded at 48 kHz mono. */
function edges(mp3) {
  const wav = mp3.replace(/.mp3$/, ".wav");
  ffmpeg(["-y", "-i", mp3, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
  const s = readWav(wav).samples;
  const db = (a, b) => {
    let e = 0;
    for (let k = a; k < b; k++) e += s[k] ** 2;
    return 10 * Math.log10(e / Math.max(1, b - a) + 1e-12);
  };
  return { first: db(0, 480), last: db(s.length - 480, s.length), seconds: s.length / 48000 };
}

if (arg === "--use") {
  const src = path.join(dir, `${n}.mp3`);
  if (!fs.existsSync(src)) throw new Error(`no take ${src}`);
  fs.copyFileSync(src, path.join(ROOT, "public/audio/narration", `${id}.mp3`));
  fs.copyFileSync(path.join(dir, `${n}.json`), path.join(ROOT, "src/data/narration", `${id}.json`));
  console.log(`installed take ${n} of ${id}`);
} else {
  const count = Number(arg ?? 1);
  fs.mkdirSync(dir, { recursive: true });
  const have = fs.readdirSync(dir).filter((f) => f.endsWith(".mp3")).length;
  const prev = i > 0 ? sentences(textOf(nar.scenes[i - 1])).slice(-1)[0] : undefined;
  const next = i + 1 < nar.scenes.length ? sentences(textOf(nar.scenes[i + 1]))[0] : undefined;
  for (let k = have + 1; k <= have + count; k++) {
    const r = await tts({ id: String(k), text: textOf(nar.scenes[i]), voice: voice.NARRATOR, settings: voice.settings, prev, next, audioDir: dir, alignDir: dir, purpose: `retake ${id}` });
    console.log(`${id} take ${k}: billed ${r.billed}`);
  }
  // every take in the folder, so an earlier audition is compared too
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".mp3")).sort()) {
    const e = edges(path.join(dir, f));
    const ok = e.first < -50 && e.last < -50;
    console.log(`${id} take ${f.replace(".mp3", "")}: ${e.seconds.toFixed(2)} s, first 10 ms ${e.first.toFixed(0)} dB, last 10 ms ${e.last.toFixed(0)} dB${ok ? "" : "  <-- starts or ends mid-sound"}`);
  }
}
