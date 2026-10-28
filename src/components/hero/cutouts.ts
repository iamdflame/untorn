// The paper, cut from the real photo along SAM's outlines, in two exposures: as photographed, and lit on the light
// table (levelled warm against the piece's own paper colour, local contrast lifted so the fibre shows). Plus a soft
// lift shadow and a tight contact shadow from the same outline. All from real pixels; nothing is painted in.

import type { ScenePiece } from "@/lib/run/scene";

export type Cutout = {
  /** Top-left of the images relative to the piece's centroid (world units). */
  off: [number, number];
  /** World units per image pixel. */
  scale: number;
  plain: HTMLCanvasElement;
  lit: HTMLCanvasElement;
  /** Shadows: `pad` image px of margin around the cut-out, at `shScale` of the cut-out's resolution. */
  shadow: HTMLCanvasElement;
  contact: HTMLCanvasElement;
  pad: number;
  shScale: number;
  /** Ink map of the lit cut-out (1 = type or pen), for finding where text crosses a tear. */
  ink: Uint8Array;
  w: number;
  h: number;
};

const TARGET = [228, 216, 194];
const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Median of a channel sample. */
function median(a: number[]): number {
  if (!a.length) return 180;
  a.sort((x, y) => x - y);
  return a[a.length >> 1];
}

/**
 * Cut every piece out of `img` (the photo at any resolution; `worldW` is the photo's width in world units). Yields to
 * the main thread between pieces so the page stays responsive. `onPiece` reports each finished piece.
 */
export async function makeCutouts(img: CanvasImageSource & { naturalWidth: number }, worldW: number, pieces: ScenePiece[], onPiece?: (i: number, c: Cutout) => void, signal?: { cancelled: boolean }): Promise<Cutout[]> {
  const scale = worldW / img.naturalWidth; // world units per image px
  const out: Cutout[] = [];
  const blurPx = Math.max(3, Math.round(8 / scale));
  for (const p of pieces) {
    if (signal?.cancelled) break;
    // crop box in image px, with a margin for the blur
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
    const plain = canvas(w, h);
    const pg = plain.getContext("2d", { willReadFrequently: true })!;
    pg.drawImage(img, x0, y0, w, h, 0, 0, w, h);
    const src = pg.getImageData(0, 0, w, h);
    pg.globalCompositeOperation = "destination-in";
    pg.fill(path);
    pg.globalCompositeOperation = "source-over";
    const mask = pg.getImageData(0, 0, w, h);

    // the local mean for the contrast lift (blur of the unmasked crop, so the edges don't darken it)
    const bc = canvas(w + 2 * m, h + 2 * m);
    const bg = bc.getContext("2d", { willReadFrequently: true })!;
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
    const lit = canvas(w, h);
    const lg = lit.getContext("2d")!;
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
      const c = canvas(sw, sh);
      const g = c.getContext("2d")!;
      g.filter = `blur(${radius}px)`;
      g.translate(pad, pad);
      g.scale(shScale, shScale);
      g.fillStyle = "rgb(30,22,16)";
      g.fill(path);
      return c;
    };
    const shadow = mk(Math.max(4, 7 / scale));
    const contact = mk(Math.max(1, 1.1 / scale));

    const cut0: Cutout = { off: [x0 * scale - p.c[0], y0 * scale - p.c[1]], scale, plain, lit, shadow, contact, pad, shScale, ink, w, h };
    out.push(cut0);
    onPiece?.(p.i, cut0);
    await yieldToMain();
  }
  return out;
}

/** How much ink lies within `r` world units of world point (x, y) on a piece placed at (px, py) turned by `a`. */
export function inkNear(c: Cutout, px: number, py: number, a: number, x: number, y: number, r: number): number {
  const ca = Math.cos(-a);
  const sa = Math.sin(-a);
  const dx = x - px;
  const dy = y - py;
  const lx = dx * ca - dy * sa;
  const ly = dx * sa + dy * ca;
  const cx = (lx - c.off[0]) / c.scale;
  const cy = (ly - c.off[1]) / c.scale;
  const R = r / c.scale;
  let n = 0;
  const st = Math.max(1, Math.floor(R / 6));
  for (let yy = Math.floor(cy - R); yy <= cy + R; yy += st) {
    if (yy < 0 || yy >= c.h) continue;
    for (let xx = Math.floor(cx - R); xx <= cx + R; xx += st) {
      if (xx < 0 || xx >= c.w) continue;
      n += c.ink[yy * c.w + xx];
    }
  }
  return n * st * st;
}

/* ---------------- shared between the hero and the result plate ---------------- */

const shared = new Map<string, Promise<Map<string, Cutout>>>();
export const cutoutKey = (src: string, pieces: ScenePiece[]) => `${src}|${pieces.map((p) => p.id).join(",")}`;
/** One set of cut-outs per photo and outline set: whoever asks first makes them, the rest wait for them. */
export function sharedCutouts(key: string, make: () => Promise<Map<string, Cutout>>): Promise<Map<string, Cutout>> {
  let p = shared.get(key);
  if (!p) {
    p = make();
    shared.set(key, p);
    if (shared.size > 4) shared.delete(shared.keys().next().value!);
  }
  return p;
}

/**
 * Where Muse read a seam: the pipeline frames each seam image on the point along the shared edge (at 1/2, 0.35, 0.65,
 * 0.2 or 0.8 of its length) whose window holds the most ink on both sides (seam.ts). The same rule here, so the
 * close-up and the climax show the paper Muse read. Falls back to the middle of the edge.
 */
export function readPoint(line: number[], mid: [number, number], a: { cut: Cutout; x: number; y: number; ang: number }, b: { cut: Cutout; x: number; y: number; ang: number }, K: number): [number, number] {
  if (line.length < 4) return mid;
  const pts: [number, number][] = [[line[0], line[1]]];
  const acc = [0];
  for (let j = 2; j < line.length; j += 2) {
    pts.push([line[j], line[j + 1]]);
    acc.push(acc[acc.length - 1] + Math.hypot(line[j] - line[j - 2], line[j + 1] - line[j - 1]));
  }
  const total = acc[acc.length - 1];
  const at = (d: number): [number, number] => {
    let i = 1;
    while (i < acc.length - 1 && acc[i] < d) i++;
    const u = acc[i] === acc[i - 1] ? 0 : (d - acc[i - 1]) / (acc[i] - acc[i - 1]);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
  };
  // the pipeline's window: 420×150 output px at about 32 px per text line, i.e. about 260×93 page px on a typed letter
  const hw = 130 * K;
  const hh = 46 * K;
  let best: { p: [number, number]; v: number } = { p: at(total / 2), v: -1 };
  for (const frac of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    const p = at(frac * total);
    let ia = 0;
    let ib = 0;
    for (let v = -hh; v <= hh; v += 4) {
      for (let u = -hw; u <= hw; u += 4) {
        ia += inkAt(a.cut, a.x, a.y, a.ang, p[0] + u, p[1] + v);
        ib += inkAt(b.cut, b.x, b.y, b.ang, p[0] + u, p[1] + v);
      }
    }
    const val = Math.min(ia, ib) + 0.01 * (ia + ib);
    if (val > best.v) best = { p, v: val };
  }
  return best.p;
}

function inkAt(c: Cutout, px: number, py: number, a: number, x: number, y: number): number {
  const ca = Math.cos(-a);
  const sa = Math.sin(-a);
  const dx = x - px;
  const dy = y - py;
  const cx = Math.floor((dx * ca - dy * sa - c.off[0]) / c.scale);
  const cy = Math.floor((dx * sa + dy * ca - c.off[1]) / c.scale);
  if (cx < 0 || cy < 0 || cx >= c.w || cy >= c.h) return 0;
  return c.ink[cy * c.w + cx];
}
