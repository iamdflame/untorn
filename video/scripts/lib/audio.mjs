// Small, dependency-free audio tools: WAV read/write, frame energy, a voice-activity split, a YIN pitch track,
// clipping and noise floor, and an ITU-R BS.1770-4 loudness meter (K-weighting, 400 ms blocks, gating).
import fs from "node:fs";

export function readWav(file) {
  const b = fs.readFileSync(file);
  if (b.toString("ascii", 0, 4) !== "RIFF" || b.toString("ascii", 8, 12) !== "WAVE") throw new Error(`not a WAV: ${file}`);
  let p = 12;
  let fmt = null;
  let data = null;
  while (p + 8 <= b.length) {
    const id = b.toString("ascii", p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === "fmt ") fmt = { format: b.readUInt16LE(p + 8), channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === "data") data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`bad WAV: ${file}`);
  const n = Math.floor(data.length / (fmt.bits / 8) / fmt.channels);
  const ch = Array.from({ length: fmt.channels }, () => new Float32Array(n));
  for (let i = 0; i < n; i++)
    for (let c = 0; c < fmt.channels; c++) {
      const o = (i * fmt.channels + c) * (fmt.bits / 8);
      ch[c][i] = fmt.format === 3 ? data.readFloatLE(o) : fmt.bits === 16 ? data.readInt16LE(o) / 32768 : fmt.bits === 24 ? (data.readIntLE(o, 3) / 8388608) : data.readInt32LE(o) / 2147483648;
    }
  return { rate: fmt.rate, channels: ch, samples: ch[0] };
}

/** Write float channels as 16-bit PCM (dithered) or 32-bit float WAV. */
export function writeWav(file, channels, rate, { float = false } = {}) {
  const nch = channels.length;
  const n = channels[0].length;
  const bps = float ? 4 : 2;
  const buf = Buffer.alloc(44 + n * nch * bps);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * nch * bps, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(float ? 3 : 1, 20);
  buf.writeUInt16LE(nch, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * nch * bps, 28);
  buf.writeUInt16LE(nch * bps, 32);
  buf.writeUInt16LE(bps * 8, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * nch * bps, 40);
  let o = 44;
  for (let i = 0; i < n; i++)
    for (let c = 0; c < nch; c++) {
      const v = channels[c][i];
      if (float) buf.writeFloatLE(v, o);
      else {
        const d = (Math.random() - Math.random()) / 32768; // TPDF dither
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((v + d) * 32767))), o);
      }
      o += bps;
    }
  fs.writeFileSync(file, buf);
}

const db = (x) => 20 * Math.log10(Math.max(x, 1e-9));

/** RMS per frame (dBFS), frames of `win` s every `hop` s. */
export function frameDb(x, rate, win = 0.02, hop = 0.01) {
  const W = Math.round(win * rate);
  const Hh = Math.round(hop * rate);
  const out = [];
  for (let i = 0; i + W <= x.length; i += Hh) {
    let s = 0;
    for (let j = 0; j < W; j++) s += x[i + j] * x[i + j];
    out.push(db(Math.sqrt(s / W)));
  }
  return { db: out, hop };
}

const pct = (arr, p) => {
  const a = [...arr].sort((u, v) => u - v);
  return a[Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))))];
};

/** Speech segments from frame energy: on above (noise floor + 14 dB, at least -48 dBFS), gaps under 100 ms bridged. */
export function speechSegments(x, rate) {
  const { db: e, hop } = frameDb(x, rate);
  const floor = pct(e, 5);
  const th = Math.max(floor + 14, -48);
  const segs = [];
  let on = -1;
  e.forEach((v, i) => {
    if (v > th && on < 0) on = i;
    if ((v <= th || i === e.length - 1) && on >= 0) {
      segs.push([on * hop, i * hop]);
      on = -1;
    }
  });
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s[0] - last[1] < 0.1) last[1] = s[1];
    else merged.push([...s]);
  }
  const speech = merged.filter((s) => s[1] - s[0] > 0.05);
  return { floorDb: floor, threshold: th, segments: speech };
}

/** YIN pitch track (60-320 Hz) on voiced frames; returns semitone statistics around the median. */
export function pitchStats(x, rate) {
  const W = Math.round(0.04 * rate);
  const hop = Math.round(0.01 * rate);
  const tauMin = Math.floor(rate / 320);
  const tauMax = Math.ceil(rate / 60);
  const f0 = [];
  const d = new Float32Array(tauMax + 1);
  for (let i = 0; i + W + tauMax < x.length; i += hop) {
    let energy = 0;
    for (let j = 0; j < W; j++) energy += x[i + j] * x[i + j];
    if (db(Math.sqrt(energy / W)) < -38) continue;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < W; j++) {
        const df = x[i + j] - x[i + j + tau];
        s += df * df;
      }
      d[tau] = s;
    }
    let run = 0;
    let best = -1;
    for (let tau = 1; tau <= tauMax; tau++) {
      run += d[tau];
      const cm = run > 0 ? (d[tau] * tau) / run : 1;
      if (tau >= tauMin && cm < 0.15) {
        // walk to the local minimum
        let t = tau;
        while (t + 1 <= tauMax) {
          run += d[t + 1];
          const next = (d[t + 1] * (t + 1)) / run;
          if (next >= (d[t] * t) / (run - d[t + 1])) break;
          t++;
        }
        best = t;
        break;
      }
    }
    if (best > 0) f0.push(rate / best);
  }
  if (f0.length < 10) return { voicedFrames: f0.length, medianHz: null, spreadSt: null, sdSt: null };
  // octave errors: drop frames more than 5 semitones from a 9-frame running median
  const clean = f0.filter((f, i) => {
    const win = f0.slice(Math.max(0, i - 4), i + 5).sort((u, v) => u - v);
    const m = win[Math.floor(win.length / 2)];
    return Math.abs(12 * Math.log2(f / m)) <= 5;
  });
  const med = pct(clean, 50);
  const st = clean.map((f) => 12 * Math.log2(f / med));
  const mean = st.reduce((a, b) => a + b, 0) / st.length;
  const sd = Math.sqrt(st.reduce((a, b) => a + (b - mean) ** 2, 0) / st.length);
  return { voicedFrames: st.length, medianHz: +med.toFixed(1), spreadSt: +(pct(st, 90) - pct(st, 10)).toFixed(2), sdSt: +sd.toFixed(2) };
}

export function levels(x) {
  let peak = 0;
  let clipped = 0;
  let s = 0;
  for (const v of x) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
    s += v * v;
  }
  return { peakDb: +db(peak).toFixed(2), rmsDb: +db(Math.sqrt(s / x.length)).toFixed(2), clippedSamples: clipped };
}

/* ---------- BS.1770-4 loudness ---------- */
function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x[i];
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}
/** K-weighting coefficients for any sample rate (pre-filter shelf + RLB high-pass), after BS.1770 / libebur128. */
function kWeight(x, rate) {
  // stage 1: high shelf
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / rate);
  let Vh = 10 ** (G / 20), Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const s1 = biquad(x, (Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  // stage 2: high pass
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / rate);
  a0 = 1 + K / Q + K * K;
  return biquad(s1, 1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
}
/** Integrated loudness (LUFS) of 1 or 2 channels, with the absolute (-70) and relative (-10) gates. */
export function lufs(channels, rate) {
  const kw = channels.map((c) => kWeight(c, rate));
  const block = Math.round(0.4 * rate);
  const step = Math.round(0.1 * rate);
  const powers = [];
  for (let i = 0; i + block <= kw[0].length; i += step) {
    let z = 0;
    for (const c of kw) {
      let s = 0;
      for (let j = i; j < i + block; j++) s += c[j] * c[j];
      z += s / block;
    }
    powers.push(z);
  }
  const L = (p) => -0.691 + 10 * Math.log10(p);
  const abs = powers.filter((p) => L(p) > -70);
  if (!abs.length) return -Infinity;
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10;
  const gated = abs.filter((p) => L(p) > rel);
  return L(gated.reduce((a, b) => a + b, 0) / gated.length);
}
/** True peak (dBTP) estimated with 4x oversampling (windowed-sinc interpolation). */
export function truePeak(channels) {
  const taps = 12;
  const kernel = [];
  for (let ph = 1; ph < 4; ph++) {
    const k = [];
    for (let t = -taps; t <= taps; t++) {
      const xx = t - ph / 4;
      const sinc = xx === 0 ? 1 : Math.sin(Math.PI * xx) / (Math.PI * xx);
      const w = 0.5 + 0.5 * Math.cos((Math.PI * xx) / (taps + 1));
      k.push(sinc * w);
    }
    kernel.push(k);
  }
  let peak = 0;
  for (const c of channels)
    for (let i = taps; i < c.length - taps; i++) {
      const a = Math.abs(c[i]);
      if (a > peak) peak = a;
      if (a < 0.25) continue; // only look between samples where it can matter
      for (const k of kernel) {
        let s = 0;
        for (let t = -taps; t <= taps; t++) s += c[i + t] * k[t + taps];
        if (Math.abs(s) > peak) peak = Math.abs(s);
      }
    }
  return db(peak);
}
