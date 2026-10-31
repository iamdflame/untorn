// The narration track: every clip of the timeline placed where it plays, joined on the sound itself. A clip's edges
// come from the voice's alignment, which can sit 50–100 ms off the audio (a late "About", an early end), and fixed
// margins around it ran into the next word: where two clips overlapped, a syllable played twice. So each join moves to
// the quietest point of the pause between the two chunks:
//   - where the edit keeps the voice's own timing, the clips meet at one sample and the join is the original audio;
//   - where a beat adds silence, the first clip fades out and the second fades in at that quiet point;
//   - where a long pause is shortened, the cut removes the quietest stretch of it under an equal-power crossfade.
// A scene's first clip starts in the silence before its first sound and its last clip ends once the voice has decayed
// into silence, so no onset or tail is clipped. Any overlap beyond a crossfade throws.
import type { Clip } from "../../src/film/timeline";

export type Join = {
  scene: string;
  /** the chunk the join follows ("" for a scene's first edge) */
  after: string;
  kind: "seamless" | "beat" | "trim" | "start" | "end";
  /** source second of the cut, and the output second it plays at */
  src: number;
  out: number;
  /** loudness at the cut, dBFS RMS over 10 ms */
  db: number;
  /** silence added (+) or pause removed (−), ms */
  changeMs: number;
};

const HOP = 0.005;
/** dBFS: quieter than this is silence (the takes' floor sits near −90; speech runs −15 to −35). */
const SILENT = -60;
const FADE = 0.01;
const XFADE = 0.02;

type Piece = { c: Clip; A: number; B: number; M: number; head: number; tail: number; headShape: Shape; tailShape: Shape };
type Shape = "none" | "cos" | "power";

/** Short-time loudness: dBFS RMS over 10 ms windows, every 5 ms. */
function envelope(x: Float32Array, sr: number) {
  const hop = Math.round(HOP * sr);
  const n = Math.ceil(x.length / hop);
  const e = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const c = k * hop;
    let s = 0;
    let m = 0;
    for (let i = Math.max(0, c - hop); i < Math.min(x.length, c + hop); i++) {
      s += x[i] * x[i];
      m++;
    }
    e[k] = 10 * Math.log10(s / Math.max(1, m) + 1e-12);
  }
  return e;
}

/** The quietest time in [lo, hi] by cost(t); among near-equal points (within 3 dB) the one nearest `mid`. */
function quietest(lo: number, hi: number, mid: number, cost: (t: number) => number) {
  const ts: number[] = [];
  for (let t = lo; t <= hi + 1e-9; t += HOP) ts.push(t);
  if (!ts.length) ts.push((lo + hi) / 2);
  const cs = ts.map(cost);
  const min = Math.min(...cs);
  let best = ts[0];
  for (let k = 0; k < ts.length; k++) if (cs[k] <= min + 3 && Math.abs(ts[k] - mid) < Math.abs(best - mid)) best = ts[k];
  return best;
}

/** Maximal runs of silence (E < SILENT) inside [lo, hi], as [start, end] seconds. */
function silentRuns(lo: number, hi: number, E: (t: number) => number) {
  const runs: [number, number][] = [];
  let s = -1;
  for (let t = lo; t <= hi + 1e-9; t += HOP) {
    if (E(t) < SILENT) {
      if (s < 0) s = t;
    } else if (s >= 0) {
      runs.push([s, t - HOP]);
      s = -1;
    }
  }
  if (s >= 0) runs.push([s, hi]);
  return runs;
}

export function voiceTrack(clips: Clip[], load: (scene: string) => Float32Array, sr: number, n: number) {
  const track = new Float32Array(n);
  const joins: Join[] = [];
  const pieces: Piece[] = [];
  const groups: Clip[][] = [];
  for (const c of clips) {
    const g = groups.at(-1);
    if (g && g[0].scene === c.scene) g.push(c);
    else groups.push([c]);
  }
  for (const group of groups) {
    const scene = group[0].scene;
    const x = load(scene);
    const env = envelope(x, sr);
    const E = (t: number) => env[Math.min(env.length - 1, Math.max(0, Math.round(t / HOP)))];
    const len = x.length / sr;
    const ps: Piece[] = group.map((c) => ({ c, A: 0, B: 0, M: Math.round((c.at - c.from) * sr), head: 0, tail: 0, headShape: "none", tailShape: "none" }));

    // the scene's first edge: back from the first word to the silence before its first sound
    {
      const p = ps[0];
      const s0 = p.c.start;
      const lim = Math.max(0, s0 - 0.35);
      let on = -1;
      for (let t = s0; t >= lim; t -= HOP) {
        if (E(t) < SILENT) {
          on = t;
          break;
        }
      }
      if (on < 0) on = lim === 0 ? 0 : quietest(lim, s0, lim, E);
      const t0 = Math.max(0, on - FADE);
      p.A = Math.round(t0 * sr);
      p.head = Math.round((t0 === 0 && E(0) >= SILENT ? 0.002 : FADE) * sr);
      p.headShape = "cos";
      joins.push({ scene, after: "", kind: "start", src: t0, out: (p.A + p.M) / sr, db: E(t0), changeMs: 0 });
    }

    for (let i = 1; i < ps.length; i++) {
      const a = ps[i - 1];
      const b = ps[i];
      let d = (b.M - a.M) / sr;
      // the edit keeps the voice's own timing here: the same mapping to the sample, so the join is the original audio
      if (Math.abs(d) < 0.002) {
        b.M = a.M;
        d = 0;
      }
      const lo = Math.max(a.c.start + 0.05, Math.min(a.c.end, b.c.start) - 0.05);
      const hi = Math.min(b.c.end - 0.05, Math.max(a.c.end, b.c.start) + 0.05);
      const mid = (a.c.end + b.c.start) / 2;
      // a beat or a trim cuts in the pause itself: the middle of its longest silence (a stop's closure is shorter)
      const runs = silentRuns(lo, hi, E).sort((u, v) => v[1] - v[0] - (u[1] - u[0]));
      if (d >= 0) {
        const p = d > 0 && runs.length ? (runs[0][0] + runs[0][1]) / 2 : quietest(lo, hi, mid, E);
        const P = Math.round(p * sr);
        a.B = P;
        b.A = P;
        if (d > 0) {
          a.tail = b.head = Math.round(FADE * sr);
          a.tailShape = b.headShape = "cos";
        }
        joins.push({ scene, after: a.c.shown, kind: d === 0 ? "seamless" : "beat", src: p, out: (P + a.M) / sr, db: E(p), changeMs: d * 1000 });
      } else {
        // a long pause shortened by r: remove the stretch [p, p + r] whose two ends are both quietest
        const r = -d;
        const R = a.M - b.M;
        const fit = runs.find(([u, v]) => v - u >= r + XFADE + 0.02);
        const p = fit ? (fit[0] + fit[1] - r) / 2 : quietest(lo, Math.max(lo, hi - r), mid - r / 2, (t) => Math.max(E(t), E(t + r)));
        const P = Math.round(p * sr);
        const X = Math.round(XFADE * sr);
        a.B = P + (X >> 1);
        a.tail = X;
        a.tailShape = "power";
        b.A = P + R - (X >> 1);
        b.head = X;
        b.headShape = "power";
        joins.push({ scene, after: a.c.shown, kind: "trim", src: p, out: (P + a.M) / sr, db: Math.max(E(p), E(p + r)), changeMs: d * 1000 });
      }
    }

    // the scene's last edge: on past the last word until 120 ms of silence (a final stop's closure is shorter, so its
    // release is never cut), then a fade inside that silence
    {
      const p = ps[ps.length - 1];
      const e0 = p.c.end;
      const lim = Math.min(len, e0 + 1.0);
      let off = -1;
      let run = 0;
      for (let t = e0; t <= lim; t += HOP) {
        run = E(t) < SILENT ? run + 1 : 0;
        if (run >= 24) {
          off = t - 23 * HOP;
          break;
        }
      }
      const t1 = off >= 0 ? Math.min(len, off + 0.03) : Math.min(len, quietest(e0 + 0.1, lim, lim, E));
      p.B = Math.round(t1 * sr);
      p.tail = Math.round(0.02 * sr);
      p.tailShape = "cos";
      joins.push({ scene, after: p.c.shown, kind: "end", src: t1, out: (p.B + p.M) / sr, db: E(t1 - 0.02), changeMs: 0 });
    }
    pieces.push(...ps);
  }

  // write, with the fades; then prove no audio plays twice outside a crossfade
  const gain = (shape: Shape, u: number) => (shape === "power" ? Math.sin((u * Math.PI) / 2) : 0.5 - 0.5 * Math.cos(u * Math.PI));
  for (const p of pieces) {
    const x = load(p.c.scene);
    for (let i = Math.max(0, p.A); i < Math.min(x.length, p.B); i++) {
      const j = i + p.M;
      if (j < 0 || j >= n) continue;
      let g = 1;
      if (p.head && i < p.A + p.head) g *= gain(p.headShape, (i - p.A) / p.head);
      if (p.tail && i >= p.B - p.tail) g *= gain(p.tailShape, (p.B - 1 - i) / p.tail);
      track[j] += x[i] * g;
    }
  }
  const spans = pieces.map((p) => ({ s: p.A + p.M, e: p.B + p.M, head: p.headShape === "power" ? p.head : 0, name: `${p.c.scene} "${p.c.shown.slice(0, 24)}"` })).sort((u, v) => u.s - v.s);
  for (let i = 1; i < spans.length; i++) {
    const over = spans[i - 1].e - spans[i].s;
    if (over > spans[i].head) throw new Error(`voice: ${spans[i - 1].name} and ${spans[i].name} overlap by ${((over / sr) * 1000).toFixed(1)} ms`);
  }
  return { track, joins };
}
