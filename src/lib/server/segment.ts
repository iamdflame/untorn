// segmentFragments(photo) → every torn fragment's outline and mask, in full-resolution photo pixels.
//
// Two passes, because one full-resolution SAM 3.1 concept call on a 2400×1800 photo took 59 s in the spike:
// 1. Locate: the photo downscaled to a long side of ~1280 px, concept "torn piece of paper" (fallbacks when nothing
//    matches). Busy scenes (more than 16 pieces) are also cut into 2×2 overlapping tiles and merged by mask IoU.
// 2. Refine to full resolution, one of three ways (measured in docs/MODELS.md):
//    - "crops": a full-resolution crop around each piece with a box prompt, in parallel (concurrency ~8);
//    - "fullres-boxes": the full-resolution photo with up to 16 box prompts per request;
//    - "snap": no second call; pass-1 masks upsampled and snapped to the paper edge by colour;
//    - "auto" (default): snap, and send only the pieces the snap is unsure of (low paper/background colour contrast,
//      or a snap that moved the outline a lot) to the "crops" refinement.
// Each fragment comes back with a cleaned mask raster (largest component, holes filled), its outline polygon and
// SAM's confidence. A piece whose refinement fails keeps its snapped pass-1 mask and says so (refined: false).

import type { Box } from "@/lib/contracts";
import { openSamStream, samFrames, META_API_BASE } from "@/lib/sam/client";
import { decodeMask } from "@/lib/sam/mask";
import { UpstreamError, type RawObject } from "@/lib/sam/parse";
import { buildBoxImageRequest, buildConceptImageRequest, jpegDataUrl, MAX_OBJECTS_PER_REQUEST, type SamRequestBody } from "@/lib/sam/request";
import { cropJpeg, decodePhoto, resizeJpeg, type DecodedPhoto } from "./images";
import {
  cleanFragmentMask,
  maskArea,
  maskBox,
  maskCoverage,
  maskIoU,
  snapToPaperEdge,
  traceOutline,
  upsampleMask,
  type PlacedMask,
  type Point,
} from "./mask-geometry";

export type SegmentVariant = "auto" | "crops" | "fullres-boxes" | "snap";

/** In "auto", a snapped piece whose paper and background colours are closer than this (σ) is refined with SAM. */
export const SNAP_MIN_SEPARATION = 6;

/** USD per SAM 3.1 image request (docs: pricing-rate-limits, $2.50 per 1,000 images). */
export const SAM_IMAGE_PRICE = 0.0025;
export const DEFAULT_CONCEPTS = ["torn piece of paper", "piece of paper", "paper"] as const;

export type Fragment = {
  /** 0-based, in reading order of the photo (top to bottom, then left to right). */
  id: number;
  /** Tight box of the mask, inclusive, full-resolution photo pixels. */
  box: Box;
  /** Closed outline (first point not repeated), clockwise on screen, full-resolution photo pixels. */
  polygon: Point[];
  /** 0/1 raster of the fragment, its top-left pixel at (mask.x, mask.y) in the photo. */
  mask: PlacedMask;
  area: number;
  /** SAM's confidence for this piece (the refinement call's when there was one, else pass 1's). */
  confidence: number | null;
  /** False when the full-resolution refinement failed and the snapped pass-1 mask stands in. */
  refined: boolean;
  /** How this piece reached full resolution. */
  method: "snap" | "crop" | "fullres" | "snap-fallback";
};

export type SamCallLog = { stage: string; ms: number; attempt: number; ok: boolean; objects: number; bytes: number; error?: string };

export type SegmentResult = {
  width: number;
  height: number;
  variant: SegmentVariant;
  fragments: Fragment[];
  pass1: { concept: string | null; count: number; longSide: number; medianPieceSide: number; tiled: boolean; tileCount: number; afterTiles: number };
  timings: { decodeMs: number; pass1Ms: number; tilesMs: number; pass2Ms: number; outlineMs: number; totalMs: number };
  /** Pieces that got a second SAM call (all of them for "crops" and "fullres-boxes"). */
  sentToSam: number;
  samCalls: number;
  costUsd: number;
  warnings: string[];
  calls: SamCallLog[];
};

export type SegmentOptions = {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  variant?: SegmentVariant;
  pass1LongSide?: number;
  concepts?: readonly string[];
  minConfidence?: number;
  /** Tile the photo when pass 1 finds more pieces than this (and, with tile "auto", they look small). */
  tileAbove?: number;
  /** "auto" tiles a busy scene only when its median piece is under tileMinPx (long side, pass-1 pixels). */
  tile?: "auto" | "always" | "never";
  tileMinPx?: number;
  concurrency?: number;
  /** Per-request timeout for pass 1 / tiles, and for each refinement request. */
  pass1TimeoutMs?: number;
  refineTimeoutMs?: number;
  attempts?: number;
  onCall?: (c: SamCallLog) => void;
};

/** One pass-1 detection: its coarse mask in a SAM frame, and how that frame maps onto the full-resolution photo. */
type Detection = {
  /** Mask in frame pixels. */
  coarse: PlacedMask;
  /** Full-resolution px per frame px. */
  scale: number;
  /** Frame origin in the full-resolution photo. */
  ox: number;
  oy: number;
  confidence: number | null;
  /** Full-resolution mask (nearest-neighbour), for merging and boxes. */
  full: PlacedMask;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

type SamCtx = { apiKey: string; baseUrl: string; fetchImpl?: typeof fetch; signal?: AbortSignal; attempts: number; log: (c: SamCallLog) => void; billed: { n: number } };

/** One SAM image request with retries on network errors, timeouts, 429 and 5xx. Returns frame 0's objects. */
async function samImage(ctx: SamCtx, stage: string, body: SamRequestBody, timeoutMs: number): Promise<RawObject[]> {
  const bytes = JSON.stringify(body).length;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= ctx.attempts; attempt++) {
    if (ctx.signal?.aborted) throw ctx.signal.reason;
    const timer = AbortSignal.timeout(timeoutMs);
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, timer]) : timer;
    const t0 = Date.now();
    try {
      const stream = await openSamStream(body, { apiKey: ctx.apiKey, baseUrl: ctx.baseUrl, fetchImpl: ctx.fetchImpl, signal });
      const objects: RawObject[] = [];
      for await (const f of samFrames(stream)) if (f.frame === 0) objects.push(...f.objects);
      ctx.billed.n++;
      ctx.log({ stage, ms: Date.now() - t0, attempt, ok: true, objects: objects.length, bytes });
      return objects;
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      const status = e instanceof UpstreamError ? e.status : null;
      const retryable = status === null || status === 429 || status >= 500;
      const msg = timer.aborted ? `timeout after ${timeoutMs} ms` : `${(e as Error).name}: ${(e as Error).message}`;
      ctx.log({ stage, ms: Date.now() - t0, attempt, ok: false, objects: 0, bytes, error: msg });
      lastErr = e;
      if (!retryable || attempt === ctx.attempts) break;
      const exp = Math.min(6000, 500 * 2 ** (attempt - 1));
      await sleep(exp / 2 + Math.random() * (exp / 2), ctx.signal);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Place a SAM object's mask: frame pixels → coarse PlacedMask (null when it has no decodable mask). */
function objectMask(o: RawObject): PlacedMask | null {
  if (!o.mask) return null;
  try {
    const r = decodeMask(o.mask);
    return { x: Math.round(o.box[0]) + o.mask.x, y: Math.round(o.box[1]) + o.mask.y, width: r.width, height: r.height, data: r.data };
  } catch {
    return null;
  }
}

/** Map a frame-pixel mask onto the full-resolution photo by nearest neighbour (for merging and boxes). */
function toFullNearest(m: PlacedMask, scale: number, ox: number, oy: number, W: number, H: number): PlacedMask {
  const x0 = Math.max(0, Math.floor(ox + m.x * scale)), y0 = Math.max(0, Math.floor(oy + m.y * scale));
  const x1 = Math.min(W, Math.ceil(ox + (m.x + m.width) * scale)), y1 = Math.min(H, Math.ceil(oy + (m.y + m.height) * scale));
  const width = Math.max(1, x1 - x0), height = Math.max(1, y1 - y0);
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.floor((y0 + y + 0.5 - oy) / scale) - m.y;
    if (sy < 0 || sy >= m.height) continue;
    for (let x = 0; x < width; x++) {
      const sx = Math.floor((x0 + x + 0.5 - ox) / scale) - m.x;
      if (sx >= 0 && sx < m.width) data[y * width + x] = m.data[sy * m.width + sx];
    }
  }
  return { x: x0, y: y0, width, height, data };
}

/** Map a frame-pixel mask onto the full-resolution photo with bilinear smoothing, then clean it. */
function toFullSmooth(m: PlacedMask, scale: number, ox: number, oy: number, W: number, H: number): PlacedMask {
  if (scale === 1) return cleanFragmentMask({ ...m, x: m.x + ox, y: m.y + oy });
  const x0 = Math.max(0, Math.floor(ox + m.x * scale) - 2), y0 = Math.max(0, Math.floor(oy + m.y * scale) - 2);
  const x1 = Math.min(W, Math.ceil(ox + (m.x + m.width) * scale) + 2), y1 = Math.min(H, Math.ceil(oy + (m.y + m.height) * scale) + 2);
  const region = { x: x0 - ox, y: y0 - oy, width: x1 - x0, height: y1 - y0 };
  const soft = upsampleMask(m, scale, region);
  const data = new Uint8Array(soft.length);
  for (let i = 0; i < soft.length; i++) data[i] = soft[i] >= 0.5 ? 1 : 0;
  return cleanFragmentMask({ x: x0, y: y0, width: region.width, height: region.height, data });
}

function detectionsFrom(objects: RawObject[], sentW: number, fullScale: number, ox: number, oy: number, W: number, H: number, minConf: number): Detection[] {
  const out: Detection[] = [];
  for (const o of objects) {
    if (o.confidence !== null && o.confidence < minConf) continue;
    const coarse = objectMask(o);
    if (!coarse) continue;
    const scale = fullScale * (sentW / (o.frameW || sentW));
    const full = toFullNearest(coarse, scale, ox, oy, W, H);
    if (maskArea(full) < 0.0002 * W * H) continue; // specks
    out.push({ coarse, scale, ox, oy, confidence: o.confidence, full: cleanFragmentMask(full) });
  }
  return out;
}

/** Drop unions (a mask that covers most of two or more others) and near-duplicates (IoU > 0.6, keep the more confident). */
export function mergeDetections<T extends { full: PlacedMask; confidence: number | null }>(dets: T[]): T[] {
  const unions = new Set<number>();
  dets.forEach((a, i) => {
    let covered = 0;
    dets.forEach((b, j) => {
      if (i !== j && maskArea(b.full) < 0.9 * maskArea(a.full) && maskCoverage(b.full, a.full) > 0.85) covered++;
    });
    if (covered >= 2) unions.add(i);
  });
  const order = dets.map((_, i) => i).filter((i) => !unions.has(i)).sort((a, b) => (dets[b].confidence ?? 0) - (dets[a].confidence ?? 0));
  const kept: T[] = [];
  for (const i of order) {
    const d = dets[i];
    if (kept.some((k) => maskIoU(k.full, d.full) > 0.6 || maskCoverage(d.full, k.full) > 0.9)) continue;
    kept.push(d);
  }
  return kept;
}

function padBox(b: Box, pad: number, W: number, H: number): Box {
  return [Math.max(0, b[0] - pad), Math.max(0, b[1] - pad), Math.min(W - 1, b[2] + pad), Math.min(H - 1, b[3] + pad)];
}

function snapped(photo: DecodedPhoto, d: Detection): { mask: PlacedMask; separation: number | null } {
  const box = maskBox(d.full);
  if (!box) return { mask: d.full, separation: null };
  const margin = Math.ceil(4 * d.scale) + 10;
  const x0 = Math.max(0, box[0] - margin), y0 = Math.max(0, box[1] - margin);
  const x1 = Math.min(photo.width, box[2] + 1 + margin), y1 = Math.min(photo.height, box[3] + 1 + margin);
  const regionFrame = { x: x0 - d.ox, y: y0 - d.oy, width: x1 - x0, height: y1 - y0 };
  const soft = upsampleMask(d.coarse, d.scale, regionFrame);
  return snapToPaperEdge(photo.rgb, soft, { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, Math.max(3, Math.ceil(1.5 * d.scale)));
}

export async function segmentFragments(photoBytes: Uint8Array, opts: SegmentOptions = {}): Promise<SegmentResult> {
  const T0 = Date.now();
  const variant = opts.variant ?? "auto";
  const longSide = opts.pass1LongSide ?? 1280;
  const concepts = opts.concepts ?? DEFAULT_CONCEPTS;
  const minConf = opts.minConfidence ?? 0.4;
  const tileAbove = opts.tileAbove ?? 16;
  const concurrency = opts.concurrency ?? 8;
  const apiKey = opts.apiKey ?? process.env.MODEL_API_KEY;
  if (!apiKey) throw new Error("MODEL_API_KEY is not set");
  const calls: SamCallLog[] = [];
  const ctx: SamCtx = {
    apiKey,
    baseUrl: opts.baseUrl ?? META_API_BASE,
    fetchImpl: opts.fetchImpl,
    signal: opts.signal,
    attempts: opts.attempts ?? 3,
    log: (c) => {
      calls.push(c);
      opts.onCall?.(c);
    },
    billed: { n: 0 },
  };
  const warnings: string[] = [];

  const photo = await decodePhoto(photoBytes);
  const { width: W, height: H } = photo;
  const tDecode = Date.now();

  // Pass 1: locate every piece on a downscaled copy.
  const small = await resizeJpeg(photo.rgb, longSide, 90);
  const fullScale = W / small.width;
  let concept: string | null = null;
  let dets: Detection[] = [];
  for (const c of concepts) {
    const objects = await samImage(ctx, `pass1:${c}`, buildConceptImageRequest(c, jpegDataUrl(Buffer.from(small.jpeg).toString("base64"))), opts.pass1TimeoutMs ?? 45_000);
    dets = mergeDetections(detectionsFrom(objects, small.width, fullScale, 0, 0, W, H, minConf));
    if (dets.length) {
      concept = c;
      break;
    }
    warnings.push(`concept "${c}" found nothing`);
  }
  const pass1Count = dets.length;
  const tPass1 = Date.now();

  // Busy scenes: 2×2 overlapping tiles, each at the same pass-1 resolution, merged with pass 1 by mask IoU.
  let tileCount = 0;
  const sides = dets.map((d) => {
    const b = maskBox(d.full)!;
    return Math.max(b[2] - b[0], b[3] - b[1]) / fullScale;
  }).sort((a, b) => a - b);
  const medianSide = sides.length ? sides[sides.length >> 1] : 0;
  const tileMode = opts.tile ?? "auto";
  const wantTiles = tileMode === "always" || (tileMode === "auto" && dets.length > tileAbove && medianSide < (opts.tileMinPx ?? 48));
  if (concept && dets.length > tileAbove && tileMode !== "never" && wantTiles) {
    const ov = 0.15;
    const tw = Math.ceil(W * (0.5 + ov / 2)), th = Math.ceil(H * (0.5 + ov / 2));
    const tiles = [
      { left: 0, top: 0 },
      { left: W - tw, top: 0 },
      { left: 0, top: H - th },
      { left: W - tw, top: H - th },
    ];
    tileCount = tiles.length;
    const results = await Promise.all(
      tiles.map(async (t, i) => {
        const crop = await cropJpeg(photo.rgb, { ...t, width: tw, height: th }, 90, longSide);
        try {
          const objects = await samImage(ctx, `tile${i}`, buildConceptImageRequest(concept!, jpegDataUrl(Buffer.from(crop.jpeg).toString("base64"))), opts.pass1TimeoutMs ?? 45_000);
          const s = crop.width / crop.outW;
          // drop pieces cut by an inner tile edge; the neighbouring tile or pass 1 has them whole
          return detectionsFrom(objects, crop.outW, s, crop.left, crop.top, W, H, minConf).filter((d) => {
            const b = maskBox(d.full)!;
            const inner = 3;
            return !((crop.left > 0 && b[0] <= crop.left + inner) || (crop.top > 0 && b[1] <= crop.top + inner) ||
              (crop.left + crop.width < W && b[2] >= crop.left + crop.width - 1 - inner) || (crop.top + crop.height < H && b[3] >= crop.top + crop.height - 1 - inner));
          });
        } catch (e) {
          warnings.push(`tile ${i} failed: ${(e as Error).message}`);
          return [];
        }
      }),
    );
    // tile detections first: they saw the piece at a higher resolution
    dets = mergeDetections([...results.flat().map((d) => ({ ...d, confidence: (d.confidence ?? 0.5) + 1 })), ...dets]).map((d) => ({
      ...d,
      confidence: d.confidence !== null && d.confidence > 1 ? d.confidence - 1 : d.confidence,
    }));
  }
  const tTiles = Date.now();

  // Pass 2: refine each piece to full resolution.
  type Refined = { mask: PlacedMask; confidence: number | null; refined: boolean; method: Fragment["method"] };
  const fallback = (d: Detection, why: string): Refined => {
    warnings.push(why);
    return { mask: snapped(photo, d).mask, confidence: d.confidence, refined: false, method: "snap-fallback" };
  };
  const refineByCrop = async (d: Detection, i: number): Promise<Refined> => {
    const b = maskBox(d.full)!;
    const bw = b[2] - b[0] + 1, bh = b[3] - b[1] + 1;
    const margin = Math.max(16, Math.round(0.06 * Math.max(bw, bh)));
    const crop = await cropJpeg(photo.rgb, { left: b[0] - margin, top: b[1] - margin, width: bw + 2 * margin, height: bh + 2 * margin }, 92);
    const pad = Math.ceil(2 * d.scale) + 2;
    const local = padBox([b[0] - crop.left, b[1] - crop.top, b[2] - crop.left, b[3] - crop.top], pad, crop.width, crop.height);
    try {
      const objects = await samImage(ctx, `crop${i}`, buildBoxImageRequest([local], { width: crop.width, height: crop.height }, jpegDataUrl(Buffer.from(crop.jpeg).toString("base64"))), opts.refineTimeoutMs ?? 30_000);
      const o = objects.find((x) => x.id === 0) ?? objects[0];
      const m = o && objectMask(o);
      if (!m) return fallback(d, `piece ${i}: refinement returned no mask`);
      const mask = toFullSmooth(m, crop.width / (o.frameW || crop.width), crop.left, crop.top, W, H);
      if (maskIoU(mask, d.full) < 0.5) return fallback(d, `piece ${i}: refinement disagreed with pass 1`);
      return { mask, confidence: o.confidence, refined: true, method: "crop" };
    } catch (e) {
      return fallback(d, `piece ${i}: refinement failed (${(e as Error).message})`);
    }
  };
  let refined: Refined[];
  let sentToSam = 0;
  if (variant === "snap" || variant === "auto") {
    const snaps = dets.map((d) => snapped(photo, d));
    const unsure = snaps.map(
      (sn, i) => variant === "auto" && (sn.separation === null || sn.separation < SNAP_MIN_SEPARATION || maskIoU(sn.mask, dets[i].full) < 0.85),
    );
    sentToSam = unsure.filter(Boolean).length;
    refined = await mapLimit(dets, concurrency, async (d, i): Promise<Refined> =>
      unsure[i] ? refineByCrop(d, i) : { mask: snaps[i].mask, confidence: d.confidence, refined: true, method: "snap" },
    );
  } else if (variant === "crops") {
    sentToSam = dets.length;
    refined = await mapLimit(dets, concurrency, refineByCrop);
  } else {
    sentToSam = dets.length;
    const chunks: number[][] = [];
    for (let i = 0; i < dets.length; i += MAX_OBJECTS_PER_REQUEST) chunks.push(dets.slice(i, i + MAX_OBJECTS_PER_REQUEST).map((_, k) => i + k));
    const out: Refined[] = new Array(dets.length);
    const url = jpegDataUrl(Buffer.from(photo.jpeg).toString("base64"));
    await Promise.all(
      chunks.map(async (idx, c) => {
        const boxes = idx.map((i) => padBox(maskBox(dets[i].full)!, Math.ceil(2 * dets[i].scale) + 2, W, H));
        try {
          const objects = await samImage(ctx, `fullres${c}`, buildBoxImageRequest(boxes, { width: W, height: H }, url), opts.refineTimeoutMs ?? 120_000);
          idx.forEach((i, k) => {
            const o = objects.find((x) => x.id === k);
            const m = o && objectMask(o);
            if (!o || !m) {
              out[i] = fallback(dets[i], `piece ${i}: full-resolution call returned no mask`);
              return;
            }
            const mask = toFullSmooth(m, W / (o.frameW || W), 0, 0, W, H);
            out[i] = maskIoU(mask, dets[i].full) < 0.5 ? fallback(dets[i], `piece ${i}: refinement disagreed with pass 1`) : { mask, confidence: o.confidence, refined: true, method: "fullres" };
          });
        } catch (e) {
          idx.forEach((i) => (out[i] = fallback(dets[i], `piece ${i}: full-resolution call failed (${(e as Error).message})`)));
        }
      }),
    );
    refined = out;
  }
  const tPass2 = Date.now();

  const fragments: Fragment[] = refined
    .map((r) => ({ ...r, box: maskBox(r.mask) }))
    .filter((r): r is Refined & { box: Box } => r.box !== null)
    .map((r) => ({ ...r, cy: (r.box[1] + r.box[3]) / 2, cx: (r.box[0] + r.box[2]) / 2 }))
    .sort((a, b) => (Math.abs(a.cy - b.cy) > 0.05 * H ? a.cy - b.cy : a.cx - b.cx))
    .map((r, id) => ({ id, box: r.box, polygon: traceOutline(r.mask, 0.5), mask: r.mask, area: maskArea(r.mask), confidence: r.confidence, refined: r.refined, method: r.method }));
  const tEnd = Date.now();

  return {
    width: W,
    height: H,
    variant,
    fragments,
    pass1: { concept, count: pass1Count, longSide: Math.max(small.width, small.height), medianPieceSide: Math.round(medianSide), tiled: tileCount > 0, tileCount, afterTiles: dets.length },
    timings: { decodeMs: tDecode - T0, pass1Ms: tPass1 - tDecode, tilesMs: tTiles - tPass1, pass2Ms: tPass2 - tTiles, outlineMs: tEnd - tPass2, totalMs: tEnd - T0 },
    sentToSam,
    samCalls: ctx.billed.n,
    costUsd: ctx.billed.n * SAM_IMAGE_PRICE,
    warnings,
    calls,
  };
}
