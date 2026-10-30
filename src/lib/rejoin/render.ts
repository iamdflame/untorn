// A minimal raster compositor for a rebuilt page, and PNG encoding (fast-png, pure JS: browser and Node).

import { encode } from "fast-png";
import { poseApply, poseInvert } from "./geom";
import { sampleRgba } from "./raster";
import type { Fragment, Page, Rgba } from "./types";

export type PageRenderOptions = {
  /** Output px per page px. */
  scale?: number;
  /** RGBA behind the pieces; default transparent. */
  background?: [number, number, number, number];
  /** Margin around the page (page px). */
  margin?: number;
};

/** Composite a page's fragments at their poses. Later fragments paint over earlier ones where noise makes them overlap. */
export function renderPage(page: Page, frags: Fragment[] | Map<string, Pick<Fragment, "input">>, opts: PageRenderOptions = {}): Rgba {
  const byId: Map<string, Pick<Fragment, "input">> = frags instanceof Map ? frags : new Map(frags.map((f) => [f.id, f] as const));
  const scale = opts.scale ?? 1;
  const margin = opts.margin ?? 8;
  const bg = opts.background ?? [0, 0, 0, 0];
  const width = Math.ceil((page.width + 2 * margin) * scale);
  const height = Math.ceil((page.height + 2 * margin) * scale);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(bg, 4 * i);
  const px = new Float64Array(4);
  for (const placed of page.fragments) {
    const f = byId.get(placed.id);
    if (!f || !f.input.rgba) continue;
    const { mask, x0, y0, rgba } = f.input;
    const inv = poseInvert(placed.pose);
    // bounding box of the fragment in output pixels
    let minx = Infinity;
    let miny = Infinity;
    let maxx = -Infinity;
    let maxy = -Infinity;
    for (const [cx, cy] of [
      [x0, y0],
      [x0 + mask.width, y0],
      [x0, y0 + mask.height],
      [x0 + mask.width, y0 + mask.height],
    ]) {
      const [x, y] = poseApply(placed.pose, cx, cy);
      minx = Math.min(minx, x);
      miny = Math.min(miny, y);
      maxx = Math.max(maxx, x);
      maxy = Math.max(maxy, y);
    }
    const u0 = Math.max(0, Math.floor((minx + margin) * scale));
    const v0 = Math.max(0, Math.floor((miny + margin) * scale));
    const u1 = Math.min(width, Math.ceil((maxx + margin) * scale) + 1);
    const v1 = Math.min(height, Math.ceil((maxy + margin) * scale) + 1);
    for (let v = v0; v < v1; v++) {
      for (let u = u0; u < u1; u++) {
        const [fx, fy] = poseApply(inv, (u + 0.5) / scale - margin, (v + 0.5) / scale - margin);
        const c = Math.floor(fx - x0);
        const r = Math.floor(fy - y0);
        if (c < 0 || r < 0 || c >= mask.width || r >= mask.height || !mask.data[r * mask.width + c]) continue;
        sampleRgba(rgba, fx - x0, fy - y0, px);
        const k = 4 * (v * width + u);
        data[k] = px[0];
        data[k + 1] = px[1];
        data[k + 2] = px[2];
        data[k + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

/** Encode an RGBA raster as PNG bytes. */
export function encodePng(img: Rgba): Uint8Array {
  return encode({ width: img.width, height: img.height, data: img.data as Uint8Array, channels: 4, depth: 8 });
}
