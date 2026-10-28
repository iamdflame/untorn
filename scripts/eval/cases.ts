// Load Bench-S cases (scripts/bench/generate.py) as solver inputs, plus their ground truth.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { decode as decodePng } from "fast-png";
import jpeg from "jpeg-js";
import { poseCompose, poseInvert, type Pose } from "../../src/lib/rejoin/geom";
import type { FragmentInput, Rgba } from "../../src/lib/rejoin/types";

export type GtFragment = { id: string; label: number; page: number; piece: number; pose: Pose; page_polygon: [number, number][] };

export type GroundTruth = {
  family: string;
  seed: number;
  kind: "tear" | "stack" | "cut";
  photo: { width: number; height: number };
  pages: { source: string; width: number; height: number }[];
  fragments: GtFragment[];
  joins: { a: number; b: number; length: number }[];
  twins: number[][];
  noise: { median_px: number; p90_px: number; worst_p90_px: number };
};

export type BenchCase = { name: string; dir: string; gt: GroundTruth; inputs: FragmentInput[]; photo: Rgba };

export function listCases(root: string, families?: string[]): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => existsSync(path.join(root, d, "gt.json")))
    .filter((d) => !families || families.includes(d.replace(/-\d+$/, "")))
    .sort();
}

export function loadPhoto(file: string): Rgba {
  const img = jpeg.decode(readFileSync(file), { useTArray: true, maxMemoryUsageInMB: 2048, maxResolutionInMP: 400 });
  return { width: img.width, height: img.height, data: img.data };
}

/** Crop every labelled fragment out of the photo: one solver input per label, ids as in gt.json. */
export function fragmentsFromLabels(labels: { width: number; height: number; data: ArrayLike<number> }, photo: Rgba, ids: Map<number, string>): FragmentInput[] {
  const { width: W, height: H, data } = labels;
  const box = new Map<number, [number, number, number, number]>();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const l = data[y * W + x];
      if (!l) continue;
      const b = box.get(l);
      if (!b) box.set(l, [x, y, x, y]);
      else {
        if (x < b[0]) b[0] = x;
        if (y < b[1]) b[1] = y;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      }
    }
  }
  const inputs: FragmentInput[] = [];
  for (const [l, [x1, y1, x2, y2]] of [...box.entries()].sort((a, b) => a[0] - b[0])) {
    const x0 = Math.max(0, x1 - 2);
    const y0 = Math.max(0, y1 - 2);
    const w = Math.min(W, x2 + 3) - x0;
    const h = Math.min(H, y2 + 3) - y0;
    const mask = new Uint8Array(w * h);
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const src = (y0 + r) * W + x0 + c;
        const dst = r * w + c;
        mask[dst] = data[src] === l ? 1 : 0;
        rgba[4 * dst] = photo.data[4 * src];
        rgba[4 * dst + 1] = photo.data[4 * src + 1];
        rgba[4 * dst + 2] = photo.data[4 * src + 2];
        rgba[4 * dst + 3] = 255;
      }
    }
    inputs.push({ id: ids.get(l) ?? `L${l}`, mask: { width: w, height: h, data: mask }, x0, y0, rgba: { width: w, height: h, data: rgba } });
  }
  return inputs;
}

export function loadCase(dir: string, masks: "sam" | "gt" = "sam"): BenchCase {
  const gt = JSON.parse(readFileSync(path.join(dir, "gt.json"), "utf8")) as GroundTruth;
  const photo = loadPhoto(path.join(dir, "photo.jpg"));
  const png = decodePng(readFileSync(path.join(dir, masks === "sam" ? "masks_sam.png" : "masks_gt.png")));
  const ids = new Map(gt.fragments.map((f) => [f.label, f.id] as const));
  const inputs = fragmentsFromLabels({ width: png.width, height: png.height, data: png.data as Uint8Array }, photo, ids);
  return { name: path.basename(dir), dir, gt, inputs, photo };
}

/** The true pose taking fragment b's photo coordinates into fragment a's photo coordinates. */
export function trueRelative(gt: GroundTruth, a: string, b: string): Pose | null {
  const fa = gt.fragments.find((f) => f.id === a);
  const fb = gt.fragments.find((f) => f.id === b);
  if (!fa || !fb) return null;
  // photo_b → page (inverse of b's pose) → photo_a (a's pose). Only meaningful on the same page.
  return poseCompose(fa.pose, poseInvert(fb.pose));
}
