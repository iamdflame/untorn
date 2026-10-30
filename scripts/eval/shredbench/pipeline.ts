// One ShredBench sample through Untorn: SAM 3.1's pieces → straight-edge solver → Muse reads the seams geometry cannot
// settle → the rebuilt page (or, when it stays in parts, a sheet of the parts) → the image Muse transcribes.

import { fragmentsFromSegments, type SegmentedFragment } from "../../../src/lib/rejoin/adapters";
import { analyzeFragment } from "../../../src/lib/rejoin/fragment";
import { poseApply, poseCompose, type Pose } from "../../../src/lib/rejoin/geom";
import { renderPage } from "../../../src/lib/rejoin/render";
import { renderSeam } from "../../../src/lib/rejoin/seam";
import { matchStraight, pieceShapes, readingDirection, type PieceShape, type StraightCandidate } from "../../../src/lib/rejoin/straight";
import { assembleTiles, TILING_DEFAULTS, type SeamVerdict, type TilingResult } from "../../../src/lib/rejoin/tiling";
import type { Fragment, Page, Rgba } from "../../../src/lib/rejoin/types";

/** Reads one seam image; null when the call failed or could not tell. */
export type SeamReader = (seam: Rgba, uprightKnown: boolean, candidate: StraightCandidate) => Promise<SeamVerdict | null>;

export type SolveConfig = {
  /** Most seam readings per sample, readings per round, and readings per pair of groups per round. */
  maxReads: number;
  perRound: number;
  perPair: number;
  /** A seam whose two sides carry less ink than this (profile units) is blank: nothing to read. */
  minSeamInk: number;
};

export const SOLVE_DEFAULTS: SolveConfig = { maxReads: 14, perRound: 6, perPair: 2, minSeamInk: 4 };

export type SolveOutput = {
  frags: Fragment[];
  shapes: PieceShape[];
  cands: StraightCandidate[];
  result: TilingResult;
  verdicts: Map<string, SeamVerdict>;
  reads: { id: string; same: boolean | null; confidence: number | null; round: number }[];
};

/** Group index of every piece in an assembly (pages first, then each unplaced piece on its own). */
function groupsOf(res: TilingResult): Map<string, number> {
  const g = new Map<string, number>();
  res.pages.forEach((p, k) => p.fragments.forEach((f) => g.set(f.id, k)));
  res.unplaced.forEach((u, k) => g.set(u.id, res.pages.length + k));
  return g;
}

/** Would a reading of this candidate add anything? It needs the geometry clue, a seam with ink, and no verdict yet. */
function readable(c: StraightCandidate, shapes: Map<string, PieceShape>, cfg: SolveConfig): boolean {
  const e = c.straight;
  const geometry = e.ends === 0 ? e.overlap >= TILING_DEFAULTS.freeOverlap && e.textDiff !== null : e.geometry >= TILING_DEFAULTS.minGeometry;
  if (!geometry) return false;
  // already confirmed by the ink (then a refusal came from the page, not the seam), or denied by it
  if (e.ends === 2 && e.content >= TILING_DEFAULTS.minContent) return false;
  if (e.content <= TILING_DEFAULTS.maxDoubt) return false;
  const pa = shapes.get(c.a)!.profiles[e.sideA];
  const pb = shapes.get(c.b)!.profiles[e.sideB];
  return !!pa && !!pb && Math.min(pa.total, pb.total) >= cfg.minSeamInk;
}

/** Assemble, then read the strongest unsettled seams that would join two groups, round by round, until done. */
export async function solveSample(photo: Rgba, segments: SegmentedFragment[], read: SeamReader | null, known: Map<string, SeamVerdict>, cfg: SolveConfig = SOLVE_DEFAULTS): Promise<SolveOutput> {
  const frags = fragmentsFromSegments(photo, segments)
    .map((inp, i) => analyzeFragment(inp, i))
    .filter((f): f is Fragment => !!f);
  const shapes = pieceShapes(frags);
  const byShape = new Map(shapes.map((s) => [s.f.id, s] as const));
  const byId = new Map(frags.map((f) => [f.id, f] as const));
  const cands = matchStraight(shapes);
  const verdicts = new Map<string, SeamVerdict>();
  for (const c of cands) if (known.has(c.id)) verdicts.set(c.id, known.get(c.id)!);
  const reads: SolveOutput["reads"] = [];
  let result = assembleTiles(shapes, cands, verdicts);
  for (let round = 1; read && reads.length < cfg.maxReads; round++) {
    const group = groupsOf(result);
    const rank = (c: StraightCandidate) => (c.straight.ends === 2 ? 2 : c.straight.ends === 1 ? 1 : 0) * 10 + c.straight.geometry + c.straight.content;
    const open = cands.filter((c) => !verdicts.has(c.id) && group.get(c.a) !== group.get(c.b) && readable(c, byShape, cfg)).sort((x, y) => rank(y) - rank(x));
    const perPair = new Map<string, number>();
    const batch: StraightCandidate[] = [];
    for (const c of open) {
      if (batch.length >= Math.min(cfg.perRound, cfg.maxReads - reads.length)) break;
      const ga = group.get(c.a)!;
      const gb = group.get(c.b)!;
      const key = ga < gb ? `${ga}|${gb}` : `${gb}|${ga}`;
      if ((perPair.get(key) ?? 0) >= cfg.perPair) continue;
      perPair.set(key, (perPair.get(key) ?? 0) + 1);
      batch.push(c);
    }
    if (!batch.length) break;
    const answers = await Promise.all(
      batch.map((c) => {
        const up = byShape.get(c.a)!;
        const uprightKnown = readingDirection(up, 0.8) !== null;
        return read(renderSeam(byId, c, { width: 640, height: 240 }), uprightKnown, c);
      }),
    );
    batch.forEach((c, k) => {
      const v = answers[k];
      reads.push({ id: c.id, same: v?.same ?? null, confidence: v?.confidence ?? null, round });
      verdicts.set(c.id, v ?? { same: null, confidence: 0 });
    });
    result = assembleTiles(shapes, cands, verdicts);
  }
  return { frags, shapes, cands, result, verdicts, reads };
}

// ---------------------------------------------------------------------------------------------------------------
// Images for the transcription

const GREY: [number, number, number, number] = [128, 128, 128, 255];

/** Turn a raster by 180°. */
export function rotate180(img: Rgba): Rgba {
  const n = img.width * img.height;
  const data = new Uint8ClampedArray(4 * n);
  for (let i = 0; i < n; i++) data.set(img.data.subarray(4 * i, 4 * i + 4), 4 * (n - 1 - i));
  return { width: img.width, height: img.height, data };
}

/**
 * Which way up a whole rebuilt page is, from its margins: ShredBench pages (and ours) are rendered as tall as their
 * content plus 100 px, so the blank band under the last line is far deeper than the one above the first. +1 upright,
 * −1 upside down, 0 unclear. Works for any script, unlike an ascender vote.
 */
export function marginVote(img: Rgba): { vote: -1 | 0 | 1; top: number; bottom: number } {
  const { width: W, height: H, data } = img;
  const paperRows: number[] = [];
  const inkRows: number[] = [];
  for (let y = 0; y < H; y++) {
    let paper = 0;
    let ink = 0;
    for (let x = 0; x < W; x++) {
      const k = 4 * (y * W + x);
      const l = 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
      if (Math.abs(data[k] - 128) + Math.abs(data[k + 1] - 128) + Math.abs(data[k + 2] - 128) < 12) continue;
      paper++;
      if (l < 150) ink++;
    }
    if (paper > 0.3 * W) paperRows.push(y);
    if (ink > 0.004 * W) inkRows.push(y);
  }
  if (!paperRows.length || !inkRows.length) return { vote: 0, top: 0, bottom: 0 };
  const top = Math.max(0, inkRows[0] - paperRows[0]);
  const bottom = Math.max(0, paperRows[paperRows.length - 1] - inkRows[inkRows.length - 1]);
  const vote = bottom > 1.4 * top + 30 ? 1 : top > 1.4 * bottom + 30 ? -1 : 0;
  return { vote, top, bottom };
}

/** A page rendered on grey, turned upright by its margins when the whole page is there. */
export function pageImage(page: Page, frags: Fragment[], complete: boolean): { img: Rgba; flipped: boolean; margins: ReturnType<typeof marginVote> | null } {
  const img = renderPage(page, frags, { background: GREY, margin: 24 });
  if (!complete) return { img, flipped: false, margins: null };
  const m = marginVote(img);
  return m.vote === -1 ? { img: rotate180(img), flipped: true, margins: m } : { img, flipped: false, margins: m };
}

/** A single piece turned so its text lines run left to right (by its own ascender vote when clear). */
function loosePiece(f: Fragment, s: PieceShape): Page {
  const t = s.text;
  let rot = 0;
  if (t) rot = -(readingDirection(s, 0.5) ?? t.angle);
  const R: Pose = { theta: rot, tx: 0, ty: 0 };
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (let i = 0; i < f.outline.length; i += 2) {
    const [x, y] = poseApply(R, f.outline[i], f.outline[i + 1]);
    minx = Math.min(minx, x);
    maxx = Math.max(maxx, x);
    miny = Math.min(miny, y);
    maxy = Math.max(maxy, y);
  }
  const pose = poseCompose({ theta: 0, tx: -minx, ty: -miny }, R);
  return { id: f.id, fragments: [{ id: f.id, pose }], width: Math.ceil(maxx - minx), height: Math.ceil(maxy - miny), confidence: 0, completeness: 0, pageCorners: 0, upright: { by: t ? "text" : "none", flipKnown: false }, rms: 0 };
}

/** Every part (rebuilt groups, then loose pieces), upright, stacked on one sheet with gaps; widest part first. */
export function partsSheet(sol: SolveOutput, maxWidth = 2200): Rgba {
  const byShape = new Map(sol.shapes.map((s) => [s.f.id, s] as const));
  const pages: Page[] = [...sol.result.pages, ...sol.result.unplaced.map((u) => loosePiece(sol.frags.find((f) => f.id === u.id)!, byShape.get(u.id)!))];
  const imgs = pages.map((p) => renderPage(p, sol.frags, { background: GREY, margin: 16 }));
  const gap = 40;
  const width = Math.min(maxWidth, Math.max(...imgs.map((i) => i.width)));
  const scaled = imgs.map((im) => (im.width > width ? scaleDown(im, width / im.width) : im));
  const height = scaled.reduce((s, im) => s + im.height + gap, gap);
  const data = new Uint8ClampedArray(4 * width * height);
  for (let i = 0; i < width * height; i++) data.set([90, 90, 90, 255], 4 * i);
  let y = gap;
  for (const im of scaled) {
    for (let r = 0; r < im.height; r++) data.set(im.data.subarray(4 * r * im.width, 4 * (r + 1) * im.width), 4 * ((y + r) * width));
    y += im.height + gap;
  }
  return { width, height, data };
}

/** Box-filter downscale of a raster by a factor s ≤ 1. */
export function scaleDown(img: Rgba, s: number): Rgba {
  const W = Math.max(1, Math.round(img.width * s));
  const H = Math.max(1, Math.round(img.height * s));
  const data = new Uint8ClampedArray(4 * W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y / s);
    const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) / s)));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x / s);
      const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) / s)));
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const k = 4 * (yy * img.width + xx);
          acc[0] += img.data[k];
          acc[1] += img.data[k + 1];
          acc[2] += img.data[k + 2];
          acc[3] += img.data[k + 3];
          n++;
        }
      }
      data.set(acc.map((v) => v / n), 4 * (y * W + x));
    }
  }
  return { width: W, height: H, data };
}
