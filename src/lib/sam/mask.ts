// SAM masks: decode to a raster, and trace an outline path for drawing.
//
// A mask is the crop of its record's box: `data=<H>,<W>,<marker><base85>` with H rows × W columns, origin at the box's
// top-left corner (x1, y1). `~` marks the lossless encoding, `!` one_bit. Decoding uses Meta's @meta-sam/parser.

import { decodeMaskToRaster, decodeMaskToSVGPath, type SegmentationMask } from "@meta-sam/parser";
import type { Box, EncodedMask } from "./types";

/** Row-major 0/1 raster of `width × height`. */
export type MaskRaster = { width: number; height: number; data: Uint8Array };

export function maskEncoding(mask: EncodedMask): "lossless" | "one_bit" {
  return mask.data.startsWith("~") ? "lossless" : "one_bit";
}

function toSegmentationMask(mask: EncodedMask): SegmentationMask {
  return { encoding: maskEncoding(mask), payload: mask.data, width: mask.w, height: mask.h };
}

/** Decode a mask to its raster (throws InvalidSegmentationMaskError on a bad payload). */
export function decodeMask(mask: EncodedMask): MaskRaster {
  return { width: mask.w, height: mask.h, data: decodeMaskToRaster(toSegmentationMask(mask)) };
}

export function maskArea(raster: MaskRaster): number {
  let n = 0;
  for (let i = 0; i < raster.data.length; i++) n += raster.data[i];
  return n;
}

/** The tight bounds of the set pixels, in raster coordinates (inclusive), or null for an empty mask. */
export function maskBounds(raster: MaskRaster): { x1: number; y1: number; x2: number; y2: number } | null {
  let x1 = Infinity, y1 = Infinity, x2 = -1, y2 = -1;
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      if (!raster.data[y * raster.width + x]) continue;
      if (x < x1) x1 = x;
      if (x > x2) x2 = x;
      if (y < y1) y1 = y;
      if (y > y2) y2 = y;
    }
  }
  return x2 < 0 ? null : { x1, y1, x2, y2 };
}

/**
 * The mean row of the set pixels (raster rows, 0 = the box's top edge), or null for an empty or undecodable mask.
 * Added to the box's top edge it is the mask centroid's y: sub-pixel, and steadier than the integer box edge on
 * small heads (the class spike: 8–14 px heads keep 94–100% of pushes with it and a relative motion floor).
 */
export function maskMeanRow(mask: EncodedMask): number | null {
  let raster: MaskRaster;
  try {
    raster = decodeMask(mask);
  } catch {
    return null;
  }
  let sum = 0;
  let n = 0;
  for (let y = 0; y < raster.height; y++) {
    const row = y * raster.width;
    for (let x = 0; x < raster.width; x++) {
      if (raster.data[row + x]) {
        sum += y;
        n++;
      }
    }
  }
  return n ? sum / n : null;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The mask outline as an SVG path ("M…L…Z" per contour) in frame pixels, placed at the box's top-left corner and
 * multiplied by `scale` for the display size. Empty mask → "".
 * Meta's tracer puts pixel centres on integer coordinates; we shift by half a pixel so pixel (c, r) covers [c, c+1).
 */
export function maskOutlinePath(mask: EncodedMask, box: Box, scale = 1): string {
  const local = decodeMaskToSVGPath(toSegmentationMask(mask));
  if (!local) return "";
  const ox = box[0] + 0.5;
  const oy = box[1] + 0.5;
  return local.replace(/([ML])(-?[\d.]+) (-?[\d.]+)/g, (_m, cmd: string, x: string, y: string) => {
    return `${cmd}${round2((Number(x) + ox) * scale)} ${round2((Number(y) + oy) * scale)}`;
  });
}
