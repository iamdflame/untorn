import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeMask, maskArea, maskBounds, maskEncoding, maskMeanRow, maskOutlinePath } from "./mask";
import { parseSamText, type RawObject } from "./parse";

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");
const objects = (name: string): RawObject[] => parseSamText(fixture(name)).flatMap((f) => f.objects);

const real = [
  ...objects("concept-head-sl142.sam.txt").map((o) => ({ o, enc: "lossless" })),
  ...objects("point-head-sl142.sam.txt").map((o) => ({ o, enc: "one_bit" })),
  ...objects("image-head-sl142.sam.txt").map((o) => ({ o, enc: "one_bit" })),
];

describe("decodeMask on real SAM 3.1 masks", () => {
  it.each(real.map((r, i) => [i, r] as const))("mask %i decodes to a raster that fills its box", (_i, { o, enc }) => {
    const mask = o.mask!;
    expect(maskEncoding(mask)).toBe(enc);
    const r = decodeMask(mask);
    expect(r.data.length).toBe(mask.w * mask.h);
    expect(r.data.every((v) => v === 0 || v === 1)).toBe(true);
    // The raster is the crop of the record's box: same size, and the object touches all four edges.
    expect(mask.w).toBe(o.box[2] - o.box[0] + 1);
    expect(mask.h).toBe(o.box[3] - o.box[1] + 1);
    expect(maskBounds(r)).toEqual({ x1: 0, y1: 0, x2: mask.w - 1, y2: mask.h - 1 });
    const fill = maskArea(r) / (mask.w * mask.h);
    expect(fill).toBeGreaterThan(0.4); // a head is a blob, not a speck
    expect(fill).toBeLessThan(1);
  });

  it("rejects a corrupted payload", () => {
    const mask = { ...real[0].o.mask!, data: real[0].o.mask!.data.slice(0, -3) };
    expect(() => decodeMask(mask)).toThrow();
  });
});

describe("maskOutlinePath", () => {
  it("traces closed contours in frame pixels, inside the box", () => {
    for (const { o } of real) {
      const path = maskOutlinePath(o.mask!, o.box);
      expect(path).toMatch(/^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+)+Z/);
      const nums = [...path.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
      for (const [x, y] of nums) {
        expect(x).toBeGreaterThanOrEqual(o.box[0]);
        expect(x).toBeLessThanOrEqual(o.box[2] + 1);
        expect(y).toBeGreaterThanOrEqual(o.box[1]);
        expect(y).toBeLessThanOrEqual(o.box[3] + 1);
      }
    }
  });

  it("scales to the display size", () => {
    const { o } = real[0];
    const one = maskOutlinePath(o.mask!, o.box, 1);
    const two = maskOutlinePath(o.mask!, o.box, 2);
    const first = (p: string) => p.match(/^M([\d.]+) ([\d.]+)/)!.slice(1).map(Number);
    expect(first(two)).toEqual(first(one).map((v) => v * 2));
  });
});

describe("maskMeanRow", () => {
  it("is the centroid row of a head blob: inside the raster, near its middle", () => {
    for (const { o } of real) {
      const row = maskMeanRow(o.mask!)!;
      expect(row).toBeGreaterThan(0.25 * (o.mask!.h - 1));
      expect(row).toBeLessThan(0.75 * (o.mask!.h - 1));
    }
  });

  it("is null for a corrupted payload", () => {
    expect(maskMeanRow({ ...real[0].o.mask!, data: real[0].o.mask!.data.slice(0, -3) })).toBeNull();
  });
});
