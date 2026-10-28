import { describe, expect, it } from "vitest";
import { axialDiff } from "./geom";
import { textOrientation } from "./orientation";
import { depthMap } from "./raster";
import { gridTear, scatterPiece } from "./__tests__/synth";

describe("textOrientation", () => {
  const page = gridTear(420, 360, 2, 2, 3);

  it.each([0.3, 1.2, 2.0, -0.7, -2.6])("finds the text-line angle and which way is up (rotation %f rad)", (theta) => {
    const frag = scatterPiece(page, 3, { theta, tx: 400, ty: 400 }, { noise: 0.5 });
    const t = textOrientation(frag.rgba!, frag.mask, depthMap(frag.mask))!;
    expect(t).not.toBeNull();
    expect((axialDiff(t.angle, theta) * 180) / Math.PI).toBeLessThan(0.6);
    expect(t.confidence).toBeGreaterThan(0.5);
    expect(t.pitch).toBeGreaterThan(20);
    expect(t.pitch).toBeLessThan(24);
    // reading direction = angle when up = +1, angle + π when up = −1; the page's reading direction is theta
    const reading = t.up === 1 ? t.angle : t.angle + Math.PI;
    expect(t.up).not.toBe(0);
    expect(Math.abs(Math.atan2(Math.sin(reading - theta), Math.cos(reading - theta)))).toBeLessThan(0.05);
  });

  it("returns null on a blank piece", () => {
    const frag = scatterPiece(page, 0, { theta: 0.5, tx: 300, ty: 300 });
    const rgba = frag.rgba!;
    for (let i = 0; i < rgba.data.length; i += 4) {
      if (!frag.mask.data[i / 4]) continue;
      rgba.data[i] = 236;
      rgba.data[i + 1] = 232;
      rgba.data[i + 2] = 222;
    }
    expect(textOrientation(rgba, frag.mask, depthMap(frag.mask))).toBeNull();
  });
});
