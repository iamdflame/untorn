// The pixel work behind the cut-outs, shared by the worker and the main-thread fallback. No DOM: it takes a canvas
// factory, so it runs on OffscreenCanvas in a worker or on <canvas> in the page.

export type CutPieceInput = { c: [number, number]; poly: number[]; bbox: [number, number, number, number] };

export type CutResult<I> = {
  /** Top-left of the images relative to the piece's centroid (world units). */
  off: [number, number];
  /** World units per image pixel. */
  scale: number;
  plain: I;
  lit: I;
  /** Shadows: `pad` image px of margin around the cut-out, at `shScale` of the cut-out's resolution. */
  shadow: I;
  contact: I;
  pad: number;
  shScale: number;
  /** Ink map of the cut-out (1 = type or pen), for finding where text crosses a tear. */
  ink: Uint8Array;
  w: number;
  h: number;
};

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const TARGET = [228, 216, 194];

function median(a: number[]): number {
  if (!a.length) return 180;
  a.sort((x, y) => x - y);
  return a[a.length >> 1];
}

export function cutPiece(img: CanvasImageSource, scale: number, p: CutPieceInput, make: (w: number, h: number) => AnyCanvas): CutResult<AnyCanvas> {
  const ctx = (c: AnyCanvas, read = false) => c.getContext("2d", read ? { willReadFrequently: true } : undefined) as Ctx;
  const blurPx = Math.max(3, Math.round(8 / scale));
  const m = blurPx * 2;
  const x0 = Math.floor((p.bbox[0] - 2) / scale);
  const y0 = Math.floor((p.bbox[1] - 2) / scale);
  const x1 = Math.ceil((p.bbox[2] + 2) / scale);
  const y1 = Math.ceil((p.bbox[3] + 2) / scale);
  const w = x1 - x0;
  const h = y1 - y0;
  // the outline in crop px
  const path = new Path2D();
  for (let i = 0; i < p.poly.length; i += 2) {
    const x = (p.c[0] + p.poly[i]) / scale - x0;
    const y = (p.c[1] + p.poly[i + 1]) / scale - y0;
    if (i) path.lineTo(x, y);
    else path.moveTo(x, y);
  }
  path.closePath();

  // plain: the photo's pixels inside the outline
  const plain = make(w, h);
  const pg = ctx(plain, true);
  pg.drawImage(img, x0, y0, w, h, 0, 0, w, h);
  const src = pg.getImageData(0, 0, w, h);
  pg.globalCompositeOperation = "destination-in";
  pg.fill(path);
  pg.globalCompositeOperation = "source-over";
  const mask = pg.getImageData(0, 0, w, h);

  // the local mean for the contrast lift (blur of the unmasked crop, so the edges don't darken it)
  const bc = make(w + 2 * m, h + 2 * m);
  const bg = ctx(bc, true);
  bg.filter = `blur(${blurPx}px)`;
  bg.drawImage(img, x0 - m, y0 - m, w + 2 * m, h + 2 * m, 0, 0, w + 2 * m, h + 2 * m);
  const blur = bg.getImageData(m, m, w, h).data;

  // the piece's own paper colour: median of the brighter half of its pixels
  const s = src.data;
  const md = mask.data;
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const step = Math.max(1, Math.floor((w * h) / 12000));
  for (let i = 0; i < w * h; i += step) {
    if (md[i * 4 + 3] < 250) continue;
    rs.push(s[i * 4]);
    gs.push(s[i * 4 + 1]);
    bs.push(s[i * 4 + 2]);
  }
  const lum = rs.map((r, i) => r + gs[i] + bs[i]);
  const cut = median(lum.slice());
  const bright = (arr: number[]) => median(arr.filter((_, i) => lum[i] >= cut));
  const pp = [bright(rs), bright(gs), bright(bs)];

  // lit: target × clamp((a + 1.5 (a − blur)) / paper, 0, 1.14)
  const lit = make(w, h);
  const lg = ctx(lit);
  const ld = lg.createImageData(w, h);
  const L = ld.data;
  const ink = new Uint8Array(w * h);
  const inkCut = 0.62 * (pp[0] + pp[1] + pp[2]);
  for (let i = 0, n = w * h; i < n; i++) {
    const a = md[i * 4 + 3];
    if (!a) continue;
    const o = i * 4;
    let sum = 0;
    for (let c = 0; c < 3; c++) {
      const v = s[o + c];
      const u = v + 1.5 * (v - blur[o + c]);
      const x = Math.min(1.14, Math.max(0, u / pp[c]));
      L[o + c] = TARGET[c] * x;
      sum += v;
    }
    L[o + 3] = a;
    if (a > 200 && sum < inkCut) ink[i] = 1;
  }
  lg.putImageData(ld, 0, 0);

  // shadows: the outline's alpha, blurred, in a warm near-black
  const shScale = 0.5;
  const pad = 40;
  const sw = Math.round(w * shScale) + 2 * pad;
  const sh = Math.round(h * shScale) + 2 * pad;
  const mk = (radius: number) => {
    const c = make(sw, sh);
    const g = ctx(c);
    g.filter = `blur(${radius}px)`;
    g.translate(pad, pad);
    g.scale(shScale, shScale);
    g.fillStyle = "rgb(30,22,16)";
    g.fill(path);
    return c;
  };
  const shadow = mk(Math.max(4, 7 / scale));
  const contact = mk(Math.max(1, 1.1 / scale));
  return { off: [x0 * scale - p.c[0], y0 * scale - p.c[1]], scale, plain, lit, shadow, contact, pad, shScale, ink, w, h };
}
