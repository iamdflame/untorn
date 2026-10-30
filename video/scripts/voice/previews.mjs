// Step 4a of the voice search: the shortlist's free preview clips, downloaded and measured (no characters spent).
// Speaking rate from Meta's transcript over the speech span, pitch movement (YIN), pauses, noise floor and clipping.
//   node scripts/voice/previews.mjs  ->  out/voice-auditions/previews/*.mp3|wav, previews.json
import fs from "node:fs";
import path from "node:path";
import { levels, pitchStats, readWav, speechSegments } from "../lib/audio.mjs";
import { toWav } from "../lib/ffmpeg.mjs";
import { transcribe } from "./transcribe.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const OUT = path.join(ROOT, "out", "voice-auditions");
const DIR = path.join(OUT, "previews");
fs.mkdirSync(DIR, { recursive: true });

// The shortlist: English narration, by fit to the brand (calm, exact, humane; documentary gravity without bombast;
// mature, warm, unhurried) and by crowd evidence (usage and clones in the narration categories). George is the
// account's premade storyteller (no public usage figures).
export const SHORTLIST = [
  { id: "MFZUKuGQUsGJPQjTS4wC", short: "jon" },
  { id: "G17SuINrv2H9FC6nvetn", short: "christopher" },
  { id: "ZthjuvLPty3kTMaNKVKb", short: "peter" },
  { id: "uju3wxzG5OhpWcoi3SMy", short: "michael" },
  { id: "j9jfwdrw7BRfcR43Qohk", short: "frederick" },
  { id: "lxYfHSkYm1EzQzGhdbfc", short: "jessica" },
  { id: "RILOU7YmBhvwJGDGjNmP", short: "jane" },
  { id: "JBFqnCBsd6RMkjVDRZzb", short: "george" },
];

if (process.argv[1] && process.argv[1].endsWith("previews.mjs")) {
  const cands = JSON.parse(fs.readFileSync(path.join(OUT, "candidates.json"), "utf8"));
  const rows = [];
  for (const s of SHORTLIST) {
    const c = cands.find((x) => x.id === s.id);
    if (!c?.preview_url) {
      console.log("no preview for", s.short);
      continue;
    }
    const mp3 = path.join(DIR, `${s.short}.mp3`);
    if (!fs.existsSync(mp3)) {
      const r = await fetch(c.preview_url, { headers: { "User-Agent": "video-build/1.0" } });
      fs.writeFileSync(mp3, Buffer.from(await r.arrayBuffer()));
    }
    const wav = toWav(mp3, path.join(DIR, `${s.short}.wav`), 24000);
    const { samples, rate } = readWav(wav);
    const sp = speechSegments(samples, rate);
    const span = sp.segments.length ? sp.segments[sp.segments.length - 1][1] - sp.segments[0][0] : 0;
    const pauses = sp.segments.slice(1).map((seg, i) => +(seg[0] - sp.segments[i][1]).toFixed(2)).filter((g) => g >= 0.15);
    const pitch = pitchStats(samples, rate);
    const lv = levels(samples);
    let asr = null;
    try {
      asr = await transcribe(wav);
    } catch (e) {
      console.log("asr failed", s.short, String(e).slice(0, 200));
    }
    const words = asr?.transcript ? asr.transcript.split(/\s+/).filter(Boolean).length : null;
    const row = {
      voice: s.short,
      id: s.id,
      name: c.name,
      accent: c.accent,
      gender: c.gender,
      age: c.age,
      usage_1y: c.usage_1y,
      cloned_by: c.cloned_by,
      seconds: +(samples.length / rate).toFixed(2),
      speechSpan: +span.toFixed(2),
      words,
      wpm: words && span ? Math.round((words / span) * 60) : null,
      pauses: pauses.length,
      meanPause: pauses.length ? +(pauses.reduce((a, b) => a + b, 0) / pauses.length).toFixed(2) : null,
      pitch,
      noiseFloorDb: +sp.floorDb.toFixed(1),
      ...lv,
      transcript: asr?.transcript ?? null,
    };
    rows.push(row);
    console.log(`${s.short.padEnd(12)} ${String(row.wpm).padStart(4)} wpm | pitch spread ${pitch.spreadSt} st (sd ${pitch.sdSt}, median ${pitch.medianHz} Hz) | pauses ${row.pauses} (mean ${row.meanPause}s) | floor ${row.noiseFloorDb} dB | peak ${lv.peakDb} dB | clip ${lv.clippedSamples} | ${row.seconds}s`);
  }
  fs.writeFileSync(path.join(OUT, "previews.json"), JSON.stringify(rows, null, 1));
}
