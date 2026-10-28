import { describe, expect, it } from "vitest";
import { traceOutline } from "./contour";
import { analyzeEdges } from "./edges";
import { gridTear, polygonMask, scatterPiece } from "./__tests__/synth";

describe("analyzeEdges", () => {
  it("finds four straight sides and four page corners on a rectangle", () => {
    const pts = traceOutline(polygonMask([20, 20, 220, 20, 220, 150, 20, 150], 240, 170))!;
    const e = analyzeEdges(pts);
    const straight = e.segments.filter((s) => s.kind === "straight");
    expect(straight).toHaveLength(4);
    expect(e.pageCorners).toHaveLength(4);
    const want = [
      [20, 20],
      [220, 20],
      [220, 150],
      [20, 150],
    ];
    for (const [x, y] of want) {
      const d = Math.min(...e.pageCorners.map((c) => Math.hypot(c.x - x, c.y - y)));
      expect(d).toBeLessThan(1.5);
    }
  });

  it("splits a torn corner piece into two page edges and torn edges, with one page corner", () => {
    const page = gridTear(400, 300, 2, 2, 7);
    for (const noise of [0, 0.7]) {
      const frag = scatterPiece(page, 0, { theta: 0.4, tx: 300, ty: 100 }, { noise, colour: false });
      const pts = traceOutline(frag.mask, frag.x0, frag.y0)!;
      const e = analyzeEdges(pts);
      const straight = e.segments.filter((s) => s.kind === "straight");
      const torn = e.segments.filter((s) => s.kind === "torn");
      expect(straight).toHaveLength(2);
      expect(torn.length).toBeGreaterThanOrEqual(1);
      expect(e.pageCorners).toHaveLength(1);
      // the page corner is the page's (0, 0), placed by the pose
      const c = e.pageCorners[0];
      expect(Math.hypot(c.x - 300, c.y - 100)).toBeLessThan(2);
      // straight page edges are long; torn length covers the two ragged sides
      const tornLen = torn.reduce((s, t) => s + t.length, 0);
      expect(tornLen).toBeGreaterThan(200);
    }
  });

  it("classifies a middle piece of a grid (no page edge) as all torn", () => {
    const page = gridTear(600, 600, 3, 3, 11);
    const frag = scatterPiece(page, 4, { theta: -1.1, tx: 500, ty: 500 }, { noise: 0.7, colour: false });
    const pts = traceOutline(frag.mask, frag.x0, frag.y0)!;
    const e = analyzeEdges(pts);
    expect(e.segments.every((s) => s.kind === "torn")).toBe(true);
    expect(e.pageCorners).toHaveLength(0);
  });
});
