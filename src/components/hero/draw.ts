// Canvas primitives shared by the hero and the result plate: the paper (two exposures), its shadows and edge light,
// the light table, the drawing frame, balloons and split words. Ported from the e4-exploded reference (round 7).

import type { Cutout } from "./cutouts";

export const TAU = Math.PI * 2;
export const COL = {
  film: "#f0f4f7",
  filmHi: "#fafcfe",
  film2: "#e6eaef",
  ink: "#2a2e34",
  ink2: "#5f636a",
  ink3: "#8f9298",
  violet: "#583bab",
  violetLt: "#b0a4f8",
  red: "#c74c41",
  room: "#332c27",
  room2: "#3f3731",
  chalk: "#f3eee4",
  chalk2: "#c9c3b8",
  chalk3: "#a39d92",
};

export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
export const smooth = (a: number, b: number, x: number) => {
  const u = clamp((x - a) / (b - a));
  return u * u * (3 - 2 * u);
};
export const easeIO = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
export const easeOut = (u: number) => 1 - Math.pow(1 - u, 3);
// heavy spring, low bounce (about 2% overshoot): progress after s seconds
const ZETA = 0.78;
const OMEGA = 9.6;
const OD = OMEGA * Math.sqrt(1 - ZETA * ZETA);
export const spring = (s: number) => (s <= 0 ? 0 : 1 - Math.exp(-ZETA * OMEGA * s) * (Math.cos(OD * s) + ((ZETA * OMEGA) / OD) * Math.sin(OD * s)));
// settle: a small rotation overshoot that dies out after the paper touches down
export const settle = (s: number) => (s <= 0 ? 0 : Math.exp(-6.5 * s) * Math.sin(15 * s));

export type Cam = { s: number; wx: number; wy: number; sx: number; sy: number };
export type Pose = { x: number; y: number; a: number; lift: number; home: number; k: number; sc: number };
export type Box = { x0: number; y0: number; x1: number; y1: number };
export type Rect = { x: number; y: number; w: number; h: number };

export const lerpCam = (a: Cam, b: Cam, u: number): Cam => ({ s: a.s * Math.pow(b.s / a.s, u), wx: lerp(a.wx, b.wx, u), wy: lerp(a.wy, b.wy, u), sx: lerp(a.sx, b.sx, u), sy: lerp(a.sy, b.sy, u) });
export const w2s = (c: Cam, x: number, y: number): [number, number] => [c.sx + (x - c.wx) * c.s, c.sy + (y - c.wy) * c.s];
export const setCam = (g: CanvasRenderingContext2D, c: Cam, dpr: number) => g.setTransform(dpr * c.s, 0, 0, dpr * c.s, dpr * (c.sx - c.wx * c.s), dpr * (c.sy - c.wy * c.s));
export function fit(b: Box, r: Rect, pad = 0): Cam {
  const bw = b.x1 - b.x0;
  const bh = b.y1 - b.y0;
  const s = Math.min((r.w - pad * 2) / bw, (r.h - pad * 2) / bh);
  return { s, wx: (b.x0 + b.x1) / 2, wy: (b.y0 + b.y1) / 2, sx: r.x + r.w / 2, sy: r.y + r.h / 2 };
}

export type Fonts = { serif: string; sans: string; mono: string };

/** The paper. `lit` cross-fades from the photographed exposure to the light-table one. */
export function drawPiece(g: CanvasRenderingContext2D, cut: Cutout | null, ps: Pose, lit = 1) {
  if (!cut) return;
  g.save();
  g.translate(ps.x, ps.y);
  g.rotate(ps.a);
  if (ps.sc !== 1) g.scale(ps.sc, ps.sc);
  g.scale(cut.scale, cut.scale);
  const ox = cut.off[0] / cut.scale;
  const oy = cut.off[1] / cut.scale;
  const a0 = g.globalAlpha;
  if (lit < 1) g.drawImage(cut.plain, ox, oy);
  if (lit > 0) {
    g.globalAlpha = a0 * lit;
    g.drawImage(cut.lit, ox, oy);
    g.globalAlpha = a0;
  }
  g.restore();
}

/** Edge light: the backlight catching the torn fibres along every edge (baked per piece). */
export function edgeLight(g: CanvasRenderingContext2D, cut: Cutout | null, ps: Pose, a: number) {
  if (!cut || a <= 0.01) return;
  g.save();
  g.translate(ps.x, ps.y);
  g.rotate(ps.a);
  if (ps.sc !== 1) g.scale(ps.sc, ps.sc);
  g.scale(cut.scale, cut.scale);
  g.globalAlpha *= a;
  g.drawImage(cut.edge, cut.off[0] / cut.scale - cut.edgePad, cut.off[1] / cut.scale - cut.edgePad);
  g.restore();
}

/** The lift shadow drifts out as the paper rises; the contact shadow tightens as it lands. */
export function drawShadow(g: CanvasRenderingContext2D, cut: Cutout | null, ps: Pose, c: Cam, alpha: number) {
  if (!cut || alpha <= 0.002) return;
  const L = ps.lift;
  const u = cut.scale / cut.shScale; // world units per shadow px
  const ox = cut.off[0] / u - cut.pad;
  const oy = cut.off[1] / u - cut.pad;
  g.save();
  g.globalAlpha = alpha * (0.14 + 0.24 * L);
  g.translate(ps.x + (4 + 20 * L) / c.s, ps.y + (6 + 28 * L) / c.s);
  g.rotate(ps.a);
  g.scale(ps.sc * (1 + 0.03 * L) * u, ps.sc * (1 + 0.03 * L) * u);
  g.drawImage(cut.shadow, ox, oy);
  g.restore();
  g.save();
  g.globalAlpha = alpha * 0.5 * (1 - L);
  g.translate(ps.x + 0.6 / c.s, ps.y + 1.1 / c.s);
  g.rotate(ps.a);
  g.scale(u, u);
  g.drawImage(cut.contact, ox, oy);
  g.restore();
}

export function balloon(g: CanvasRenderingContext2D, x: number, y: number, n: number, alpha: number, fonts: Fonts, r = 11) {
  if (alpha <= 0.01) return;
  g.globalAlpha = alpha;
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fillStyle = COL.filmHi;
  g.fill();
  g.lineWidth = 1.2;
  g.strokeStyle = COL.ink;
  g.stroke();
  g.fillStyle = COL.ink;
  g.font = `600 ${r > 10 ? 12 : 11}px ${fonts.sans}`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(String(n), x, y + 0.5);
  g.globalAlpha = 1;
}

export function haloText(g: CanvasRenderingContext2D, txt: string, x: number, y: number, fill: string, halo: string) {
  g.lineJoin = "round";
  g.lineWidth = 4;
  g.strokeStyle = halo;
  g.strokeText(txt, x, y);
  g.fillStyle = fill;
  g.fillText(txt, x, y);
}

/** A word split by the tear, the bar drawn (never a glyph). */
export function splitWord(g: CanvasRenderingContext2D, l: string, r: string, x: number, y: number, size: number, color: string, halo: string | null, barCol = COL.violet) {
  const w1 = g.measureText(l).width;
  const bw = Math.max(2, size * 0.08);
  const pad = size * 0.1;
  if (halo) {
    g.lineJoin = "round";
    g.lineWidth = 4;
    g.strokeStyle = halo;
    g.strokeText(l, x, y);
    g.strokeText(r, x + w1 + pad * 2 + bw, y);
  }
  g.fillStyle = color;
  g.fillText(l, x, y);
  g.fillStyle = barCol;
  g.fillRect(x + w1 + pad, y - size * 0.74, bw, size * 0.92);
  g.fillStyle = color;
  g.fillText(r, x + w1 + pad * 2 + bw, y);
}

/** The light table: a warm backlit glass under the pages, falling off into the dim room. */
export function lightTable(g: CanvasRenderingContext2D, c: Cam, box: [number, number, number, number], a: number) {
  if (a <= 0.01) return;
  const [x0, y0] = w2s(c, box[0], box[1]);
  const [x1, y1] = w2s(c, box[2], box[3]);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rr = Math.hypot(x1 - x0, y1 - y0) * 0.95;
  const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
  gr.addColorStop(0, "rgba(255,238,208,0.62)");
  gr.addColorStop(0.35, "rgba(250,224,186,0.36)");
  gr.addColorStop(0.7, "rgba(160,128,96,0.10)");
  gr.addColorStop(1, "rgba(51,44,39,0)");
  g.save();
  g.globalAlpha = a;
  g.fillStyle = gr;
  g.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
  g.restore();
}

function arrow(g: CanvasRenderingContext2D, x: number, y: number, d: number) {
  g.beginPath();
  g.moveTo(x + d * 7, y - 3);
  g.lineTo(x, y);
  g.lineTo(x + d * 7, y + 3);
  g.stroke();
}

/** Registration corners on each page's true rectangle, and one dimension line with the page's width in px. */
export function drawFrame(g: CanvasRenderingContext2D, c: Cam, pages: { origin: [number, number]; width: number; height: number }[], a: number, fonts: Fonts, opts: { dimA?: number; dark?: boolean } = {}) {
  if (a <= 0.01 || !pages.length) return;
  const fg = opts.dark ? COL.chalk : COL.ink;
  const fg2 = opts.dark ? COL.chalk2 : COL.ink2;
  const bg = opts.dark ? COL.room : COL.film;
  g.save();
  pages.forEach((pg, n) => {
    const [x0, y0] = w2s(c, pg.origin[0], pg.origin[1]);
    const [x1, y1] = w2s(c, pg.origin[0] + pg.width, pg.origin[1] + pg.height);
    g.globalAlpha = a;
    g.strokeStyle = fg;
    g.lineWidth = 1.4;
    g.setLineDash([]);
    const o = 9;
    const L = 20 * smooth(0, 0.6, a) + 2;
    for (const [x, y, sx, sy] of [
      [x0 - o, y0 - o, 1, 1],
      [x1 + o, y0 - o, -1, 1],
      [x0 - o, y1 + o, 1, -1],
      [x1 + o, y1 + o, -1, -1],
    ]) {
      g.beginPath();
      g.moveTo(x + sx * L, y);
      g.lineTo(x, y);
      g.lineTo(x, y + sy * L);
      g.stroke();
    }
    const da = smooth(0.4, 1, a) * (opts.dimA ?? 1);
    if (n === 0 && da > 0.01) {
      g.globalAlpha = a * da;
      g.lineWidth = 1;
      g.strokeStyle = fg2;
      const yd = y0 - 30;
      g.beginPath();
      g.moveTo(x0, y0 - 18);
      g.lineTo(x0, yd - 6);
      g.moveTo(x1, y0 - 18);
      g.lineTo(x1, yd - 6);
      g.stroke();
      g.beginPath();
      g.moveTo(x0, yd);
      g.lineTo(x1, yd);
      g.stroke();
      arrow(g, x0, yd, 1);
      arrow(g, x1, yd, -1);
      g.font = `500 12.5px ${fonts.sans}`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      const lbl = `${Math.round(pg.width)} px`;
      const tw = g.measureText(lbl).width + 14;
      g.fillStyle = bg;
      g.fillRect((x0 + x1) / 2 - tw / 2, yd - 9, tw, 18);
      g.fillStyle = fg2;
      g.fillText(lbl, (x0 + x1) / 2, yd + 0.5);
    }
  });
  g.restore();
}

export function linePath(line: number[]): Path2D {
  const p = new Path2D();
  for (let j = 0; j < line.length; j += 2) {
    if (j) p.lineTo(line[j], line[j + 1]);
    else p.moveTo(line[j], line[j + 1]);
  }
  return p;
}

export function polyPath(poly: number[]): Path2D {
  const p = linePath(poly);
  p.closePath();
  return p;
}

export function strokeAt(g: CanvasRenderingContext2D, path: Path2D, ox: number, oy: number) {
  g.save();
  g.translate(ox, oy);
  g.stroke(path);
  g.restore();
}

export function readFonts(el: Element): Fonts {
  const cs = getComputedStyle(el);
  const v = (n: string, d: string) => cs.getPropertyValue(n).trim() || d;
  return { serif: v("--serif", "Georgia, serif"), sans: v("--sans", "sans-serif"), mono: v("--mono", "monospace") };
}
