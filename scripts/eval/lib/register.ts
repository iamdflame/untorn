// Image registration for the real-photo ground truth: where does each torn piece sit on the intact page?
//
// Each piece's printed content (band-passed luminance inside its eroded mask) is matched against a photo of the same
// page, intact, by masked normalised cross-correlation (Padfield's formulation, three FFTs per template) over
// rotations and scales, then refined by a local search on a finer level. The result is a similarity transform per
// piece (torn-photo px → intact-photo px). Used only by scripts/eval/real.ts (never by the app).

import { fft2d, nextPow2 } from "./fft";

export type Gray = { width: number; height: number; data: Float32Array };

/** x' = s·R(theta)·x + (tx, ty). */
export type Similarity = { s: number; theta: number; tx: number; ty: number };

export function simApply(S: Similarity, x: number, y: number): [number, number] {
  const c = S.s * Math.cos(S.theta);
  const s = S.s * Math.sin(S.theta);
  return [c * x - s * y + S.tx, s * x + c * y + S.ty];
}

/** Separable Gaussian blur (edges clamped). */
export function blur(img: Gray, sigma: number): Gray {
  const { width: w, height: h } = img;
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += k[i + r];
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = -r; d <= r; d++) {
        const xx = x + d < 0 ? 0 : x + d >= w ? w - 1 : x + d;
        v += k[d + r] * img.data[row + xx];
      }
      tmp[row + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let d = -r; d <= r; d++) {
        const yy = y + d < 0 ? 0 : y + d >= h ? h - 1 : y + d;
        v += k[d + r] * tmp[yy * w + x];
      }
      out[y * w + x] = v;
    }
  }
  return { width: w, height: h, data: out };
}

/** Difference of Gaussians: strokes and characters without the illumination. */
export function bandpass(img: Gray, s1: number, s2: number): Gray {
  const a = blur(img, s1);
  const b = blur(img, s2);
  const out = new Float32Array(a.data.length);
  for (let i = 0; i < out.length; i++) out[i] = a.data[i] - b.data[i];
  return { width: img.width, height: img.height, data: out };
}

/** Bilinear sample (pixel centres at +0.5); NaN outside. */
export function sampleGray(img: Gray, x: number, y: number): number {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= img.width || y0 + 1 >= img.height) return NaN;
  const tx = fx - x0;
  const ty = fy - y0;
  const i = y0 * img.width + x0;
  const d = img.data;
  return (1 - ty) * ((1 - tx) * d[i] + tx * d[i + 1]) + ty * ((1 - tx) * d[i + img.width] + tx * d[i + img.width + 1]);
}

/** Masked NCC of templates against one image, by FFT. The image is zero outside `valid` (zero = blank paper). */
export class NccSearch {
  readonly W: number;
  readonly H: number;
  readonly img: Gray;
  private readonly F: [Float64Array, Float64Array];
  private readonly F2: [Float64Array, Float64Array];
  private readonly P: [Float64Array, Float64Array];

  constructor(img: Gray, valid: Float32Array, maxTemplate: number) {
    this.img = img;
    this.W = nextPow2(img.width + maxTemplate);
    this.H = nextPow2(img.height + maxTemplate);
    const n = this.W * this.H;
    const f = [new Float64Array(n), new Float64Array(n)] as [Float64Array, Float64Array];
    const f2 = [new Float64Array(n), new Float64Array(n)] as [Float64Array, Float64Array];
    const p = [new Float64Array(n), new Float64Array(n)] as [Float64Array, Float64Array];
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const v = valid[y * img.width + x] ? img.data[y * img.width + x] : 0;
        f[0][y * this.W + x] = v;
        f2[0][y * this.W + x] = v * v;
        p[0][y * this.W + x] = valid[y * img.width + x] ? 1 : 0;
      }
    }
    fft2d(f[0], f[1], this.W, this.H);
    fft2d(f2[0], f2[1], this.W, this.H);
    fft2d(p[0], p[1], this.W, this.H);
    this.F = f;
    this.F2 = f2;
    this.P = p;
  }

  /**
   * NCC map for a template t with weights m (tw × th). Entry (u, v) puts the template's top-left at image (u, v);
   * offsets may be negative (wrapped). Offsets whose overlap with the valid image is below `minOverlap` get -1.
   */
  search(t: Float32Array, m: Float32Array, tw: number, th: number, minOverlap = 0.75): { map: Float32Array; W: number; H: number } {
    const { W, H } = this;
    const n = W * H;
    const zr = new Float64Array(n);
    const zi = new Float64Array(n);
    let sm = 0;
    let smt = 0;
    let smt2 = 0;
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const w = m[y * tw + x];
        if (!w) continue;
        const v = t[y * tw + x];
        zr[y * W + x] = w;
        zi[y * W + x] = w * v;
        sm += w;
        smt += w * v;
        smt2 += w * v * v;
      }
    }
    fft2d(zr, zi, W, H);
    // separate the two real spectra: M = (Z[k] + conj Z[-k]) / 2, MT = (Z[k] − conj Z[-k]) / 2i
    const ar = new Float64Array(n);
    const ai = new Float64Array(n);
    const br = new Float64Array(n);
    const bi = new Float64Array(n);
    const [Fr, Fi] = this.F;
    const [F2r, F2i] = this.F2;
    const [Pr, Pi] = this.P;
    for (let ky = 0; ky < H; ky++) {
      const ny = (H - ky) % H;
      for (let kx = 0; kx < W; kx++) {
        const k = ky * W + kx;
        const nk = ny * W + ((W - kx) % W);
        const mr = 0.5 * (zr[k] + zr[nk]);
        const mi = 0.5 * (zi[k] - zi[nk]);
        const tr = 0.5 * (zi[k] + zi[nk]);
        const ti = -0.5 * (zr[k] - zr[nk]);
        // conj(M)·F + i·conj(M)·F2
        const c1r = mr * Fr[k] + mi * Fi[k];
        const c1i = mr * Fi[k] - mi * Fr[k];
        const c2r = mr * F2r[k] + mi * F2i[k];
        const c2i = mr * F2i[k] - mi * F2r[k];
        ar[k] = c1r - c2i;
        ai[k] = c1i + c2r;
        // conj(M)·P + i·conj(MT)·F
        const c3r = mr * Pr[k] + mi * Pi[k];
        const c3i = mr * Pi[k] - mi * Pr[k];
        const c4r = tr * Fr[k] + ti * Fi[k];
        const c4i = tr * Fi[k] - ti * Fr[k];
        br[k] = c3r - c4i;
        bi[k] = c3i + c4r;
      }
    }
    fft2d(ar, ai, W, H, true);
    fft2d(br, bi, W, H, true);
    const map = new Float32Array(n).fill(-1);
    const vt = smt2 - (smt * smt) / sm;
    if (vt <= 0) return { map, W, H };
    for (let k = 0; k < n; k++) {
      const overlap = br[k];
      if (overlap < minOverlap * sm) continue;
      const sf = ar[k];
      const sf2 = ai[k];
      const stf = bi[k];
      const vf = sf2 - (sf * sf) / sm;
      if (vf <= 1e-9 * sm) continue;
      map[k] = (stf - (smt * sf) / sm) / Math.sqrt(vt * vf);
    }
    return { map, W, H };
  }
}

/** Local maxima of an NCC map (non-maximum suppression over `radius`), best first. Offsets are signed. */
export function peaks(map: Float32Array, W: number, H: number, count: number, radius: number): { u: number; v: number; ncc: number }[] {
  const idx: number[] = [];
  for (let k = 0; k < map.length; k++) if (map[k] > 0.05) idx.push(k);
  idx.sort((a, b) => map[b] - map[a]);
  const out: { u: number; v: number; ncc: number }[] = [];
  for (const k of idx) {
    let u = k % W;
    let v = (k - u) / W;
    if (u > W / 2) u -= W;
    if (v > H / 2) v -= H;
    if (out.some((p) => Math.abs(p.u - u) <= radius && Math.abs(p.v - v) <= radius)) continue;
    out.push({ u, v, ncc: map[k] });
    if (out.length >= count) break;
  }
  return out;
}

/** A piece at one pyramid level: its band-passed crop and its weight mask, both in level pixels. */
export type PieceLevel = { x0: number; y0: number; t: Gray; m: Float32Array };

/** Rotate and scale a piece crop about its centre; returns the template, weights, and where the crop centre lands. */
export function warpTemplate(p: PieceLevel, theta: number, s: number): { t: Float32Array; m: Float32Array; tw: number; th: number; ctx: number; cty: number } {
  const { width: w, height: h } = p.t;
  const cx = w / 2;
  const cy = h / 2;
  const c = Math.cos(theta);
  const sn = Math.sin(theta);
  const hw = (s * (Math.abs(c) * w + Math.abs(sn) * h)) / 2;
  const hh = (s * (Math.abs(sn) * w + Math.abs(c) * h)) / 2;
  const tw = Math.ceil(2 * hw) + 2;
  const th = Math.ceil(2 * hh) + 2;
  const ctx = tw / 2;
  const cty = th / 2;
  const t = new Float32Array(tw * th);
  const m = new Float32Array(tw * th);
  const mg: Gray = { width: w, height: h, data: p.m };
  for (let j = 0; j < th; j++) {
    for (let i = 0; i < tw; i++) {
      const dx = (i + 0.5 - ctx) / s;
      const dy = (j + 0.5 - cty) / s;
      // inverse rotation
      const x = cx + c * dx + sn * dy;
      const y = cy - sn * dx + c * dy;
      const wv = sampleGray(mg, x, y);
      if (!(wv > 0.999)) continue;
      const v = sampleGray(p.t, x, y);
      if (Number.isNaN(v)) continue;
      t[j * tw + i] = v;
      m[j * tw + i] = 1;
    }
  }
  return { t, m, tw, th, ctx, cty };
}

/**
 * The full-resolution similarity (torn px → intact px) for a template placed at offset (u, v) on level L, where the
 * piece crop starts at level pixel (x0, y0) and has size w × h.
 */
export function similarityFromPlacement(p: PieceLevel, theta: number, s: number, ctx: number, cty: number, u: number, v: number, L: number): Similarity {
  const cx = p.x0 + p.t.width / 2;
  const cy = p.y0 + p.t.height / 2;
  const c = s * Math.cos(theta);
  const sn = s * Math.sin(theta);
  // level: x_I = s R (x_T − c) + (ctx + u, cty + v); full res: both coordinates × L
  const tx = ctx + u - (c * cx - sn * cy);
  const ty = cty + v - (sn * cx + c * cy);
  return { s, theta, tx: L * tx, ty: L * ty };
}

/**
 * NCC between a piece (sample points in torn level-L px with values) and the intact image at level L under a
 * full-resolution similarity.
 */
export function nccAt(pts: Float32Array, vals: Float32Array, img: Gray, S: Similarity, L: number): number {
  const c = S.s * Math.cos(S.theta);
  const sn = S.s * Math.sin(S.theta);
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let k = 0; k < vals.length; k++) {
    const X = L * pts[2 * k];
    const Y = L * pts[2 * k + 1];
    const x = (c * X - sn * Y + S.tx) / L;
    const y = (sn * X + c * Y + S.ty) / L;
    const b = sampleGray(img, x, y);
    if (Number.isNaN(b)) continue;
    const a = vals[k];
    n++;
    sa += a;
    sb += b;
    saa += a * a;
    sbb += b * b;
    sab += a * b;
  }
  if (n < 50) return -1;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  if (va <= 0 || vb <= 0) return -1;
  return (sab - (sa * sb) / n) / Math.sqrt(va * vb);
}

/** Pattern search over (theta, s, tx, ty) maximising nccAt; steps shrink until below the given floors. */
export function refine(pts: Float32Array, vals: Float32Array, img: Gray, S0: Similarity, L: number, step: { theta: number; s: number; t: number }): { S: Similarity; ncc: number } {
  let S = { ...S0 };
  let best = nccAt(pts, vals, img, S, L);
  let st = { ...step };
  // rotate and scale about the piece's centre so the parameters decouple
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < vals.length; k++) {
    cx += L * pts[2 * k];
    cy += L * pts[2 * k + 1];
  }
  cx /= Math.max(1, vals.length);
  cy /= Math.max(1, vals.length);
  const about = (T: Similarity, dth: number, ds: number): Similarity => {
    const [qx, qy] = simApply(T, cx, cy);
    const s = T.s * ds;
    const theta = T.theta + dth;
    const c = s * Math.cos(theta);
    const sn = s * Math.sin(theta);
    return { s, theta, tx: qx - (c * cx - sn * cy), ty: qy - (sn * cx + c * cy) };
  };
  for (let round = 0; round < 12; round++) {
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 40) {
      improved = false;
      const moves: Similarity[] = [
        about(S, st.theta, 1),
        about(S, -st.theta, 1),
        about(S, 0, 1 + st.s),
        about(S, 0, 1 - st.s),
        { ...S, tx: S.tx + st.t },
        { ...S, tx: S.tx - st.t },
        { ...S, ty: S.ty + st.t },
        { ...S, ty: S.ty - st.t },
      ];
      for (const M of moves) {
        const v = nccAt(pts, vals, img, M, L);
        if (v > best + 1e-6) {
          best = v;
          S = M;
          improved = true;
        }
      }
    }
    st = { theta: st.theta / 2, s: st.s / 2, t: st.t / 2 };
  }
  return { S, ncc: best };
}
