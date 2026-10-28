// Layout maths for drawing a run: where each rebuilt page sits on the stage, and the CSS matrix that carries a piece
// from where it lies in the photo to its place on the page.

import type { PageOut, Pose, Pt } from "@/lib/run/types";

export type PageSlot = { x: number; y: number; scale: number; width: number; height: number };

/** Lay pages side by side, centred in the photo's frame, scaled to fit (never enlarged). */
export function layoutPages(pages: PageOut[], frameW: number, frameH: number, gapFrac = 0.04): PageSlot[] {
  if (!pages.length) return [];
  const gap = gapFrac * frameW;
  const totalW = pages.reduce((s, p) => s + p.width, 0) + gap * (pages.length - 1);
  const maxH = Math.max(...pages.map((p) => p.height));
  const scale = Math.min(1.6, (0.9 * frameW) / totalW, (0.9 * frameH) / maxH);
  let x = (frameW - totalW * scale) / 2;
  return pages.map((p) => {
    const slot = { x, y: (frameH - p.height * scale) / 2, scale, width: p.width * scale, height: p.height * scale };
    x += (p.width + gap) * scale;
    return slot;
  });
}

/** CSS `matrix()` for photo → page pose, then the page's slot on the stage. */
export function pieceMatrix(pose: Pose, slot: PageSlot): string {
  const c = Math.cos(pose.theta) * slot.scale;
  const s = Math.sin(pose.theta) * slot.scale;
  const e = pose.tx * slot.scale + slot.x;
  const f = pose.ty * slot.scale + slot.y;
  return `matrix(${c.toFixed(6)}, ${s.toFixed(6)}, ${(-s).toFixed(6)}, ${c.toFixed(6)}, ${e.toFixed(2)}, ${f.toFixed(2)})`;
}

export const pointsAttr = (poly: Pt[]) => poly.map(([x, y]) => `${x},${y}`).join(" ");

export function polygonBox(poly: Pt[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/** Turn "?download=1" onto a run file URL (static sample files use the download attribute instead). */
export const downloadUrl = (url: string) => (url.startsWith("/api/") ? `${url}${url.includes("?") ? "&" : "?"}download=1` : url);
