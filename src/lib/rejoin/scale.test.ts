import { describe, expect, it } from "vitest";
import { downscaleInput, workingScale } from "./scale";
import { gridTear, scatterPiece } from "./__tests__/synth";
import { analyzeFragment } from "./fragment";
import type { FragmentInput } from "./types";

/** A piece photographed f× closer (nearest-neighbour enlargement). */
function enlarge(inp: FragmentInput, f: number): FragmentInput {
  const W = inp.mask.width * f;
  const H = inp.mask.height * f;
  const data = new Uint8Array(W * H);
  const px = new Uint8ClampedArray(4 * W * H);
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const i = Math.floor(r / f) * inp.mask.width + Math.floor(c / f);
      data[r * W + c] = inp.mask.data[i];
      px.set(inp.rgba!.data.subarray(4 * i, 4 * i + 4), 4 * (r * W + c));
    }
  }
  return { id: inp.id, mask: { width: W, height: H, data }, x0: inp.x0 * f, y0: inp.y0 * f, rgba: { width: W, height: H, data: px } };
}

describe("working scale", () => {
  const page = gridTear(420, 360, 2, 2, 5);
  const pieces = [0, 1, 2, 3].map((k) => scatterPiece(page, k, { theta: 0.3 + k, tx: 500 + 400 * k, ty: 500 }));

  it("brings text lines to the target pitch, and never enlarges", () => {
    // lines every 22 px: already below the 32 px target
    expect(workingScale(pieces).scale).toBe(1);
    const big = pieces.map((p) => enlarge(p, 3));
    const { scale, pitch } = workingScale(big);
    expect(pitch!).toBeGreaterThan(62);
    expect(pitch!).toBeLessThan(70);
    expect(scale).toBeCloseTo(32 / pitch!, 5);
  });

  it("falls back to the pieces' size without text", () => {
    const blank = pieces.map((p) => ({ ...enlarge(p, 4), rgba: undefined }));
    const { scale, pitch } = workingScale(blank);
    expect(pitch).toBeNull();
    expect(scale).toBeLessThan(1);
  });

  it("resamples a piece onto the working grid: area × k², same place", () => {
    const inp = pieces[1];
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
