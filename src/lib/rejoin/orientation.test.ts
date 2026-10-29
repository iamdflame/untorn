import { describe, expect, it } from "vitest";
import { axialDiff, poseApply, poseInvert, rng } from "./geom";
import { lineGrid, textOrientation } from "./orientation";
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

  it("measures the line grid to a fraction of a pixel, consistently across rotations", () => {
    // synthetic text: lines every 22 page px; each piece's grid, taken back to page coordinates, must agree
    const phases: number[] = [];
    for (const [k, theta] of [[0, 0.3], [1, 1.2], [2, -0.7], [3, 2.6]] as const) {
      const pose = { theta, tx: 500 + 37 * k, ty: 450 - 23 * k };
      const frag = scatterPiece(page, k, pose, { noise: 0.5 });
      const t = textOrientation(frag.rgba!, frag.mask, depthMap(frag.mask))!;
      expect(t.grid).not.toBeNull();
      expect(t.grid!.period).toBeGreaterThan(21.8);
      expect(t.grid!.period).toBeLessThan(22.2);
      // at the crop centre p: its distance d from grid line 0 along the normal (photo), and its page y; the page's
      // line 0 then sits at y − ±d (the sign follows the axial fold). Measured near the piece, as the solver does.
      const px = frag.x0 + frag.mask.width / 2;
      const py = frag.y0 + frag.mask.height / 2;
      const r0 = t.grid!.offset + (-frag.x0 * Math.sin(t.angle) + frag.y0 * Math.cos(t.angle));
      const d = -px * Math.sin(t.angle) + py * Math.cos(t.angle) - r0;
      const sign = Math.cos(t.angle - theta) > 0 ? 1 : -1;
      const [, qy] = poseApply(poseInvert(pose), px, py);
      const v = qy - sign * d;
      phases.push(((v % 22) + 22) % 22);
    }
    const ref = phases[0];
    for (const p of phases) {
      const d = Math.abs(((p - ref + 33) % 22) - 11);
      expect(d).toBeLessThan(0.8);
    }
  });

  it("reads the short text lines of a narrow strip, not the strip's length", () => {
    // a strip of a page's left margin (90 × 420 px): lines every 24 px start at the same x and run off the strip's
    // right edge, so projecting along the strip is as peaky as projecting along the lines; only the lines are periodic
    for (const theta of [0.2, 1.4, -1.0]) {
      const W = 90;
      const H = 420;
      const size = 520;
      const mask = new Uint8Array(size * size);
      const data = new Uint8ClampedArray(4 * size * size);
      const rand = rng(11);
      const strokes = Array.from({ length: 400 }, () => rand());
      const c = Math.cos(theta);
      const s = Math.sin(theta);
      for (let r = 0; r < size; r++) {
        for (let q = 0; q < size; q++) {
          // photo → strip coordinates (rotation about the centre)
          const dx = q + 0.5 - size / 2;
          const dy = r + 0.5 - size / 2;
          const u = c * dx + s * dy + W / 2;
          const v = -s * dx + c * dy + H / 2;
          const k = 4 * (r * size + q);
          data[k + 3] = 255;
          if (u < 0 || v < 0 || u >= W || v >= H) {
            data.set([110, 85, 60], k);
            continue;
          }
          mask[r * size + q] = 1;
          const line = Math.floor(v / 24);
          const inLine = v - 24 * line;
          const col = Math.floor(u / 2.3);
          const ink = u > 12 && inLine >= 7 && inLine < 14 && strokes[(col * 7 + line * 13) % 400] > 0.45;
          const asc = u > 12 && inLine >= 2 && inLine < 7 && strokes[(col * 11 + line * 5) % 400] > 0.85;
          data.set(ink || asc ? [45, 45, 60] : [236, 232, 222], k);
        }
      }
      const m = { width: size, height: size, data: mask };
      const t = textOrientation({ width: size, height: size, data }, m, depthMap(m))!;
      expect((axialDiff(t.angle, theta) * 180) / Math.PI).toBeLessThan(1.5);
      expect(t.grid!.regularity).toBeGreaterThan(0.35);
    }
  });

  it("finds the period and offset of a periodic profile", () => {
    const R = 300;
    const prof = new Float64Array(2 * R + 1);
    for (let b = 0; b < prof.length; b++) {
      const r = b - R;
      for (let j = -20; j <= 20; j++) prof[b] += Math.exp(-(((r - (7.3 + 21.6 * j)) / 2.5) ** 2));
    }
    const g = lineGrid(prof, R, 22)!;
    expect(Math.abs(g.period - 21.6)).toBeLessThan(0.03);
    expect(Math.abs(g.offset - 7.3)).toBeLessThan(0.2);
    expect(g.regularity).toBeGreaterThan(0.5);
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
