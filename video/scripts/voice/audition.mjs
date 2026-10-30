// Step 4b-5 of the voice search: the finalists read the same two lines (the cold open and the 847-years line) on
// eleven_v4 with identical settings; each take is scored on rate, pitch movement, pauses at punctuation, noise
// floor and clipping, character cost, and a round trip through Meta's speech-to-text.
//   node scripts/voice/audition.mjs generate <voice...>   (spends characters; skips takes that exist)
//   node scripts/voice/audition.mjs score                   (free apart from a few seconds of Meta transcription)
import fs from "node:fs";
import path from "node:path";
import { levels, pitchStats, readWav, speechSegments } from "../lib/audio.mjs";
import { toWav } from "../lib/ffmpeg.mjs";
import { transcribe, wer } from "./transcribe.mjs";
import { tts } from "./tts.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "../..");
const OUT = path.join(ROOT, "out", "voice-auditions");
const TAKES = path.join(OUT, "takes");

export const FINALISTS = {
  jon: "MFZUKuGQUsGJPQjTS4wC",
  christopher: "G17SuINrv2H9FC6nvetn",
  frederick: "j9jfwdrw7BRfcR43Qohk",
  peter: "ZthjuvLPty3kTMaNKVKb",
  jane: "RILOU7YmBhvwJGDGjNmP",
};
export const LINES = [
  "Untorn puts torn documents back together from a single photo. Meta's SAM three point one cuts out every piece, and Muse reads the half-words across each tear, like a crossword.",
  "At this pace, Germany's federal auditors put the job at about eight hundred and forty-seven years.",
];
export const TEXT = LINES.join("\n\n");
export const SETTINGS = { stability: 0.5, similarity_boost: 0.75, speed: 1.0 };

/** Words timed letter to letter: ElevenLabs folds a pause into the punctuation characters' spans, so a word ends at
 * its last letter or digit and the next starts at its first. */
export function letterWords(al) {
  const { characters: ch, character_start_times_seconds: st, character_end_times_seconds: en } = al;
  const words = [];
  let cur = null;
  ch.forEach((c, i) => {
    if (/\s/.test(c)) {
      if (cur) words.push(cur);
      cur = null;
      return;
    }
    if (!cur) cur = { text: "", start: null, end: null };
    cur.text += c;
    if (/[\p{L}\p{N}]/u.test(c)) {
      if (cur.start == null) cur.start = st[i];
      cur.end = en[i];
    }
  });
  if (cur) words.push(cur);
  return words.filter((w) => w.start != null);
}

/** Pauses (200 ms or more, letter to letter) and where they fall. */
export function pauseScore(words) {
  const punct = (w) => /[.,;:!?—–]$/.test(w.text);
  let atPunct = 0;
  let elsewhere = 0;
  let punctTotal = 0;
  const gaps = [];
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].start - words[i].end;
    const p = punct(words[i]);
    if (p) punctTotal++;
    if (gap >= 0.2) {
      gaps.push({ after: words[i].text, gap: +gap.toFixed(2), punct: p });
      if (p) atPunct++;
      else elsewhere++;
    }
  }
  return { pauses: atPunct + elsewhere, atPunctuation: atPunct, elsewhere, punctuationHonoured: `${atPunct}/${punctTotal}`, gaps };
}

/** Reference words missing from the transcript (the brand and model names matter most). */
function misheard(ref, hyp) {
  const n = (x) => x.toLowerCase().replace(/[’']/g, "").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const h = new Set(n(hyp));
  return [...new Set(n(ref).filter((w) => !h.has(w)))];
}

/** Collapse a word the transcript repeats across a turn boundary ("Germany's Germany's"); re-transcribing the
 * segment alone reads it once, so it is an artifact of the endpointing, not of the take. */
const collapseRepeats = (s) => {
  const out = [];
  for (const w of s.split(/\s+/)) {
    const k = w.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "");
    const prev = out.length ? out[out.length - 1].toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "") : null;
    if (k && k === prev) continue;
    out.push(w);
  }
  return out.join(" ");
};

async function generate(names) {
  for (const name of names) {
    const voice = FINALISTS[name];
    if (!voice) throw new Error(`unknown finalist ${name}`);
    if (fs.existsSync(path.join(TAKES, `${name}.mp3`))) {
      console.log("exists", name);
      continue;
    }
    const r = await tts({ id: name, text: TEXT, voice, settings: SETTINGS, audioDir: TAKES, alignDir: TAKES, purpose: "audition" });
    console.log(JSON.stringify(r));
  }
}

async function score() {
  const rows = [];
  const ledger = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "data", "elevenlabs-ledger.json"), "utf8"));
  for (const name of Object.keys(FINALISTS)) {
    const mp3 = path.join(TAKES, `${name}.mp3`);
    if (!fs.existsSync(mp3)) continue;
    const al = JSON.parse(fs.readFileSync(path.join(TAKES, `${name}.json`), "utf8"));
    const words = letterWords(al.alignment);
    const span = words[words.length - 1].end - words[0].start;
    const split = words.findIndex((w) => w.text === "At");
    const l1 = words.slice(0, split);
    const l2 = words.slice(split);
    const rate = (ws) => Math.round((ws.length / (ws[ws.length - 1].end - ws[0].start)) * 60);
    const wav = toWav(mp3, path.join(TAKES, `${name}.wav`), 24000);
    const { samples, rate: sr } = readWav(wav);
    const pitch = pitchStats(samples, sr);
    const lv = levels(samples);
    const sp = speechSegments(samples, sr);
    // the transcription is not deterministic, so each take is transcribed three times: median WER, and the words
    // misheard in at least two of the three runs
    const cache = path.join(TAKES, `${name}.asr.json`);
    let asr = null;
    let w = null;
    try {
      const c = fs.existsSync(cache) ? JSON.parse(fs.readFileSync(cache, "utf8")) : {};
      const runs = c.runs ?? (c.transcript ? [c.transcript] : []);
      while (runs.length < 3) runs.push((await transcribe(wav)).transcript);
      fs.writeFileSync(cache, JSON.stringify({ runs }));
      const ref = TEXT.replace("SAM three point one", "Sam 3.1").replace("eight hundred and forty-seven", "847");
      const scored = runs.map((t) => {
        const hyp = collapseRepeats(t.replace(/\bSAM\b/g, "Sam").replace(/'s's/g, "'s"));
        return { t, ...wer(ref, hyp), misheard: misheard(ref, hyp) };
      });
      scored.sort((x, y) => x.wer - y.wer);
      const counts = new Map();
      scored.forEach((s) => s.misheard.forEach((m) => counts.set(m, (counts.get(m) ?? 0) + 1)));
      asr = { transcript: scored[1].t };
      w = { wer: scored[1].wer, misheard: [...counts].filter(([, n]) => n >= 2).map(([m]) => m), runs: scored.map((s) => +(s.wer * 100).toFixed(1)) };
    } catch (e) {
      console.log("asr failed", name, String(e).slice(0, 160));
    }
    const ps = pauseScore(words);
    const row = {
      voice: name,
      id: FINALISTS[name],
      seconds: +(samples.length / sr).toFixed(2),
      wpm: Math.round((words.length / span) * 60),
      wpmLine1: rate(l1),
      wpmLine2: rate(l2),
      pitchSpreadSt: pitch.spreadSt,
      pitchSdSt: pitch.sdSt,
      medianHz: pitch.medianHz,
      ...ps,
      noiseFloorDb: +sp.floorDb.toFixed(1),
      peakDb: lv.peakDb,
      clippedSamples: lv.clippedSamples,
      creditsBilled: ledger.filter((e) => e.purpose === "audition" && e.id === name).at(-1)?.billed ?? null,
      asrWer: w ? +(w.wer * 100).toFixed(1) : null,
      asrWerRuns: w?.runs ?? null,
      misheard: w?.misheard ?? null,
      asr: asr?.transcript ?? null,
    };
    rows.push(row);
    console.log(`${name.padEnd(12)} ${row.wpm} wpm (L1 ${row.wpmLine1}, L2 ${row.wpmLine2}) | pitch p10-p90 ${row.pitchSpreadSt} st, sd ${row.pitchSdSt} st, median ${row.medianHz} Hz | pauses: ${ps.atPunctuation} at punctuation (${ps.punctuationHonoured}), ${ps.elsewhere} mid-phrase | floor ${row.noiseFloorDb} dB | peak ${row.peakDb} dB | clip ${row.clippedSamples} | ${row.creditsBilled} credits | WER ${row.asrWer}% (runs ${JSON.stringify(row.asrWerRuns)}) misheard ${JSON.stringify(row.misheard)}`);
    console.log("   pauses:", ps.gaps.map((g) => `${g.after}${g.punct ? "" : "*"} ${g.gap}s`).join(" | "));
  }
  fs.writeFileSync(path.join(OUT, "auditions.json"), JSON.stringify(rows, null, 1));
}

// the command line runs only when this file is run directly: importing it for its helpers must never spend characters
const self = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "generate") await generate(rest.length ? rest : Object.keys(FINALISTS));
  else if (cmd === "score") await score();
  else if (cmd === "text") console.log(TEXT.length, "characters per take\n" + TEXT);
  else console.log("usage: audition.mjs generate [names] | score | text");
}
