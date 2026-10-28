import { describe, expect, it } from "vitest";
import { traceOutline, perimeter } from "./contour";
import { signedArea } from "./geom";
import { polygonMask } from "./__tests__/synth";
import type { Mask } from "./types";

function disk(w: number, h: number, cx: number, cy: number, r: number): Mask {
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r ? 1 : 0;
  return { width: w, height: h, data };
}

describe("traceOutline", () => {
  it("traces a disk to subpixel accuracy with ~1 px spacing and positive area", () => {
    const pts = traceOutline(disk(120, 120, 60.3, 59.7, 45), 0, 0, { smooth: 0.5 })!;
    expect(pts).not.toBeNull();
    const n = pts.length / 2;
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(Math.hypot(pts[2 * i] - 60.3, pts[2 * i + 1] - 59.7) - 45));
    expect(worst).toBeLessThan(0.45);
    expect(signedArea(pts)).toBeGreaterThan(0);
    expect(Math.abs(signedArea(pts) - Math.PI * 45 * 45) / (Math.PI * 45 * 45)).toBeLessThan(0.01);
    expect(perimeter(pts) / n).toBeGreaterThan(0.95);
    expect(perimeter(pts) / n).toBeLessThan(1.05);
  });

  it("places the outline in photo coordinates via the crop offset", () => {
    const a = traceOutline(disk(60, 60, 30, 30, 20))!;
    const b = traceOutline(disk(60, 60, 30, 30, 20), 1000, 500)!;
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i += 2) {
      expect(b[i] - a[i]).toBeCloseTo(1000, 9);
      expect(b[i + 1] - a[i + 1]).toBeCloseTo(500, 9);
    }
  });

  it("keeps the largest region and ignores holes and specks", () => {
    const m = disk(140, 100, 50, 50, 40);
    for (let y = 40; y < 60; y++) for (let x = 40; x < 60; x++) m.data[y * 140 + x] = 0; // hole
    for (let y = 10; y < 14; y++) for (let x = 120; x < 124; x++) m.data[y * 140 + x] = 1; // speck
    const pts = traceOutline(m)!;
    const area = signedArea(pts);
    expect(area).toBeGreaterThan(Math.PI * 40 * 40 * 0.98);
    let maxX = 0;
    for (let i = 0; i < pts.length; i += 2) maxX = Math.max(maxX, pts[i]);
    expect(maxX).toBeLessThan(95);
  });

  it("follows a rectangle's straight sides", () => {
    const m = polygonMask([10, 10, 110, 10, 110, 70, 10, 70], 120, 80);
    const pts = traceOutline(m)!;
    let onSide = 0;
    for (let i = 0; i < pts.length; i += 2) {
      const x = pts[i];
      const y = pts[i + 1];
      const d = Math.min(Math.abs(x - 10), Math.abs(x - 110), Math.abs(y - 10), Math.abs(y - 70));
      if (d < 0.25) onSide++;
    }
    expect(onSide / (pts.length / 2)).toBeGreaterThan(0.9);
  });

  it("returns null for an empty mask", () => {
    expect(traceOutline({ width: 10, height: 10, data: new Uint8Array(100) })).toBeNull();
  });
});
