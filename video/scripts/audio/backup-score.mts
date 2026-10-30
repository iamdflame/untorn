// The backup cut's quiet score: the film's pad voice, one chord per part of the walkthrough, a soft settle where the
// live run's page comes home, mastered quietly (no narration to carry, so it sits at about -20 LUFS).
//   node_modules/.bin/tsx scripts/audio/backup-score.mts   ->  public/audio/backup.wav (48 kHz stereo)
import fs from "node:fs";
import path from "node:path";
import { BACKUP, BACKUP_STARTS, BACKUP_TOTAL } from "../../src/film/backupEdit";
import { lufs, truePeak, writeWav } from "../lib/audio.mjs";
import { SR, Stereo, padChord, reseed, reverb, settleSound } from "./synth.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
reseed(20261031);
const total = BACKUP_TOTAL + 1.5;
const music = new Stereo(total);
const fx = new Stereo(total);

// chords by part: the first screen (D minor colours), the twins (suspended), tear your own (opening to F),
// the result and the numbers (warm), the end card (resolved)
const chordFor = (i: number): number[] => {
  const s = BACKUP[i];
  if (s.kind === "hero") return i === 0 ? [38, 50, 57, 62, 65] : [38, 50, 55, 62, 64];
  if (s.kind === "golden" || s.kind === "phone") return i < 7 ? [41, 53, 57, 60, 65] : [43, 55, 59, 62, 67];
  if (s.kind === "page") return [41, 53, 57, 64, 69];
  return [38, 50, 57, 62, 66];
};
for (let i = 0; i < BACKUP.length; i++) {
  const t0 = BACKUP_STARTS[i];
  const dur = BACKUP_STARTS[i + 1] - t0 + 1.4;
  music.add(padChord(chordFor(i), dur, { attack: i === 0 ? 1.5 : 1.8, release: 2.6, cutoff: 1250, level: 0.04 }), Math.max(0, t0 - 0.5), 1, 0);
}
// a soft settle on each cut into the live run's assembly and on the end card
BACKUP.forEach((s, i) => {
  if (s.kind === "card") fx.add(settleSound(0.22), BACKUP_STARTS[i] + 0.35, 0.8, 0);
});
reverb(music, { room: 0.86, damp: 0.4, wet: 0.35, width: 1 });

const L = new Float32Array(music.n);
const R = new Float32Array(music.n);
for (let i = 0; i < music.n; i++) {
  L[i] = music.L[i] + fx.L[i] * 0.9;
  R[i] = music.R[i] + fx.R[i] * 0.9;
}
// fade the tail
const fade = Math.round(1.2 * SR);
for (let i = 0; i < fade; i++) {
  const g = i / fade;
  L[L.length - 1 - i] *= g;
  R[R.length - 1 - i] *= g;
}
const TARGET = -20;
const before = lufs([L, R], SR);
const gain = Math.pow(10, (TARGET - before) / 20);
for (let i = 0; i < L.length; i++) {
  L[i] *= gain;
  R[i] *= gain;
}
const tp = truePeak([L, R]);
if (tp > -1) throw new Error(`true peak ${tp.toFixed(2)} dBTP: lower the target`);
fs.mkdirSync(path.join(ROOT, "public/audio"), { recursive: true });
writeWav(path.join(ROOT, "public/audio/backup.wav"), [L, R], SR);
console.log(JSON.stringify({ seconds: +(L.length / SR).toFixed(2), lufs: +lufs([L, R], SR).toFixed(2), truePeakDbtp: +tp.toFixed(2) }));
