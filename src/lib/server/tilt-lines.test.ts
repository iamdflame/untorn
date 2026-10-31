import { describe, expect, it } from "vitest";
import { focalPx, rotationMap } from "./rectify";
import { tiltFromLines, type LineSample } from "./tilt-lines";

const W = 4000;
const H = 3000;
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

/** Pieces on a 4 × 3 grid of the table with text lines `period(i)` apart, photographed through gravity `g`. */
function photographed(g: [number, number, number], period: (i: number) => number, f35 = 26): LineSample[] {
  const m = rotationMap(W, H, focalPx(W, H, f35), g);
  const out: LineSample[] = [];
  for (let i = 0; i < 12; i++) {
    const [x, y] = [W * (0.15 + 0.23 * (i % 4)), H * (0.2 + 0.3 * Math.floor(i / 4))];
    // the piece's place and line direction seen straight down, then mapped back into the photo
    const [qx, qy] = m.fwd(x, y);
    const a = rnd() * Math.PI;
    const p = period(i);
    const A = m.inv(qx, qy);
    const T = m.inv(qx + 50 * Math.cos(a), qy + 50 * Math.sin(a));
    const N = m.inv(qx - p * Math.sin(a), qy + p * Math.cos(a));
    const tl = Math.hypot(T[0] - A[0], T[1] - A[1]);
    const angle = Math.atan2(T[1] - A[1], T[0] - A[0]);
    const period_ = Math.abs(((T[0] - A[0]) * (N[1] - A[1]) - (T[1] - A[1]) * (N[0] - A[0])) / tl);
    out.push({ x: A[0], y: A[1], angle, period: period_, weight: 0.7 });
  }
  return out;
}
const tilt = (deg: number, toward: number): [number, number, number] => {
  const t = (deg * Math.PI) / 180;
  const p = (toward * Math.PI) / 180;
  return [Math.sin(t) * Math.cos(p), Math.sin(t) * Math.sin(p), Math.cos(t)];
};
const angleBetween = (a: number[], b: number[]) => (Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])) * 180) / Math.PI;

describe("tiltFromLines", () => {
  it("finds a 12° tilt from the line spacing alone and straightens it", () => {
    const g = tilt(12, 180);
    const r = tiltFromLines(photographed(g, () => 80 * (1 + 0.02 * (rnd() - 0.5))), W, H)!;
    expect(r.straighten).toBe(true);
    expect(Math.abs(r.tiltDeg - 12)).toBeLessThan(1.5);
    expect(angleBetween(r.gravity, g)).toBeLessThan(2);
    expect(r.spreadBefore).toBeGreaterThan(0.07);
    expect(r.spreadAfter).toBeLessThan(0.02);
  });

  it("leaves a photo taken straight down alone, even with uneven spacing", () => {
    const r = tiltFromLines(photographed([0, 0, 1], () => 80 * (1 + 0.1 * (rnd() - 0.5))), W, H)!;
    expect(r.straighten).toBe(false);
  });

  it("leaves a mixed bag alone: two pages with different line spacing are not a tilt", () => {
    const r = tiltFromLines(photographed([0, 0, 1], (i) => (i % 3 === 0 ? 100 : 80)), W, H)!;
    expect(r.straighten).toBe(false);
    expect(r.pieces).toBe(8);
  });

  it("is not fooled by pieces that read a harmonic or a letterhead (the samples' failure)", () => {
    const odd = (i: number) => (i === 1 ? 45 : i === 6 ? 265 : 80 * (1 + 0.01 * (rnd() - 0.5)));
    expect(tiltFromLines(photographed([0, 0, 1], odd), W, H)!.straighten).toBe(false);
    // one stray piece in twelve is tolerated; two are too many to act on (a stack of documents looks like that)
    const one = (i: number) => (i === 6 ? 265 : 80 * (1 + 0.01 * (rnd() - 0.5)));
    const r = tiltFromLines(photographed(tilt(12, 30), one), W, H)!;
    expect(r.straighten).toBe(true);
    expect(Math.abs(r.tiltDeg - 12)).toBeLessThan(1.5);
    expect(r.pieces).toBe(11);
    expect(tiltFromLines(photographed(tilt(12, 30), odd), W, H)!.straighten).toBe(false);
  });

  it("leaves a small tilt alone (the solver absorbs it)", () => {
    const r = tiltFromLines(photographed(tilt(3, 90), () => 80), W, H)!;
    expect(r.straighten).toBe(false);
  });

  it("needs five pieces with lines", () => {
    expect(tiltFromLines(photographed(tilt(12, 0), () => 80).slice(0, 4), W, H)).toBeNull();
  });
});
