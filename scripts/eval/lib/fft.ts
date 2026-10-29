// Radix-2 complex FFT, 1D and 2D (row-major), in place on separate real and imaginary arrays. Used by the real-photo
// ground-truth registration (scripts/eval/real.ts) for masked normalised cross-correlation.

const tables = new Map<number, { rev: Uint32Array; cos: Float64Array; sin: Float64Array }>();

function table(n: number) {
  let t = tables.get(n);
  if (t) return t;
  const bits = Math.round(Math.log2(n));
  if (1 << bits !== n) throw new Error(`FFT length ${n} is not a power of two`);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  t = { rev, cos, sin };
  tables.set(n, t);
  return t;
}

/** In-place FFT of length n (power of two) over re/im starting at `off` with `stride`. Inverse is unscaled. */
export function fft1d(re: Float64Array, im: Float64Array, n: number, inverse = false, off = 0, stride = 1) {
  const { rev, cos, sin } = table(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const a = off + i * stride;
      const b = off + j * stride;
      let t = re[a];
      re[a] = re[b];
      re[b] = t;
      t = im[a];
      im[a] = im[b];
      im[b] = t;
    }
  }
  const sgn = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sgn * sin[k * step];
        const a = off + (start + k) * stride;
        const b = off + (start + k + half) * stride;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** In-place 2D FFT of a w × h row-major array (both powers of two). The inverse divides by w·h. */
export function fft2d(re: Float64Array, im: Float64Array, w: number, h: number, inverse = false) {
  for (let y = 0; y < h; y++) fft1d(re, im, w, inverse, y * w, 1);
  // columns through a contiguous buffer: much faster than strided access
  const cr = new Float64Array(h);
  const ci = new Float64Array(h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      cr[y] = re[y * w + x];
      ci[y] = im[y * w + x];
    }
    fft1d(cr, ci, h, inverse);
    for (let y = 0; y < h; y++) {
      re[y * w + x] = cr[y];
      im[y * w + x] = ci[y];
    }
  }
  if (inverse) {
    const s = 1 / (w * h);
    for (let i = 0; i < w * h; i++) {
      re[i] *= s;
      im[i] *= s;
    }
  }
}

export const nextPow2 = (v: number) => 1 << Math.ceil(Math.log2(Math.max(1, v)));
