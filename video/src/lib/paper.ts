// The paper on the light table, drawn the way the app draws it (a port of src/components/hero/draw.ts): two exposures
// cross-faded, a lift shadow that drifts out as the paper rises, a contact shadow that tightens as it lands, the edge
// light catching the torn fibres, and the warm light-table glow. World units are the photo's pixels.

import { C } from "../theme";

export type Cam = { s: number; wx: number; wy: number; sx: number; sy: number; roll?: number };
export type Rect = { x: number; y: number; w: number; h: number };
export type Box = { x0: number; y0: number; x1: number; y1: number };

export const camLerp = (a: Cam, b: Cam, u: number): Cam => ({
  s: a.s * Math.pow(b.s / a.s, u),
  wx: a.wx + (b.wx - a.wx) * u,
  wy: a.wy + (b.wy - a.wy) * u,
  sx: a.sx + (b.sx - a.sx) * u,
  sy: a.sy + (b.sy - a.sy) * u,
  roll: (a.roll ?? 0) + ((b.roll ?? 0) - (a.roll ?? 0)) * u,
});
/**
 * A camera move that keeps its focus steady on screen while zooming: interpolate the zoom in log space and the
 * world point so that a point fixed on screen does not swim (the classic "zoom to point" path).
 */
export const camZoomPath = (a: Cam, b: Cam, u: number): Cam => {
  const s = a.s * Math.pow(b.s / a.s, u);
  // weight the world-position blend by the zoom so the frame centre travels evenly in screen terms
  const k = a.s === b.s ? u : (1 / s - 1 / a.s) / (1 / b.s - 1 / a.s);
  return { s, wx: a.wx + (b.wx - a.wx) * k, wy: a.wy + (b.wy - a.wy) * k, sx: a.sx + (b.sx - a.sx) * u, sy: a.sy + (b.sy - a.sy) * u, roll: (a.roll ?? 0) + ((b.roll ?? 0) - (a.roll ?? 0)) * u };
};
export const w2s = (c: Cam, x: number, y: number): [number, number] => {
  const r = c.roll ?? 0;
  const dx = (x - c.wx) * c.s;
  const dy = (y - c.wy) * c.s;
  return [c.sx + dx * Math.cos(r) - dy * Math.sin(r), c.sy + dx * Math.sin(r) + dy * Math.cos(r)];
};
export const s2w = (c: Cam, x: number, y: number): [number, number] => {
  const r = -(c.roll ?? 0);
  const dx = x - c.sx;
  const dy = y - c.sy;
  return [c.wx + (dx * Math.cos(r) - dy * Math.sin(r)) / c.s, c.wy + (dx * Math.sin(r) + dy * Math.cos(r)) / c.s];
};
/** World to screen on the canvas: scale, roll about the screen point, translate. */
export const setCam = (g: CanvasRenderingContext2D, c: Cam) => {
  const r = c.roll ?? 0;
  const a = c.s * Math.cos(r);
  const b = c.s * Math.sin(r);
  g.setTransform(a, b, -b, a, c.sx - (a * c.wx - b * c.wy), c.sy - (b * c.wx + a * c.wy));
};
export function fit(b: Box, r: Rect, pad = 0): Cam {
  const s = Math.min((r.w - pad * 2) / (b.x1 - b.x0), (r.h - pad * 2) / (b.y1 - b.y0));
  return { s, wx: (b.x0 + b.x1) / 2, wy: (b.y0 + b.y1) / 2, sx: r.x + r.w / 2, sy: r.y + r.h / 2 };
}

export type CutMeta = { off: [number, number]; scale: number; w: number; h: number; pad: number; shScale: number; edgePad: number };
export type Cut = CutMeta & { lit: HTMLImageElement; plain: HTMLImageElement; edge: HTMLImageElement; shadow: HTMLImageElement; contact: HTMLImageElement };

/** Where a piece is drawn: centroid (world), turn (rad), lift 0-1, extra scale (flight), bank (foreshortening). */
export type PoseNow = { x: number; y: number; a: number; lift: number; sc: number; bank?: number };

function place(g: CanvasRenderingContext2D, ps: PoseNow) {
  g.translate(ps.x, ps.y);
  g.rotate(ps.a);
  // banking on the arc: a slight foreshortening across the direction of travel, as if the sheet tilts
  if (ps.bank) g.transform(1 - Math.abs(ps.bank) * 0.08, ps.bank * 0.05, 0, 1, 0, 0);
  if (ps.sc !== 1) g.scale(ps.sc, ps.sc);
}

/** The paper. `lit` cross-fades from the photographed exposure to the light-table one. */
export function drawPiece(g: CanvasRenderingContext2D, cut: Cut, ps: PoseNow, lit = 1, alpha = 1) {
  g.save();
  place(g, ps);
  g.scale(cut.scale, cut.scale);
  const ox = cut.off[0] / cut.scale;
  const oy = cut.off[1] / cut.scale;
  if (lit < 1) {
    g.globalAlpha = alpha;
    g.drawImage(cut.plain, ox, oy);
  }
  if (lit > 0) {
    g.globalAlpha = alpha * lit;
    g.drawImage(cut.lit, ox, oy);
  }
  g.restore();
}

export function edgeLight(g: CanvasRenderingContext2D, cut: Cut, ps: PoseNow, a: number) {
  if (a <= 0.01) return;
  g.save();
  place(g, ps);
  g.scale(cut.scale, cut.scale);
  g.globalAlpha = a;
  g.drawImage(cut.edge, cut.off[0] / cut.scale - cut.edgePad, cut.off[1] / cut.scale - cut.edgePad);
  g.restore();
}

/** The lift shadow drifts out as the paper rises (about 20 x 28 screen px at full lift); the contact shadow tightens. */
export function drawShadow(g: CanvasRenderingContext2D, cut: Cut, ps: PoseNow, camS: number, alpha: number, depth = 1) {
  if (alpha <= 0.002) return;
  const L = ps.lift;
  const u = cut.scale / cut.shScale;
  const ox = cut.off[0] / u - cut.pad;
  const oy = cut.off[1] / u - cut.pad;
  g.save();
  g.globalAlpha = alpha * (0.14 + 0.24 * L);
  g.translate(ps.x + ((4 + 20 * L) * depth) / camS, ps.y + ((6 + 28 * L) * depth) / camS);
  g.rotate(ps.a);
  const k = ps.sc * (1 + 0.03 * L);
  g.scale(k * u, k * u);
  g.drawImage(cut.shadow, ox, oy);
  g.restore();
  g.save();
  g.globalAlpha = alpha * 0.5 * (1 - L);
  g.translate(ps.x + 0.6 / camS, ps.y + 1.1 / camS);
  g.rotate(ps.a);
  g.scale(u, u);
  g.drawImage(cut.contact, ox, oy);
  g.restore();
}

/** The light table: warm backlit glass under the pages, falling off into the dim room (screen space). */
export function lightTable(g: CanvasRenderingContext2D, cx: number, cy: number, rr: number, a: number) {
  if (a <= 0.01) return;
  const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
  gr.addColorStop(0, "rgba(255,238,208,0.62)");
  gr.addColorStop(0.35, "rgba(250,224,186,0.36)");
  gr.addColorStop(0.7, "rgba(160,128,96,0.10)");
  gr.addColorStop(1, "rgba(51,44,39,0)");
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = a;
  g.fillStyle = gr;
  g.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
  g.restore();
}

export function polyPath(poly: number[], ox = 0, oy = 0): Path2D {
  const p = new Path2D();
  for (let j = 0; j < poly.length; j += 2) {
    if (j) p.lineTo(poly[j] + ox, poly[j + 1] + oy);
    else p.moveTo(poly[j] + ox, poly[j + 1] + oy);
  }
  p.closePath();
  return p;
}
export function linePath(line: number[]): Path2D {
  const p = new Path2D();
  for (let j = 0; j < line.length; j += 2) {
    if (j) p.lineTo(line[j], line[j + 1]);
    else p.moveTo(line[j], line[j + 1]);
  }
  return p;
}
export const polyLength = (poly: number[], closed = true) => {
  let L = 0;
  for (let j = 2; j < poly.length; j += 2) L += Math.hypot(poly[j] - poly[j - 2], poly[j + 1] - poly[j - 1]);
  if (closed && poly.length > 2) L += Math.hypot(poly[0] - poly[poly.length - 2], poly[1] - poly[poly.length - 1]);
  return L;
};

/** The room: flat warm dark with a soft vignette (screen space). */
export function room(g: CanvasRenderingContext2D, w: number, h: number) {
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = C.room;
  g.fillRect(0, 0, w, h);
  const v = g.createRadialGradient(w / 2, h * 0.48, h * 0.35, w / 2, h * 0.5, h * 1.05);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(18,13,10,0.42)");
  g.fillStyle = v;
  g.fillRect(0, 0, w, h);
  g.restore();
}
