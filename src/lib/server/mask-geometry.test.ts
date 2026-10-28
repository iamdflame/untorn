import { describe, expect, it } from "vitest";
import { boundaryCentres, distanceToRing, evaluateMasks, rasterizePolygon } from "./mask-eval";
import {
  cleanFragmentMask,
  fillHoles,
  interiorPoints,
  largestComponent,
  maskArea,
  maskBox,
  maskIoU,
  polygonArea,
  robustSeparation,
  snapToPaperEdge,
  traceOutline,
  upsampleMask,
  type PlacedMask,
  type Point,
} from "./mask-geometry";

const blank = (x: number, y: number, w: number, h: number): PlacedMask => ({ x, y, width: w, height: h, data: new Uint8Array(w * h) });
function fillRect(m: PlacedMask, x0: number, y0: number, x1: number, y1: number) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m.data[(y - m.y) * m.width + (x - m.x)] = 1;
}
const star = (cx: number, cy: number, r: number, n = 40): Point[] =>
  Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    const rr = r * (i % 2 ? 0.8 : 1);
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)] as Point;
  });

describe("outlines", () => {
  it("traces a rectangle on its pixel edges (corners cut by half a pixel)", () => {
    const m = blank(10, 20, 30, 20);
    fillRect(m, 15, 25, 35, 35);
    const poly = traceOutline(m, 0.1);
    expect(poly).toHaveLength(8);
    expect(polygonArea(poly)).toBeCloseTo(200 - 0.5, 6);
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([15, 35, 25, 35]);
  });

  it("traces a rasterised polygon within a pixel of the true outline", () => {
    const truth = star(60, 60, 40);
    const m = rasterizePolygon(truth);
    const poly = traceOutline(m, 0.5);
    expect(Math.abs(polygonArea(poly) - polygonArea(truth)) / polygonArea(truth)).toBeLessThan(0.01);
    const d = poly.map((p) => distanceToRing(p, truth));
    expect(Math.max(...d)).toBeLessThan(1.2);
  });

  it("keeps the largest component, fills holes and trims", () => {
    const m = blank(0, 0, 20, 20);
    fillRect(m, 2, 2, 12, 12);
    fillRect(m, 15, 15, 17, 17);
    m.data[5 * 20 + 5] = 0; // a hole
    const c = cleanFragmentMask(m);
    expect(maskBox(c)).toEqual([2, 2, 11, 11]);
    expect(maskArea(c)).toBe(100);
    expect(maskArea(largestComponent(m))).toBe(99);
    expect(maskArea(fillHoles(m))).toBe(104);
  });
});

describe("prompt points and colour separation", () => {
  it("puts spread-out points deep inside a long thin piece", () => {
    const m = blank(0, 0, 200, 30);
    fillRect(m, 0, 5, 200, 25);
    const pts = interiorPoints(m, 3);
    expect(pts).toHaveLength(3);
    for (const [, y] of pts) expect(Math.abs(y - 15)).toBeLessThanOrEqual(1);
    const xs = pts.map((p) => p[0]).sort((a, b) => a - b);
    expect(xs[1] - xs[0]).toBeGreaterThan(50);
    expect(xs[2] - xs[1]).toBeGreaterThan(50);
  });

  it("scores paper on a desk far apart and ignores ink outliers, white on white close", () => {
    const paper = Array.from({ length: 200 }, (_, i) => (i % 10 === 0 ? [40, 40, 60] : [236 + (i % 5), 232, 220]));
    const desk = Array.from({ length: 200 }, (_, i) => [128 + (i % 7), 92 + (i % 3), 62]);
    const whiteTable = Array.from({ length: 200 }, (_, i) => [230 + (i % 9), 228 + (i % 5), 222]);
    expect(robustSeparation(paper, desk)!).toBeGreaterThan(10);
    expect(robustSeparation(paper, whiteTable)!).toBeLessThan(3);
    expect(robustSeparation(paper.slice(0, 5), desk)).toBeNull();
  });
});

describe("evaluation (port of eval_masks.py)", () => {
  it("scores a perfect raster at IoU ~1 and half a pixel of boundary error at most", () => {
    const truth = star(100, 80, 50);
    const { summary } = evaluateMasks([{ piece: 0, photo_polygon: truth }], [rasterizePolygon(truth)]);
    expect(summary.detected).toBe(1);
    expect(summary.meanIoU).toBeGreaterThan(0.999);
    expect(summary.medianBoundaryPx).toBeLessThanOrEqual(0.5);
  });

  it("measures a 2-pixel shift as ~2 px of error, and reports misses and extra masks", () => {
    const truth = star(100, 80, 50);
    const shifted = { ...rasterizePolygon(truth) };
    shifted.x += 2;
    const extra = blank(400, 400, 10, 10);
    fillRect(extra, 400, 400, 410, 410);
    const r = evaluateMasks([{ piece: 0, photo_polygon: truth }, { piece: 1, photo_polygon: star(300, 300, 20) }], [shifted, extra]);
    expect(r.pieces[0].boundary!.median).toBeGreaterThan(0.8);
    expect(r.pieces[0].boundary!.max).toBeLessThan(3.5);
    expect(r.summary.missed).toEqual([1]);
    expect(r.summary.unmatchedMasks).toEqual([1]);
    expect(boundaryCentres(extra)).toHaveLength(36);
  });
});

describe("snapping a coarse mask to the paper edge", () => {
  it("recovers a sharp outline from a 3x-downscaled mask, with ink touching the edge", () => {
    const W = 240, H = 200;
    const truth = star(120, 100, 70, 36);
    const gt = rasterizePolygon(truth);
    const rgb = { width: W, height: H, data: new Uint8Array(W * H * 3) };
    let seed = 1;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 8;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const gx = x - gt.x, gy = y - gt.y;
        const paper = gx >= 0 && gy >= 0 && gx < gt.width && gy < gt.height && gt.data[gy * gt.width + gx] === 1;
        const ink = paper && y % 14 < 3; // typed lines running into the tear
        const c = ink ? [50, 55, 110] : paper ? [225, 220, 205] : [125, 90, 60];
        for (let k = 0; k < 3; k++) rgb.data[(y * W + x) * 3 + k] = Math.max(0, Math.min(255, c[k] + noise()));
      }
    }
    // a coarse mask at 1/3 resolution, as pass 1 would see it
    const s = 3;
    const coarse = blank(0, 0, Math.ceil(W / s), Math.ceil(H / s));
    for (let y = 0; y < coarse.height; y++)
      for (let x = 0; x < coarse.width; x++) {
        const gx = Math.floor((x + 0.5) * s) - gt.x, gy = Math.floor((y + 0.5) * s) - gt.y;
        coarse.data[y * coarse.width + x] = gx >= 0 && gy >= 0 && gx < gt.width && gy < gt.height ? gt.data[gy * gt.width + gx] : 0;
      }
    const region = { x: 0, y: 0, width: W, height: H };
    const soft = upsampleMask(coarse, s, region);
    const coarseFull = { ...region, data: Uint8Array.from(soft, (v) => (v >= 0.5 ? 1 : 0)) };
    const { mask, separation } = snapToPaperEdge(rgb, soft, region, 5);
    expect(separation).toBeGreaterThan(6);
    const after = evaluateMasks([{ piece: 0, photo_polygon: truth }], [mask]).summary;
    const was = evaluateMasks([{ piece: 0, photo_polygon: truth }], [coarseFull]).summary;
    expect(after.medianBoundaryPx).toBeLessThan(0.75);
    expect(after.medianBoundaryPx).toBeLessThan(was.medianBoundaryPx);
    expect(maskIoU(mask, gt)).toBeGreaterThan(0.98);
  });
});
