// Raster helpers shared by the solver: depth inside a mask, luminance, paper tone and bilinear sampling.

import type { Mask, Rgba } from "./types";

/** Chamfer distance (px) from each mask pixel to the nearest background pixel; the raster border counts as background. */
export function depthMap(mask: Mask): Float32Array {
  const { width: w, height: h, data } = mask;
  const d = new Float32Array(w * h);
  const INF = 1e9;
  const D = Math.SQRT2;
  for (let i = 0; i < w * h; i++) d[i] = data[i] ? INF : 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      v = Math.min(v, x > 0 ? d[i - 1] + 1 : 1, y > 0 ? d[i - w] + 1 : 1);
      v = Math.min(v, x > 0 && y > 0 ? d[i - w - 1] + D : D, x < w - 1 && y > 0 ? d[i - w + 1] + D : D);
      d[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      let v = d[i];
      v = Math.min(v, x < w - 1 ? d[i + 1] + 1 : 1, y < h - 1 ? d[i + w] + 1 : 1);
      v = Math.min(v, x < w - 1 && y < h - 1 ? d[i + w + 1] + D : D, x > 0 && y < h - 1 ? d[i + w - 1] + D : D);
      d[i] = v;
    }
  }
  return d;
}

/** Rec. 601 luminance of each pixel, 0–255. */
export function luminance(img: Rgba): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.299 * img.data[4 * i] + 0.587 * img.data[4 * i + 1] + 0.114 * img.data[4 * i + 2];
  return out;
}

/**
 * Paper tone of a piece: the luminance level of its bright majority (70th percentile of interior pixels, so typed or
 * handwritten ink does not drag it down) and the mean colour of the pixels near that level.
 */
export function paperTone(
  img: Rgba,
  lum: Float32Array,
  depth: Float32Array,
  minDepth = 5,
): { level: number; rgb: [number, number, number] } | null {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < lum.length; i++) {
    if (depth[i] < minDepth) continue;
    hist[Math.min(255, Math.max(0, Math.round(lum[i])))]++;
    n++;
  }
  if (n < 50) return null;
  let acc = 0;
  let level = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= 0.7 * n) {
      level = v;
      break;
    }
  }
  let r = 0;
  let g = 0;
  let b = 0;
  let m = 0;
  for (let i = 0; i < lum.length; i++) {
    if (depth[i] < minDepth || Math.abs(lum[i] - level) > 12) continue;
    r += img.data[4 * i];
    g += img.data[4 * i + 1];
    b += img.data[4 * i + 2];
    m++;
  }
  if (!m) return null;
  return { level, rgb: [r / m, g / m, b / m] };
}

/**
 * The local paper level under each pixel of a piece: the brightest paper within ±r px (strokes are thinner than that),
 * smoothed over ±2r. Follows shadows, curl and vignetting, which a single paper level per piece cannot; ink is then
 * `level − luminance`. Pixels outside the mask get the level of the paper near them (NaN when none is near).
 */
export function localPaperLevel(lum: Float32Array, mask: Uint8Array, w: number, h: number, r: number): Float32Array {
  const n = w * h;
  const tmp = new Float32Array(n).fill(-Infinity);
  const mx = new Float32Array(n).fill(-Infinity);
  // separable max filter over mask pixels only
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let d = Math.max(0, x - r); d <= Math.min(w - 1, x + r); d++) {
        const i = y * w + d;
        if (mask[i] && lum[i] > m) m = lum[i];
      }
      tmp[y * w + x] = m;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let m = -Infinity;
      for (let d = Math.max(0, y - r); d <= Math.min(h - 1, y + r); d++) if (tmp[d * w + x] > m) m = tmp[d * w + x];
      mx[y * w + x] = m;
    }
  }
  // box blur over ±2r of the finite values (summed-area tables)
  const R = 2 * r;
  const S = new Float64Array((w + 1) * (h + 1));
  const C = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0;
    let rc = 0;
    for (let x = 0; x < w; x++) {
      const v = mx[y * w + x];
      if (Number.isFinite(v)) {
        rs += v;
        rc++;
      }
      S[(y + 1) * (w + 1) + x + 1] = S[y * (w + 1) + x + 1] + rs;
      C[(y + 1) * (w + 1) + x + 1] = C[y * (w + 1) + x + 1] + rc;
    }
  }
  const out = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - R);
    const y1 = Math.min(h, y + R + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - R);
      const x1 = Math.min(w, x + R + 1);
      const s = S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0];
      const c = C[y1 * (w + 1) + x1] - C[y0 * (w + 1) + x1] - C[y1 * (w + 1) + x0] + C[y0 * (w + 1) + x0];
      out[y * w + x] = c > 0 ? s / c : NaN;
    }
  }
  return out;
}

/** Bilinear RGBA sample at continuous raster coordinates (pixel centres at +0.5); writes into out[0..3]. */
export function sampleRgba(img: Rgba, x: number, y: number, out: Float64Array): boolean {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  if (x0 < -1 || y0 < -1 || x0 >= img.width || y0 >= img.height) return false;
  const tx = fx - x0;
  const ty = fy - y0;
  const w = img.width;
  const h = img.height;
  out[0] = out[1] = out[2] = out[3] = 0;
  const cx0 = Math.max(0, Math.min(w - 1, x0));
  const cx1 = Math.max(0, Math.min(w - 1, x0 + 1));
  const cy0 = Math.max(0, Math.min(h - 1, y0));
  const cy1 = Math.max(0, Math.min(h - 1, y0 + 1));
  const taps: [number, number, number][] = [
    [cx0, cy0, (1 - tx) * (1 - ty)],
    [cx1, cy0, tx * (1 - ty)],
    [cx0, cy1, (1 - tx) * ty],
    [cx1, cy1, tx * ty],
  ];
  for (const [px, py, wt] of taps) {
    const k = 4 * (py * w + px);
    out[0] += wt * img.data[k];
    out[1] += wt * img.data[k + 1];
    out[2] += wt * img.data[k + 2];
    out[3] += wt * img.data[k + 3];
  }
  return true;
}

/** Nearest-pixel mask lookup at continuous raster coordinates (0 outside the raster). */
export function maskAt(mask: Mask, x: number, y: number): number {
  const c = Math.floor(x);
  const r = Math.floor(y);
  if (c < 0 || r < 0 || c >= mask.width || r >= mask.height) return 0;
  return mask.data[r * mask.width + c];
}

/** Bilinear lookup of a float raster (pixel centres at +0.5); `outside` beyond the raster. */
export function sampleFloat(f: Float32Array, w: number, h: number, x: number, y: number, outside = 0): number {
  const fx = x - 0.5;
  const fy = y - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= h) {
    const c = Math.round(fx);
    const r = Math.round(fy);
    if (c < 0 || r < 0 || c >= w || r >= h) return outside;
    return f[r * w + c];
  }
  const tx = fx - x0;
  const ty = fy - y0;
  const i = y0 * w + x0;
  return (1 - ty) * ((1 - tx) * f[i] + tx * f[i + 1]) + ty * ((1 - tx) * f[i + w] + tx * f[i + w + 1]);
}
