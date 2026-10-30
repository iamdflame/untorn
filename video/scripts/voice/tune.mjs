// Settings tuning on one line before the full pass (the gravity line): stability and speed variants for the chosen
// narrator, scored on rate, pitch movement, pauses and a Meta speech-to-text round trip.
//   node scripts/voice/tune.mjs generate | score
import fs from "node:fs";
import path from "node:path";
import { levels, pitchStats, readWav } from "../lib/audio.mjs";
import { toWav } from "../lib/ffmpeg.mjs";
import { letterWords, pauseScore } from "./audition.mjs";
import { transcribe, wer } from "./transcribe.mjs";
import { tts } from "./tts.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const voice = JSON.parse(fs.readFileSync(path.join(ROOT, "src/data/voice.json"), "utf8"));
const DIR = path.join(ROOT, "out", "voice-auditions", "tuning");
const LINE = "At this pace, Germany's auditors say it would take about eight hundred and forty-seven years.";
const VARIANTS = {
  "s50-v100": { stability: 0.5, similarity_boost: 0.75, speed: 1.0 },
  "s65-v094": { stability: 0.65, similarity_boost: 0.75, speed: 0.94 },
  "s35-v094": { stability: 0.35, similarity_boost: 0.75, speed: 0.94 },
};

const [cmd] = process.argv.slice(2);
if (cmd === "generate") {
  for (const [id, settings] of Object.entries(VARIANTS)) {
    if (fs.existsSync(path.join(DIR, `${id}.mp3`))) continue;
    console.log(JSON.stringify(await tts({ id, text: LINE, voice: voice.NARRATOR, settings, audioDir: DIR, alignDir: DIR, purpose: "tuning" })));
  }
} else if (cmd === "score") {
  const rows = [];
  for (const id of Object.keys(VARIANTS)) {
    const al = JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), "utf8"));
    const words = letterWords(al.alignment);
    const span = words[words.length - 1].end - words[0].start;
    const wav = toWav(path.join(DIR, `${id}.mp3`), path.join(DIR, `${id}.wav`), 24000);
    const { samples, rate } = readWav(wav);
    const p = pitchStats(samples, rate);
    const ps = pauseScore(words);
    const asr = await transcribe(wav);
    const w = wer(LINE.replace("eight hundred and forty-seven", "847"), asr.transcript);
    rows.push({ id, wpm: Math.round((words.length / span) * 60), seconds: +span.toFixed(2), pitchSdSt: p.sdSt, pauses: ps.gaps.map((g) => `${g.after} ${g.gap}s`).join(", "), peakDb: levels(samples).peakDb, wer: +(w.wer * 100).toFixed(1), asr: asr.transcript });
  }
  for (const r of rows) console.log(JSON.stringify(r));
  fs.writeFileSync(path.join(DIR, "tuning.json"), JSON.stringify(rows, null, 1));
}
