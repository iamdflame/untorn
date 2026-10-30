// Original synthesis for the film's sound: no samples, nothing to license. A stereo buffer, RBJ biquads, a
// Freeverb-style room, and generators for a warm pad, a low pulse, and paper (tear, lift, settle, strike, tick).
export const SR = 48000;

let seed = 1234567;
export const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};
export const reseed = (s) => (seed = s >>> 0 || 1);
const nrand = () => rand() * 2 - 1;

export class Stereo {
  constructor(seconds) {
    this.n = Math.ceil(seconds * SR);
    this.L = new Float32Array(this.n);
    this.R = new Float32Array(this.n);
  }
  /** Mix a mono or stereo source in at time t (s), with gain and pan (-1 left … 1 right, equal power). */
  add(src, t, gain = 1, pan = 0) {
    const o = Math.round(t * SR);
    const a = ((pan + 1) * Math.PI) / 4;
    const gl = Math.cos(a) * gain * Math.SQRT2;
    const gr = Math.sin(a) * gain * Math.SQRT2;
    const sl = src.L ?? src;
    const sr = src.R ?? src;
    for (let i = 0; i < sl.length; i++) {
      const j = o + i;
      if (j < 0 || j >= this.n) continue;
      this.L[j] += sl[i] * gl;
      this.R[j] += sr[i] * gr;
    }
  }
}

/* ---------- filters ---------- */
export function biquad(type, f0, q = 0.707, gainDb = 0) {
  const w = (2 * Math.PI * f0) / SR;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const al = sw / (2 * q);
  const A = Math.pow(10, gainDb / 40);
  let b0, b1, b2, a0, a1, a2;
  if (type === "lp") [b0, b1, b2, a0, a1, a2] = [(1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + al, -2 * cw, 1 - al];
  else if (type === "hp") [b0, b1, b2, a0, a1, a2] = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + al, -2 * cw, 1 - al];
  else if (type === "bp") [b0, b1, b2, a0, a1, a2] = [al, 0, -al, 1 + al, -2 * cw, 1 - al];
  else if (type === "peak") [b0, b1, b2, a0, a1, a2] = [1 + al * A, -2 * cw, 1 - al * A, 1 + al / A, -2 * cw, 1 - al / A];
  else if (type === "lowshelf") {
    const s = 2 * Math.sqrt(A) * al;
    [b0, b1, b2, a0, a1, a2] = [A * (A + 1 - (A - 1) * cw + s), 2 * A * (A - 1 - (A + 1) * cw), A * (A + 1 - (A - 1) * cw - s), A + 1 + (A - 1) * cw + s, -2 * (A - 1 + (A + 1) * cw), A + 1 + (A - 1) * cw - s];
  } else if (type === "highshelf") {
    const s = 2 * Math.sqrt(A) * al;
    [b0, b1, b2, a0, a1, a2] = [A * (A + 1 + (A - 1) * cw + s), -2 * A * (A - 1 + (A + 1) * cw), A * (A + 1 + (A - 1) * cw - s), A + 1 - (A - 1) * cw + s, 2 * (A - 1 - (A + 1) * cw), A + 1 - (A - 1) * cw - s];
  }
  const c = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = c[0] * x + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}
export const filt = (arr, ...fs) => {
  for (const f of fs) for (let i = 0; i < arr.length; i++) arr[i] = f(arr[i]);
  return arr;
};

/* ---------- a small room (Freeverb topology) ---------- */
export function reverb(buf, { room = 0.82, damp = 0.35, wet = 0.22, width = 1 } = {}) {
  const combs = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617].map((d) => Math.round((d * SR) / 44100));
  const alls = [556, 441, 341, 225].map((d) => Math.round((d * SR) / 44100));
  const run = (inp, spread) => {
    const out = new Float32Array(inp.length);
    for (const d0 of combs) {
      const d = d0 + spread;
      const line = new Float32Array(d);
      let idx = 0;
      let store = 0;
      for (let i = 0; i < inp.length; i++) {
        const y = line[idx];
        store = y * (1 - damp) + store * damp;
        line[idx] = inp[i] * 0.015 + store * room;
        out[i] += y;
        if (++idx >= d) idx = 0;
      }
    }
    for (const d0 of alls) {
      const d = d0 + spread;
      const line = new Float32Array(d);
      let idx = 0;
      for (let i = 0; i < out.length; i++) {
        const bo = line[idx];
        const y = -out[i] + bo;
        line[idx] = out[i] + bo * 0.5;
        out[i] = y;
        if (++idx >= d) idx = 0;
      }
    }
    return out;
  };
  const wl = run(buf.L, 0);
  const wr = run(buf.R, 23);
  for (let i = 0; i < buf.n; i++) {
    const l = wl[i];
    const r = wr[i];
    buf.L[i] += wet * (l * (0.5 + width / 2) + r * (0.5 - width / 2));
    buf.R[i] += wet * (r * (0.5 + width / 2) + l * (0.5 - width / 2));
  }
  return buf;
}

/* ---------- envelopes ---------- */
export const adsr = (n, a, d, s, r, hold) => {
  const env = new Float32Array(n);
  const A = Math.round(a * SR);
  const D = Math.round(d * SR);
  const Hd = Math.round(hold * SR);
  const R = Math.round(r * SR);
  for (let i = 0; i < n; i++) {
    let v;
    if (i < A) v = 0.5 - 0.5 * Math.cos((Math.PI * i) / A);
    else if (i < A + D) v = 1 - (1 - s) * ((i - A) / D);
    else if (i < A + D + Hd) v = s;
    else if (i < A + D + Hd + R) v = s * (0.5 + 0.5 * Math.cos((Math.PI * (i - A - D - Hd)) / R));
    else v = 0;
    env[i] = v;
  }
  return env;
};

/* ---------- the score ---------- */
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
/** A warm pad: soft additive partials (1/n^2), slightly detuned per side, through a low-pass that breathes. */
export function padChord(notes, seconds, { attack = 2.5, release = 3, cutoff = 1400, level = 0.06, bright = 0 } = {}) {
  const out = { L: new Float32Array(Math.ceil((seconds + release) * SR)), R: null };
  out.R = new Float32Array(out.L.length);
  const n = out.L.length;
  const env = adsr(n, attack, 0.5, 0.85, release, Math.max(0, seconds - attack - 0.5));
  for (const m of notes) {
    for (const [side, det] of [
      [out.L, -0.06],
      [out.R, 0.06],
    ]) {
      const f = mtof(m + det);
      const parts = [1, 2, 3, 4, 5];
      const ph = parts.map(() => rand() * Math.PI * 2);
      const vib = 0.0025;
      for (let i = 0; i < n; i++) {
        const tt = i / SR;
        const fm = 1 + vib * Math.sin(2 * Math.PI * 0.13 * tt + det * 20);
        let s = 0;
        for (let k = 0; k < parts.length; k++) {
          const h = parts[k];
          if (f * h > 6000) break;
          s += Math.sin(2 * Math.PI * f * h * fm * tt + ph[k]) / (h * h * (1.4 - bright));
        }
        side[i] += s * env[i] * level;
      }
    }
  }
  const lfo = (i) => cutoff * (1 + 0.25 * Math.sin((2 * Math.PI * i) / SR / 7));
  // a slowly breathing low-pass (block-wise coefficient updates)
  for (const side of [out.L, out.R]) {
    let f = biquad("lp", cutoff, 0.6);
    for (let i = 0; i < n; i++) {
      if (i % 2048 === 0) f = biquad("lp", lfo(i), 0.6);
      side[i] = f(side[i]);
    }
  }
  return out;
}

/** A low, soft pulse (felt on a drum): a pitched sine dropping from 80 to 52 Hz, with a breath of noise. */
export function pulse(level = 0.25) {
  const n = Math.round(0.9 * SR);
  const out = new Float32Array(n);
  let ph = 0;
  const lp = biquad("lp", 900, 0.7);
  for (let i = 0; i < n; i++) {
    const tt = i / SR;
    const f = 52 + 28 * Math.exp(-tt * 18);
    ph += (2 * Math.PI * f) / SR;
    const env = (1 - Math.exp(-tt * 400)) * Math.exp(-tt * 4.2);
    out[i] = (Math.sin(ph) * 0.9 + lp(nrand()) * 0.06 * Math.exp(-tt * 30)) * env * level;
  }
  return out;
}

/* ---------- paper ---------- */
/** Crackle: a train of tiny resonant noise grains (the fibres parting), at a rate that follows `rate(t)`. */
function crackle(seconds, rate, { lo = 1600, hi = 6500, grain = 0.0016, level = 0.5 } = {}) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  let t = 0;
  while (t < seconds) {
    const r = Math.max(1, rate(t));
    t += -Math.log(1 - rand()) / r;
    if (t >= seconds) break;
    const f0 = lo * Math.pow(hi / lo, rand());
    const bp = biquad("bp", f0, 1.6 + rand() * 2.5);
    const g = Math.round(grain * SR * (0.6 + rand() * 1.4));
    const amp = level * (0.35 + rand() * 0.9);
    const o = Math.round(t * SR);
    for (let i = 0; i < g * 6 && o + i < n; i++) out[o + i] += bp(nrand() * Math.exp(-i / g)) * amp;
  }
  return out;
}

/** A sheet tearing, about `seconds` long: crackle that builds and runs out, over a low body. */
export function tear(seconds = 0.75, level = 0.6) {
  const n = Math.round(seconds * SR);
  const env = (t) => Math.sin(Math.PI * Math.min(1, t / seconds)) ** 0.6;
  const c = crackle(seconds, (t) => 250 + 1400 * env(t), { level: 0.55 });
  const body = new Float32Array(n);
  const bp = biquad("bp", 520, 0.8);
  const bp2 = biquad("bp", 2400, 0.9);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const e = env(t);
    body[i] = (bp(nrand()) * 0.28 + bp2(nrand()) * 0.12) * e;
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (c[i] + body[i]) * level;
  return filt(out, biquad("hp", 140, 0.7), biquad("highshelf", 7000, 0.7, -4));
}

/** Paper lifting: a short airy rustle. */
export function lift(level = 0.12) {
  const dur = 0.32;
  const n = Math.round(dur * SR);
  const out = new Float32Array(n);
  const bp = biquad("bp", 2600, 0.9);
  const c = crackle(dur, (t) => 40 + 260 * Math.sin((Math.PI * t) / dur), { level: 0.25, lo: 2000, hi: 7000 });
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = (bp(nrand()) * 0.5 * Math.sin((Math.PI * t) / dur) ** 1.5 + c[i]) * level;
  }
  return out;
}

/** Paper settling on the glass: a soft low tap and a short crinkle. */
export function settleSound(level = 0.22) {
  const dur = 0.22;
  const n = Math.round(dur * SR);
  const out = new Float32Array(n);
  const lp = biquad("lp", 380, 0.9);
  const c = crackle(0.09, (t) => 600 * Math.exp(-t * 30), { level: 0.25, lo: 1800, hi: 5000 });
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = (lp(nrand()) * 1.6 * Math.exp(-t * 55) + (c[i] ?? 0)) * level;
  }
  return out;
}

/** A soft tick: a read lands. Clean, quiet, high. */
export function tick(level = 0.08, f = 2350) {
  const dur = 0.09;
  const n = Math.round(dur * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = (Math.sin(2 * Math.PI * f * t) * 0.8 + Math.sin(2 * Math.PI * f * 2.01 * t) * 0.15) * Math.exp(-t * 70) * (1 - Math.exp(-t * 4000)) * level;
  }
  return out;
}

/** A pencil strike across paper. */
export function strike(level = 0.18) {
  const dur = 0.26;
  const c = crackle(dur, (t) => 900 + 2500 * Math.sin((Math.PI * t) / dur), { lo: 2500, hi: 8000, grain: 0.0009, level: 0.5 });
  const n = c.length;
  const out = new Float32Array(n);
  const bp = biquad("bp", 4200, 1.2);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = (c[i] + bp(nrand()) * 0.35 * Math.sin((Math.PI * t) / dur)) * level;
  }
  return out;
}

/** A broad, slow swell of air (for the pull-apart and the wipe). */
export function swell(seconds = 1.2, level = 0.1, f = 1200) {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  const bp = biquad("bp", f, 0.6);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = bp(nrand()) * Math.sin((Math.PI * t) / seconds) ** 2 * level;
  }
  return out;
}
