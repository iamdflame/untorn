// The narration at the film's tempo: each scene's MP3 time-stretched with ffmpeg's atempo (pitch kept) and written
// as 48 kHz WAV for the mix. The alignment is scaled by the same factor in src/film/align.ts (voice.json "tempo").
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
  ffmpeg(["-y", "-i", path.join(dir, f), "-filter:a", `atempo=${tempo}`, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", out]);
  console.log(out, "tempo", tempo);
}
