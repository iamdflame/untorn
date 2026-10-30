// The film's soundtrack, mixed offline: the narration where the timeline places it, an original pad score that drops
// out for the two beats of silence, paper sounds on the picture's own cues, the music ducked under the voice, then
// normalised to about -14 LUFS integrated with the true peak held under -1 dBTP.
//   node_modules/.bin/tsx scripts/audio/mix.mts   ->  public/audio/mix.wav (48 kHz stereo) + out/mix-report.json
import fs from "node:fs";
import path from "node:path";
import { buildTimeline } from "../../src/film/timeline";
import { sfxCues } from "../../src/film/sfx";
import { lufs, readWav, truePeak, writeWav } from "../lib/audio.mjs";
import { SR, Stereo, biquad, lift, padChord, pulse, reseed, reverb, settleSound, strike, swell, tear, tick } from "./synth.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const tl = buildTimeline();
const total = tl.total + 0.5;
const { cues, sections, silences } = sfxCues(tl);
reseed(20261030);

/* ---------- voice ---------- */
const voice = new Stereo(total);
const cache = new Map<string, Float32Array>();
const load = (scene: string) => {
  if (!cache.has(scene)) {
    const w = readWav(path.join(ROOT, "public/audio/narration", `${scene}.wav`));
    if (w.rate !== SR) throw new Error(`narration ${scene} is ${w.rate} Hz, expected ${SR}`);
    cache.set(scene, w.samples);
  }
  return cache.get(scene)!;
};
for (const c of tl.clips) {
  const src = load(c.scene);
  const a = Math.max(0, Math.round(c.from * SR));
  const b = Math.min(src.length, Math.round(c.to * SR));
  const seg = src.slice(a, b);
  const fade = Math.round(0.012 * SR);
  for (let i = 0; i < fade && i < seg.length; i++) {
    seg[i] *= i / fade;
    seg[seg.length - 1 - i] *= i / fade;
  }
  voice.add(seg, c.at, 1, 0);
}
// a touch of presence and a gentle low cut on the voice
for (const side of [voice.L, voice.R]) {
  const hp = biquad("hp", 75, 0.7);
  const pres = biquad("peak", 3200, 0.9, 1.5);
  const low = biquad("lowshelf", 180, 0.7, -1.5);
  for (let i = 0; i < side.length; i++) side[i] = low(pres(hp(side[i])));
}

/* ---------- score ---------- */
const music = new Stereo(total);
sections.forEach((s, i) => {
  const next = sections[i + 1]?.t ?? total;
  const dur = Math.max(1.5, next - s.t + 1.2);
  const pad = padChord(s.chord, dur, { attack: i === 0 ? 1.2 : 2.2, release: 2.8, cutoff: 1300 + 500 * (s.bright ?? 0), level: 0.05 * (s.level ?? 0.7), bright: s.bright ?? 0 });
  music.add(pad, s.t - 0.4, 1, 0);
});
for (const c of cues.filter((q) => q.kind === "pulse")) music.add(pulse(0.35 * (c.gain ?? 1)), c.t, 1, 0);
reverb(music, { room: 0.86, damp: 0.4, wet: 0.35, width: 1 });
// silences: the score drops away for the beat before 847 and before the twins' verdict (and comes back softly)
const gainAt = new Float32Array(music.n).fill(1);
for (const [a, b] of silences) {
  const A = Math.round(a * SR);
  const B = Math.round(b * SR);
  const fo = Math.round(0.35 * SR);
  const fi = Math.round(0.9 * SR);
  for (let i = Math.max(0, A - fo); i < Math.min(music.n, B + fi); i++) {
    let gn = 1;
    if (i < A) gn = 1 - (i - (A - fo)) / fo;
    else if (i < B) gn = 0;
    else gn = (i - B) / fi;
    gainAt[i] = Math.min(gainAt[i], Math.max(0, gn));
  }
}

/* ---------- paper ---------- */
const fx = new Stereo(total);
for (const c of cues) {
  const g = c.gain ?? 1;
  const pan = c.pan ?? 0;
  if (c.kind === "tear") fx.add(tear(c.dur ?? 0.6, 0.55), c.t, g, pan);
  else if (c.kind === "lift") fx.add(lift(0.16), c.t, g, pan);
  else if (c.kind === "settle") fx.add(settleSound(0.26), c.t, g, pan);
  else if (c.kind === "tick") fx.add(tick(0.07), c.t, g, pan);
  else if (c.kind === "strike") fx.add(strike(0.2), c.t, g, pan);
  else if (c.kind === "swell") fx.add(swell(c.dur ?? 1.2, 0.08), c.t, g, pan);
  else if (c.kind === "trace") fx.add(strike(0.05), c.t, g * 0.6, pan);
}
reverb(fx, { room: 0.7, damp: 0.5, wet: 0.16, width: 0.8 });

/* ---------- duck the score under the voice ---------- */
const env = new Float32Array(voice.n);
{
  const atk = Math.exp(-1 / (0.012 * SR));
  const rel = Math.exp(-1 / (0.35 * SR));
  let e = 0;
  for (let i = 0; i < voice.n; i++) {
    const x = Math.max(Math.abs(voice.L[i]), Math.abs(voice.R[i]));
    e = x > e ? atk * e + (1 - atk) * x : rel * e + (1 - rel) * x;
    env[i] = e;
  }
}
// hold the duck through short gaps between words
const hold = Math.round(0.25 * SR);
const duckEnv = new Float32Array(voice.n);
let run = 0;
for (let i = 0; i < voice.n; i++) {
  run = env[i] > 0.02 ? hold : Math.max(0, run - 1);
  duckEnv[i] = run > 0 ? 1 : 0;
}
// smooth the on/off into a gain: -10 dB under the voice
const duck = new Float32Array(voice.n);
{
  let gdb = 0;
  const down = 1 - Math.exp(-1 / (0.06 * SR));
  const up = 1 - Math.exp(-1 / (0.5 * SR));
  for (let i = 0; i < voice.n; i++) {
    const target = duckEnv[i] ? -10 : 0;
    gdb += (target - gdb) * (target < gdb ? down : up);
    duck[i] = Math.pow(10, gdb / 20);
  }
}

/* ---------- sum, loudness, limiter ---------- */
const VOICE_G = 1.0;
const MUSIC_G = 1.8;
const FX_G = 0.9;
const L = new Float32Array(voice.n);
const R = new Float32Array(voice.n);
for (let i = 0; i < voice.n; i++) {
  const mg = MUSIC_G * duck[i] * gainAt[i];
  L[i] = voice.L[i] * VOICE_G + music.L[i] * mg + fx.L[i] * FX_G;
  R[i] = voice.R[i] * VOICE_G + music.R[i] * mg + fx.R[i] * FX_G;
}
const TARGET = -14;
const before = lufs([L, R], SR);
const L0 = Float32Array.from(L);
const R0 = Float32Array.from(R);
/** Gain to the target, then the limiter; a second pass corrects for what the limiter took off. */
function master(gainDb: number) {
  const gn = Math.pow(10, gainDb / 20);
  for (let i = 0; i < L.length; i++) {
    L[i] = L0[i] * gn;
    R[i] = R0[i] * gn;
  }
  limit();
}
// look-ahead peak limiter (linked stereo): ceiling -2.4 dBFS (true peak lands under -1 dBTP), 5 ms look-ahead
function limit() {
  const ceil = Math.pow(10, -2.4 / 20);
  const look = Math.round(0.005 * SR);
  const relC = Math.exp(-1 / (0.12 * SR));
  const need = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) {
    const p = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    need[i] = p > ceil ? ceil / p : 1;
  }
  // minimum over the look-ahead window, then a smooth release
  const gmin = new Float32Array(L.length);
  const dq: number[] = [];
  for (let i = L.length - 1; i >= 0; i--) {
    while (dq.length && need[dq[dq.length - 1]] >= need[i]) dq.pop();
    dq.push(i);
    while (dq[0] > i + look) dq.shift();
    gmin[i] = need[dq[0]];
  }
  let gcur = 1;
  for (let i = 0; i < L.length; i++) {
    gcur = gmin[i] < gcur ? gmin[i] : relC * gcur + (1 - relC) * gmin[i];
    L[i] *= gcur;
    R[i] *= gcur;
  }
}
let gDb = TARGET - before;
master(gDb);
const pass1 = lufs([L, R], SR);
gDb += TARGET - pass1;
master(gDb);
const after = lufs([L, R], SR);
const tp = truePeak([L, R]);
fs.mkdirSync(path.join(ROOT, "public/audio"), { recursive: true });
writeWav(path.join(ROOT, "public/audio/mix.wav"), [L, R], SR);
// stems' loudness for the report (voice on top?)
const vL = lufs([voice.L, voice.R], SR);
const mm = new Float32Array(voice.n);
for (let i = 0; i < voice.n; i++) mm[i] = (music.L[i] + music.R[i]) * 0.5 * duck[i] * gainAt[i];
const mL = lufs([mm], SR);
const report = { seconds: +(L.length / SR).toFixed(2), targetLufs: TARGET, integratedBefore: +before.toFixed(2), integratedAfter: +after.toFixed(2), truePeakDbtp: +tp.toFixed(2), voiceStemLufs: +vL.toFixed(2), musicStemDuckedLufs: +mL.toFixed(2), cues: cues.length, sections: sections.length, silences };
fs.mkdirSync(path.join(ROOT, "out"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "out/mix-report.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report));
