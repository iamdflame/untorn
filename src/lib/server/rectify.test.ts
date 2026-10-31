import { describe, expect, it } from "vitest";
import { MIN_TILT_DEG, rectifyRgb, tiltMap } from "./rectify";

// the user's landscape photo: 11.6°, its top edge (device +y) to the right of the upright photo (orientation 3)
const tilted = { gravity: [-0.006343, -0.199797, -0.972921] as [number, number, number], f35: 24, orientation: 3 };

describe("tiltMap", () => {
  it("maps a photo pixel to the straight view and back", () => {
    const m = tiltMap(5712, 4284, tilted)!;
    for (const [x, y] of [[0, 0], [5712, 0], [2856, 2142], [100, 4000]]) {
      const [qx, qy] = m.fwd(x, y);
      const [bx, by] = m.inv(qx, qy);
      expect(bx).toBeCloseTo(x, 6);
      expect(by).toBeCloseTo(y, 6);
    }
    expect(m.tiltDeg).toBeCloseTo(11.6, 1);
  });

  it("enlarges the far side of the table: on the user's photo, its right side", () => {
    const m = tiltMap(5712, 4284, tilted)!;
    const span = (x: number) => {
      const a = m.fwd(x, 2000);
      const b = m.fwd(x, 2200);
      return Math.hypot(a[0] - b[0], a[1] - b[1]);
    };
    // 200 px near the right edge become more than 200 px near the left edge do: pitch 63-67 px right, 85-90 left
    expect(span(5400) / span(300)).toBeGreaterThan(1.2);
  });
});

describe("rectifyRgb", () => {
  const rgb = (w: number, h: number) => ({ width: w, height: h, data: new Uint8Array(w * h * 3).fill(128) });

  it("leaves a photo taken straight down alone", () => {
    expect(rectifyRgb(rgb(64, 48), { gravity: [0, -0.02, -1], f35: 24, orientation: 6 })).toBeNull();
    expect(MIN_TILT_DEG).toBeGreaterThan(1.4); // the real page at 1.4° rebuilt 9 of 10 untouched
  });

  it("straightens a tilted one into a frame that holds every corner, within the pixel cap", () => {
    const r = rectifyRgb(rgb(120, 90), tilted)!;
    expect(r.tiltDeg).toBeCloseTo(11.6, 1);
    expect(r.rgb.width * r.rgb.height).toBeLessThanOrEqual(1.3 * 120 * 90 + 300);
    expect(r.rgb.data.length).toBe(r.rgb.width * r.rgb.height * 3);
  });

  it("refuses an extreme angle", () => {
    expect(rectifyRgb(rgb(64, 48), { gravity: [0, -0.7, -0.7], f35: 24, orientation: 6 })).toBeNull();
  });
});
