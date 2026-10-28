// Synthetic pages for the solver's tests: a page torn by full-span ragged lines into a grid of pieces, each piece
// scattered with a known rigid pose and rasterized exactly (labels are evaluated analytically at pixel centres).

import { poseApply, poseInvert, rng, type Pose } from "../geom";
import type { FragmentInput, Mask, Rgba } from "../types";

/** A ragged 1D profile over [0, len]: midpoint displacement, sampled at `2^depth + 1` knots. */
export function fractalProfile(len: number, rand: () => number, depth = 9, rough = 0.07, decay = 0.63): (t: number) => number {
  const m = 2 ** depth;
  const v = new Float64Array(m + 1);
  let amp = rough * len;
  for (let step = m; step > 1; step >>= 1) {
    for (let i = step >> 1; i < m; i += step) {
      const g = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
      v[i] = (v[i - (step >> 1)] + v[i + (step >> 1)]) / 2 + g * amp;
    }
    amp *= decay;
  }
  return (t: number) => {
    const u = Math.max(0, Math.min(m, (t / len) * m));
    const i = Math.min(m - 1, Math.floor(u));
    return v[i] + (u - i) * (v[i + 1] - v[i]);
  };
}

export type SynthPage = {
  width: number;
  height: number;
  /** Piece label of a page point, or -1 outside the page. */
  label: (x: number, y: number) => number;
  pieces: number;
};

/** A page torn by `cols - 1` roughly vertical and `rows - 1` roughly horizontal ragged lines. */
export function gridTear(width: number, height: number, cols: number, rows: number, seed: number, straightCuts = false): SynthPage {
  const rand = rng(seed);
  const vs = Array.from({ length: cols - 1 }, (_, k) => {
    const base = ((k + 1) * width) / cols + (rand() - 0.5) * 0.2 * (width / cols);
    const f = straightCuts ? () => 0 : fractalProfile(height, rand);
    return (y: number) => base + f(y);
  });
  const hs = Array.from({ length: rows - 1 }, (_, k) => {
    const base = ((k + 1) * height) / rows + (rand() - 0.5) * 0.2 * (height / rows);
    const f = fractalProfile(width, rand);
    return (x: number) => base + f(x);
  });
  return {
    width,
    height,
    pieces: cols * rows,
    label: (x, y) => {
      if (x < 0 || y < 0 || x >= width || y >= height) return -1;
      let c = 0;
      for (const v of vs) if (x >= v(y)) c++;
      let r = 0;
      for (const hz of hs) if (y >= hz(x)) r++;
      return r * cols + c;
    },
  };
}

/** Paper with dark typed-looking lines every `pitch` px (words broken by gaps), as RGBA at page point (x, y). */
export function paperColour(x: number, y: number, pitch = 22, seed = 1): [number, number, number] {
  const line = Math.floor(y / pitch);
  const inLine = y - line * pitch;
  const word = Math.floor((x + line * 37) / 31);
  const gap = (x + line * 37) % 31 < 5;
  const hash = Math.sin(word * 12.9898 + line * 78.233 + seed) * 43758.5453;
  const short = hash - Math.floor(hash) < 0.2;
  const ink = inLine >= 6 && inLine < 13 && !gap && !short && Math.floor(x) % 3 !== 0;
  // ascenders: a few strokes above the x-height band
  const asc = inLine >= 2 && inLine < 6 && !gap && Math.floor(x + line) % 7 === 0;
  return ink || asc ? [40, 40, 60] : [236, 232, 222];
}

/** Rasterize piece k of the page at a pose (page → photo). Returns the fragment input and its true pose. */
export function scatterPiece(
  page: SynthPage,
  k: number,
  pose: Pose,
  opts: { noise?: number; seed?: number; colour?: boolean } = {},
): FragmentInput {
  const inv = poseInvert(pose);
  // bounds of the piece in the photo: transform the page bbox of the piece
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (let y = 0; y < page.height; y += 2) {
    for (let x = 0; x < page.width; x += 2) {
      if (page.label(x, y) !== k) continue;
      const [px, py] = poseApply(pose, x, y);
      minx = Math.min(minx, px);
      miny = Math.min(miny, py);
      maxx = Math.max(maxx, px);
      maxy = Math.max(maxy, py);
    }
  }
  const x0 = Math.floor(minx) - 4;
  const y0 = Math.floor(miny) - 4;
  const w = Math.ceil(maxx) + 5 - x0;
  const h = Math.ceil(maxy) + 5 - y0;
  const data = new Uint8Array(w * h);
  const rgba = new Uint8ClampedArray(w * h * 4);
  const rand = rng(opts.seed ?? 99);
  // smooth boundary noise: a few random sinusoids of the page position shift the label test
  const waves = Array.from({ length: 6 }, () => ({
    fx: (rand() - 0.5) * 0.5,
    fy: (rand() - 0.5) * 0.5,
    ph: rand() * 6.283,
  }));
  const noise = opts.noise ?? 0;
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const [px, py] = poseApply(inv, x0 + c + 0.5, y0 + r + 0.5);
      let jx = 0;
      let jy = 0;
      if (noise) {
        for (const wv of waves) {
          jx += Math.sin(px * wv.fx + py * wv.fy + wv.ph);
          jy += Math.cos(px * wv.fy - py * wv.fx + wv.ph);
        }
        jx *= noise / Math.sqrt(waves.length / 2);
        jy *= noise / Math.sqrt(waves.length / 2);
      }
      const inside = page.label(px + jx, py + jy) === k;
      data[r * w + c] = inside ? 1 : 0;
      if (opts.colour !== false) {
        const [R, G, B] = inside ? paperColour(px, py) : [120, 90, 60];
        rgba[4 * (r * w + c)] = R;
        rgba[4 * (r * w + c) + 1] = G;
        rgba[4 * (r * w + c) + 2] = B;
        rgba[4 * (r * w + c) + 3] = 255;
      }
    }
  }
  const mask: Mask = { width: w, height: h, data };
  const img: Rgba = { width: w, height: h, data: rgba };
  return { id: `p${k}`, mask, x0, y0, rgba: opts.colour === false ? undefined : img };
}

/** Scatter all pieces with random poses on a wide desk; returns inputs and true poses (page → photo). */
export function scatterPage(page: SynthPage, seed: number, opts: { noise?: number; spacing?: number } = {}) {
  const rand = rng(seed);
  const spacing = opts.spacing ?? 1.6 * Math.max(page.width, page.height);
  const inputs: FragmentInput[] = [];
  const poses: Pose[] = [];
  for (let k = 0; k < page.pieces; k++) {
    const theta = (rand() * 2 - 1) * Math.PI;
    const pose: Pose = { theta, tx: 200 + (k % 4) * spacing + rand() * 30, ty: 200 + Math.floor(k / 4) * spacing + rand() * 30 };
    // rotate about the page centre so pieces stay near their slot
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const cx = page.width / 2;
    const cy = page.height / 2;
    pose.tx -= c * cx - s * cy;
    pose.ty -= s * cx + c * cy;
    inputs.push(scatterPiece(page, k, pose, { noise: opts.noise, seed: seed * 31 + k }));
    poses.push(pose);
  }
  return { inputs, poses };
}

/** Rasterize a polygon (interleaved points) into a mask with point-in-polygon at pixel centres. */
export function polygonMask(poly: number[], width: number, height: number): Mask {
  const data = new Uint8Array(width * height);
  const n = poly.length / 2;
  for (let r = 0; r < height; r++) {
    const y = r + 0.5;
    for (let c = 0; c < width; c++) {
      const x = c + 0.5;
      let inside = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = poly[2 * i];
        const yi = poly[2 * i + 1];
        const xj = poly[2 * j];
        const yj = poly[2 * j + 1];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      data[r * width + c] = inside ? 1 : 0;
    }
  }
  return { width, height, data };
}
