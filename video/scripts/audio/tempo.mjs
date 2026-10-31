// The narration for the mix: each scene's MP3 decoded to 48 kHz mono WAV, at the voice.json "tempo". At 1 (the
// default) no filter touches the voice; any other value time-stretches with ffmpeg's atempo (pitch kept), and the
// alignment is scaled by the same factor in src/film/align.ts.
//   node scripts/audio/tempo.mjs
import fs from "node:fs";
import path from "node:path";
import { ffmpeg } from "../lib/ffmpeg.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const voice = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/voice.json"), "utf8"));
const tempo = voice.tempo ?? 1;
const dir = path.join(ROOT, "public/audio/narration");
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".mp3"))) {
  const out = path.join(dir, f.replace(/\.mp3$/, ".wav"));
  const stretch = tempo === 1 ? [] : ["-filter:a", `atempo=${tempo}`];
  ffmpeg(["-y", "-i", path.join(dir, f), ...stretch, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", out]);
  console.log(out, "tempo", tempo);
}
