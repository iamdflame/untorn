import { describe, expect, it } from "vitest";
import { autoScale, downscaleInput } from "./scale";
import { gridTear, scatterPiece } from "./__tests__/synth";
import { analyzeFragment } from "./fragment";

describe("working scale", () => {
  it("leaves photos at the design point alone and shrinks large ones", () => {
    // Bench-S: pieces of ~130k px², text pitch 17–59 px
    expect(autoScale([90e3, 130e3, 210e3], [20, 35, 59])).toBe(1);
    // a 24 MP phone photo of one page in 10 pieces: ~1 Mpx² pieces, ~100 px pitch
    const k = autoScale([0.4e6, 1.0e6, 1.1e6, 1.6e6], [96, 100, 104]);
    expect(k).toBeGreaterThan(0.36);
    expect(k).toBeLessThan(0.42);
    // pitch alone can trigger (many small pieces of a large photo)
    expect(autoScale([60e3, 80e3], [110, 120])).toBeCloseTo(40 / 120, 2);
  });

  it("resamples a piece onto the working grid: area × k², same place", () => {
    const page = gridTear(400, 360, 2, 2, 5);
    const inp = scatterPiece(page, 1, { theta: 0.4, tx: 700, ty: 500 });
    const k = 0.4;
    const out = downscaleInput(inp, k);
    const area = (m: { data: Uint8Array }) => m.data.reduce((s, v) => s + v, 0);
    expect(area(out.mask) / (area(inp.mask) * k * k)).toBeGreaterThan(0.97);
    expect(area(out.mask) / (area(inp.mask) * k * k)).toBeLessThan(1.03);
    const fa = analyzeFragment(inp, 0)!;
    const fb = analyzeFragment(out, 0)!;
    expect(Math.hypot(fb.centroid[0] - k * fa.centroid[0], fb.centroid[1] - k * fa.centroid[1])).toBeLessThan(0.6);
    expect(out.rgba!.width).toBe(out.mask.width);
    expect(downscaleInput(inp, 1)).toBe(inp);
  });
});
