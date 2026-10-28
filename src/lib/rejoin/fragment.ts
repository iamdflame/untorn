// Per-fragment analysis: outline, edges, depth map, text orientation and paper tone. Runs once per piece.

import { traceOutline, type ContourOptions } from "./contour";
import { analyzeEdges, type EdgeOptions } from "./edges";
import { polygonCentroid, signedArea } from "./geom";
import { textOrientation } from "./orientation";
import { depthMap, luminance, paperTone } from "./raster";
import type { Fragment, FragmentInput } from "./types";

export type FragmentOptions = { contour?: ContourOptions; edges?: EdgeOptions; minArea?: number };

/** Analyse one piece; null when its mask has no usable outline (empty, or smaller than minArea px²). */
export function analyzeFragment(input: FragmentInput, index: number, opts: FragmentOptions = {}): Fragment | null {
  const outline = traceOutline(input.mask, input.x0, input.y0, opts.contour);
  if (!outline) return null;
  const area = signedArea(outline);
  if (area < (opts.minArea ?? 600)) return null;
  const edges = analyzeEdges(outline, opts.edges);
  const depth = depthMap(input.mask);
  let text = null;
  let paper: [number, number, number] | null = null;
  if (input.rgba) {
    text = textOrientation(input.rgba, input.mask, depth);
    const tone = paperTone(input.rgba, luminance(input.rgba), depth, 5);
    paper = tone ? tone.rgb : null;
  }
  return {
    id: input.id,
    index,
    input,
    outline,
    area,
    centroid: polygonCentroid(outline),
    segments: edges.segments,
    straight: edges.straight,
    segmentOf: edges.segmentOf,
    pageCorners: edges.pageCorners,
    text,
    depth,
    paper,
  };
}
