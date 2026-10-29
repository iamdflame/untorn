// Ground truth and scoring for REAL torn-paper photos (the user's own hand-torn pages).
//
//   pnpm exec tsx scripts/eval/real.ts register [--case NAME]      # register every piece on the intact page → gt JSON
//   pnpm exec tsx scripts/eval/real.ts diagnose [--case NAME]      # where true seams rank among the candidates, residuals
//   pnpm exec tsx scripts/eval/real.ts solve [--case NAME] [--content cache:FILE | live] [--renders DIR]
//   pnpm exec tsx scripts/eval/real.ts score --result FILE [--case NAME]   # score a pipeline result.json (record-run)
//
// The photos are private: they are listed in scripts/eval/real.local.json (gitignored), never in the repo:
//   { "cases": [ { "name": "img5138", "photo": "…/IMG_5138.jpg", "intact": "…/IMG_5133.jpg",
//                  "labels": "…/labels.pgm" | "segments": "…/segments.json", "gt": "…/img5138.gt.json" } ] }
//
// Ground truth: each SAM piece's printed content is registered on the photo of the same page intact (masked NCC over
// rotations and scales, then a local refinement; lib/register.ts). That gives a similarity per piece (torn px →
// intact px). Their median scale converts the intact frame back to torn-photo px, so every piece gets a rigid "true
// pose" (torn px → page, in torn px units), the unit the solver works in. Pieces are adjacent when their outlines run
// within 25 px of each other over at least 80 px on the true page.
//
// Scoring (real paper: curl, perspective, fibre rims): a piece is placed correctly when, under the best rigid
// alignment of its predicted page to the truth, its centroid is within 1.5% of the page width and its angle within 2°.
// Joins are right when the pair is adjacent and the joined pose agrees within the same tolerance.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { fragmentsFromSegments, type SegmentedFragment } from "../../src/lib/rejoin/adapters";
import { analyzeFragment } from "../../src/lib/rejoin/fragment";
import { fitRigid, poseApply, poseCompose, poseInvert, type Pose } from "../../src/lib/rejoin/geom";
import { icp, MATCH_DEFAULTS, measureSeam, workspace } from "../../src/lib/rejoin/match";
import { textOrientation } from "../../src/lib/rejoin/orientation";
import { downscaleInput } from "../../src/lib/rejoin/scale";
import { encodePng, renderPage } from "../../src/lib/rejoin/render";
import { finish, prepare, type Prepared } from "../../src/lib/rejoin/solve";
import { depthMap } from "../../src/lib/rejoin/raster";
import type { Candidate, Fragment, FragmentInput, Rgba } from "../../src/lib/rejoin/types";
import {
  bandpass,
  blur,
  NccSearch,
  peaks,
  refine,
  simApply,
  similarityFromPlacement,
  warpTemplate,
  type Gray,
  type PieceLevel,
  type Similarity,
} from "./lib/register";

// ── config and loading ─────────────────────────────────────────────────────────────────────────────────────────

export type RealCase = { name: string; photo: string; intact?: string; labels?: string; segments?: string; gt: string };

const CONFIG = process.env.REAL_CONFIG ?? path.join(process.cwd(), "scripts/eval/real.local.json");

export function loadConfig(): RealCase[] {
  if (!existsSync(CONFIG)) throw new Error(`no ${CONFIG}: list the private real-photo cases there (see the header)`);
  return (JSON.parse(readFileSync(CONFIG, "utf8")) as { cases: RealCase[] }).cases;
}

type Rgb = { width: number; height: number; data: Uint8Array };

export async function loadRgb(file: string): Promise<Rgb> {
  const { data, info } = await sharp(file).rotate().removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.length) };
}

export function rgbToRgba(rgb: Rgb): Rgba {
  const n = rgb.width * rgb.height;
  const out = new Uint8ClampedArray(4 * n);
  for (let i = 0; i < n; i++) {
    out[4 * i] = rgb.data[3 * i];
    out[4 * i + 1] = rgb.data[3 * i + 1];
    out[4 * i + 2] = rgb.data[3 * i + 2];
    out[4 * i + 3] = 255;
  }
  return { width: rgb.width, height: rgb.height, data: out };
}

/** Label map (P5 PGM, 0 = background, k = piece k) as SAM-style segments with ids p{k−1}, as the pipeline names them. */
export function segmentsFromPgm(file: string): SegmentedFragment[] {
  const buf = readFileSync(file);
  const header = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(buf.subarray(0, 64).toString("latin1"));
  if (!header) throw new Error(`not a P5 PGM: ${file}`);
  const W = Number(header[1]);
  const H = Number(header[2]);
  const px = buf.subarray(header[0].length);
  const box = new Map<number, [number, number, number, number]>();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const l = px[y * W + x];
      if (!l) continue;
      const b = box.get(l);
      if (!b) box.set(l, [x, y, x, y]);
      else {
        if (x < b[0]) b[0] = x;
        if (x > b[2]) b[2] = x;
        if (y > b[3]) b[3] = y;
      }
    }
  }
  const out: SegmentedFragment[] = [];
  for (const [l, [x1, y1, x2, y2]] of [...box.entries()].sort((a, b) => a[0] - b[0])) {
    const x = Math.max(0, x1 - 2);
    const y = Math.max(0, y1 - 2);
    const width = Math.min(W, x2 + 3) - x;
    const height = Math.min(H, y2 + 3) - y;
    const data = new Uint8Array(width * height);
    for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) data[r * width + c] = px[(y + r) * W + x + c] === l ? 1 : 0;
    out.push({ id: `p${l - 1}`, mask: { x, y, width, height, data } });
  }
  return out;
}

export function loadSegments(c: RealCase): SegmentedFragment[] {
  if (c.labels) return segmentsFromPgm(c.labels);
  if (c.segments) {
    const j = JSON.parse(readFileSync(c.segments, "utf8")) as { fragments: { id: string | number; mask: { x: number; y: number; width: number; height: number; data: number[] | string } }[] };
    return j.fragments.map((f) => ({
      id: typeof f.id === "number" ? `p${f.id}` : f.id,
      mask: { ...f.mask, data: typeof f.mask.data === "string" ? Uint8Array.from(Buffer.from(f.mask.data, "base64")) : f.mask.data },
    }));
  }
  throw new Error(`case ${c.name}: no labels or segments`);
}

// ── ground truth ───────────────────────────────────────────────────────────────────────────────────────────────

export type GtPiece = { id: string; sim: Similarity; ncc: number; runnerUp: number; pose: Pose; centroid: [number, number] };
export type GtAdjacency = { a: string; b: string; length: number; rel: Pose };
export type RealGt = {
  name: string;
  /** Median scale intact px per torn px, and its spread over the pieces (perspective and curl). */
  scale: number;
  scaleRange: [number, number];
  /** Page width in torn-photo px (from the intact page's extent ÷ scale). */
  pageWidth: number;
  pieces: GtPiece[];
  adjacency: GtAdjacency[];
};

/** Mean luminance over L×L blocks: level pixel j covers full-res [L·j, L·(j+1)). */
function lumLevel(rgb: Rgb, L: number): Gray {
  const w = Math.floor(rgb.width / L);
  const h = Math.floor(rgb.height / L);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h * L; y++) {
    const row = y * rgb.width;
    const oy = Math.floor(y / L) * w;
    for (let x = 0; x < w * L; x++) {
      const k = 3 * (row + x);
      out[oy + Math.floor(x / L)] += 0.299 * rgb.data[k] + 0.587 * rgb.data[k + 1] + 0.114 * rgb.data[k + 2];
    }
  }
  const s = 1 / (L * L);
  for (let i = 0; i < out.length; i++) out[i] *= s;
  return { width: w, height: h, data: out };
}

/** Coverage of a placed binary mask on level L (fraction of each L×L block inside the mask). */
function maskLevel(seg: SegmentedFragment, L: number): { x0: number; y0: number; w: number; h: number; cov: Float32Array } {
  const { x, y, width, height, data } = seg.mask;
  const x0 = Math.floor(x / L);
  const y0 = Math.floor(y / L);
  const w = Math.ceil((x + width) / L) - x0;
  const h = Math.ceil((y + height) / L) - y0;
  const cov = new Float32Array(w * h);
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (!data[r * width + c]) continue;
      const lx = Math.floor((x + c) / L) - x0;
      const ly = Math.floor((y + r) / L) - y0;
      cov[ly * w + lx] += 1;
    }
  }
  const s = 1 / (L * L);
  for (let i = 0; i < cov.length; i++) cov[i] *= s;
  return { x0, y0, w, h, cov };
}

/** A piece at level L: band-passed crop and an eroded weight mask (away from the rim, shadow and mask noise). */
function pieceLevel(seg: SegmentedFragment, bp: Gray, L: number, erodePx: number): PieceLevel & { pts: Float32Array; vals: Float32Array } {
  const ml = maskLevel(seg, L);
  const bin = new Uint8Array(ml.w * ml.h);
  for (let i = 0; i < bin.length; i++) bin[i] = ml.cov[i] > 0.5 ? 1 : 0;
  const depth = depthMap({ width: ml.w, height: ml.h, data: bin });
  const m = new Float32Array(ml.w * ml.h);
  const t = new Float32Array(ml.w * ml.h);
  const pts: number[] = [];
  const vals: number[] = [];
  const stride = Math.max(1, Math.round(Math.sqrt((ml.w * ml.h) / 60000)));
  for (let r = 0; r < ml.h; r++) {
    for (let c = 0; c < ml.w; c++) {
      const X = ml.x0 + c;
      const Y = ml.y0 + r;
      if (X < 0 || Y < 0 || X >= bp.width || Y >= bp.height) continue;
      const v = bp.data[Y * bp.width + X];
      t[r * ml.w + c] = v;
      if (depth[r * ml.w + c] >= erodePx / L) {
        m[r * ml.w + c] = 1;
        if (r % stride === 0 && c % stride === 0) {
          pts.push(X + 0.5, Y + 0.5);
          vals.push(v);
        }
      }
    }
  }
  return { x0: ml.x0, y0: ml.y0, t: { width: ml.w, height: ml.h, data: t }, m, pts: Float32Array.from(pts), vals: Float32Array.from(vals) };
}

/** The intact page's paper: bright, large, holes filled (text blurred away first). */
function pageMask(lum: Gray): Float32Array {
  const b = blur(lum, 3);
  const hist = new Float64Array(256);
  for (const v of b.data) hist[Math.max(0, Math.min(255, Math.round(v)))]++;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let wB = 0;
  let sB = 0;
  let best = 0;
  let thr = 128;
  const N = b.data.length;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB || wB === N) continue;
    sB += t * hist[t];
    const mB = sB / wB;
    const mF = (sum - sB) / (N - wB);
    const between = wB * (N - wB) * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      thr = t;
    }
  }
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = b.data[i] > thr ? 1 : 0;
  return out;
}

function textAngle(lum: Gray, x0: number, y0: number, w: number, h: number, mask: Uint8Array): ReturnType<typeof textOrientation> {
  const rgba = new Uint8ClampedArray(4 * w * h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const X = x0 + c;
      const Y = y0 + r;
      const v = X >= 0 && Y >= 0 && X < lum.width && Y < lum.height ? lum.data[Y * lum.width + X] : 0;
      const k = 4 * (r * w + c);
      rgba[k] = rgba[k + 1] = rgba[k + 2] = v;
      rgba[k + 3] = 255;
    }
  }
  return textOrientation({ width: w, height: h, data: rgba }, { width: w, height: h, data: mask }, depthMap({ width: w, height: h, data: mask }), { margin: 3 });
}

async function register(c: RealCase, out: string) {
  if (!c.intact) throw new Error(`case ${c.name} has no intact photo`);
  const t0 = performance.now();
  const torn = await loadRgb(c.photo);
  const intact = await loadRgb(c.intact);
  const segs = loadSegments(c);
  console.log(`${c.name}: torn ${torn.width}×${torn.height}, intact ${intact.width}×${intact.height}, ${segs.length} pieces`);
  const levels = [8, 4, 2] as const;
  const T: Record<number, Gray> = {};
  const I: Record<number, Gray> = {};
  const Tb: Record<number, Gray> = {};
  const Ib: Record<number, Gray> = {};
  for (const L of levels) {
    T[L] = lumLevel(torn, L);
    I[L] = lumLevel(intact, L);
    Tb[L] = bandpass(T[L], 0.7, L === 8 ? 2.5 : 3);
    Ib[L] = bandpass(I[L], 0.7, L === 8 ? 2.5 : 3);
  }
  const P8 = pageMask(I[8]);
  const P4 = pageMask(I[4]);
  // the intact page's text angle and pitch (level 4, the page minus a margin)
  const pm = new Uint8Array(P4.length);
  for (let i = 0; i < pm.length; i++) pm[i] = P4[i] ? 1 : 0;
  const pageText = textAngle(I[4], 0, 0, I[4].width, I[4].height, pm);
  if (!pageText) throw new Error("no text found on the intact page");
  // page extent along its text direction (for the tolerance unit)
  let minU = Infinity;
  let maxU = -Infinity;
  const ca = Math.cos(pageText.angle);
  const sa = Math.sin(pageText.angle);
  for (let y = 0; y < I[4].height; y++) {
    for (let x = 0; x < I[4].width; x++) {
      if (!P4[y * I[4].width + x]) continue;
      const u = ca * x + sa * y;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
    }
  }
  const pageWidthIntact = 4 * (maxU - minU);
  console.log(`intact: text angle ${((pageText.angle * 180) / Math.PI).toFixed(2)}°, pitch ${pageText.pitch} (level 4), page width ≈ ${pageWidthIntact.toFixed(0)} px`);
  const valid8 = new Float32Array(P8.length);
  for (let i = 0; i < P8.length; i++) valid8[i] = P8[i];
  const ncc8 = new NccSearch(Ib[8], valid8, 420);
  const pieces: GtPiece[] = [];
  // each piece's own text angle and pitch (level 4); the global scale from the confident pitches
  const texts = segs.map((seg) => {
    const ml = maskLevel(seg, 4);
    const bin = new Uint8Array(ml.w * ml.h);
    for (let i = 0; i < bin.length; i++) bin[i] = ml.cov[i] > 0.5 ? 1 : 0;
    return textAngle(T[4], ml.x0, ml.y0, ml.w, ml.h, bin);
  });
  const pitches = texts.filter((t) => t && t.confidence >= 0.8 && t.pitch).map((t) => t!.pitch!).sort((a, b) => a - b);
  const s0 = pitches.length && pageText.pitch ? pageText.pitch / pitches[Math.floor(pitches.length / 2)] : 1;
  console.log(`global scale guess ${s0.toFixed(3)} from ${pitches.length} pitches`);
  for (const [k, seg] of segs.entries()) {
    const tp = performance.now();
    const p8 = pieceLevel(seg, Tb[8], 8, 16);
    const p4 = pieceLevel(seg, Tb[4], 4, 16);
    const p2 = pieceLevel(seg, Tb[2], 2, 16);
    const pt = texts[k];
    const thetas: number[] = [];
    if (pt && pt.confidence >= 0.9) {
      const base = pageText.angle - pt.angle;
      for (const flip of [0, Math.PI]) for (let d = -4; d <= 4; d += 1) thetas.push(base + flip + (d * Math.PI) / 180);
    } else for (let d = 0; d < 360; d += 3) thetas.push((d * Math.PI) / 180);
    const scales = (thetas.length > 20 ? [0.97, 1, 1.03] : [0.94, 0.97, 1, 1.03, 1.06]).map((q) => q * s0);
    const cands: { S: Similarity; ncc: number }[] = [];
    for (const th of thetas) {
      for (const s of scales) {
        const tpl = warpTemplate(p8, th, s);
        const { map, W, H } = ncc8.search(tpl.t, tpl.m, tpl.tw, tpl.th, 0.7);
        for (const pk of peaks(map, W, H, 3, 4)) cands.push({ S: similarityFromPlacement(p8, th, s, tpl.ctx, tpl.cty, pk.u, pk.v, 8), ncc: pk.ncc });
      }
    }
    cands.sort((a, b) => b.ncc - a.ncc);
    // distinct placements only (centroid of the piece maps > 60 px apart, or > 4° apart)
    const cx = seg.mask.x + seg.mask.width / 2;
    const cy = seg.mask.y + seg.mask.height / 2;
    const distinct: { S: Similarity; ncc: number }[] = [];
    for (const k of cands) {
      const [x, y] = simApply(k.S, cx, cy);
      if (distinct.some((d) => {
        const [x2, y2] = simApply(d.S, cx, cy);
        return Math.hypot(x - x2, y - y2) < 60 && Math.abs(Math.atan2(Math.sin(d.S.theta - k.S.theta), Math.cos(d.S.theta - k.S.theta))) < (4 * Math.PI) / 180;
      })) continue;
      distinct.push(k);
      if (distinct.length >= 10) break;
    }
    const refined = distinct.map((k) => {
      const r4 = refine(p4.pts, p4.vals, Ib[4], k.S, 4, { theta: (1 * Math.PI) / 180, s: 0.02, t: 16 });
      const r2 = refine(p2.pts, p2.vals, Ib[2], r4.S, 2, { theta: (0.3 * Math.PI) / 180, s: 0.006, t: 4 });
      return { coarse: k.ncc, ...r2 };
    });
    refined.sort((a, b) => b.ncc - a.ncc);
    const best = refined[0];
    if (!best) throw new Error(`${seg.id}: no placement found`);
    const [bx, by] = simApply(best.S, cx, cy);
    const runner = refined.find((r) => {
      const [x, y] = simApply(r.S, cx, cy);
      return Math.hypot(x - bx, y - by) > 60;
    });
    pieces.push({ id: seg.id, sim: best.S, ncc: best.ncc, runnerUp: runner?.ncc ?? 0, pose: { theta: 0, tx: 0, ty: 0 }, centroid: [0, 0] });
    console.log(
      `  ${seg.id}: θ ${((best.S.theta * 180) / Math.PI).toFixed(2)}°, s ${best.S.s.toFixed(4)}, ncc ${best.ncc.toFixed(3)} (coarse ${best.coarse.toFixed(3)}), runner-up ${runner?.ncc.toFixed(3) ?? "–"}, ` +
        `text ${pt ? `${((pt.angle * 180) / Math.PI).toFixed(1)}° conf ${pt.confidence.toFixed(2)} pitch ${pt.pitch}` : "none"}, ${((performance.now() - tp) / 1000).toFixed(1)} s`,
    );
  }
  // rigid true poses in torn px: scale about each piece's centroid by its own s, then divide the frame by the median
  const ss = pieces.map((p) => p.sim.s).sort((a, b) => a - b);
  const scale = ss[Math.floor(ss.length / 2)];
  const inputs = fragmentsFromSegments(rgbToRgba(torn), segs);
  const frags = inputs.map((inp, i) => analyzeFragment(inp, i)).filter((f): f is Fragment => !!f);
  for (const p of pieces) {
    const f = frags.find((x) => x.id === p.id)!;
    p.centroid = f.centroid;
    const [qx, qy] = simApply(p.sim, f.centroid[0], f.centroid[1]);
    const c = Math.cos(p.sim.theta);
    const s = Math.sin(p.sim.theta);
    p.pose = { theta: p.sim.theta, tx: qx / scale - (c * f.centroid[0] - s * f.centroid[1]), ty: qy / scale - (s * f.centroid[0] + c * f.centroid[1]) };
  }
  const adjacency = adjacencyOf(pieces, frags);
  const gt: RealGt = { name: c.name, scale, scaleRange: [ss[0], ss[ss.length - 1]], pageWidth: pageWidthIntact / scale, pieces, adjacency };
  mkdirSync(path.dirname(c.gt), { recursive: true });
  writeFileSync(c.gt, JSON.stringify(gt, null, 1));
  console.log(`scale ${scale.toFixed(4)} (range ${ss[0].toFixed(4)}–${ss[ss.length - 1].toFixed(4)}), page width ${gt.pageWidth.toFixed(0)} torn px, ${adjacency.length} adjacent pairs, ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  for (const a of adjacency) console.log(`  ${a.a}–${a.b}: ${a.length.toFixed(0)} px`);
  await overlay(gt, frags, intact, path.join(out, `${c.name}-registration.jpg`));
}

/** Pairs whose outlines run within 25 px of each other over ≥ 80 px on the true page, with the true relative pose. */
function adjacencyOf(pieces: GtPiece[], frags: Fragment[]): GtAdjacency[] {
  const out: GtAdjacency[] = [];
  const placed = pieces.map((p) => {
    const f = frags.find((x) => x.id === p.id)!;
    const pts: number[] = [];
    for (let i = 0; i < f.outline.length; i += 2) pts.push(...poseApply(p.pose, f.outline[i], f.outline[i + 1]));
    return { p, pts };
  });
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const A = placed[i];
      const B = placed[j];
      let near = 0;
      for (let k = 0; k < B.pts.length; k += 4) {
        let best = Infinity;
        for (let q = 0; q < A.pts.length; q += 2) {
          const d = (A.pts[q] - B.pts[k]) ** 2 + (A.pts[q + 1] - B.pts[k + 1]) ** 2;
          if (d < best) best = d;
        }
        if (best <= 25 * 25) near++;
      }
      const length = near * 2;
      if (length < 80) continue;
      const [a, b] = A.p.id < B.p.id ? [A.p, B.p] : [B.p, A.p];
      out.push({ a: a.id, b: b.id, length, rel: poseCompose(poseInvert(a.pose), b.pose) });
    }
  }
  return out;
}

/** The intact page with every registered piece's outline drawn on it (a visual check of the ground truth). */
async function overlay(gt: RealGt, frags: Fragment[], intact: Rgb, file: string) {
  const L = 2;
  const w = Math.floor(intact.width / L);
  const h = Math.floor(intact.height / L);
  const img = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = 3 * (y * L * intact.width + x * L);
      const v = 0.5 * (0.299 * intact.data[k] + 0.587 * intact.data[k + 1] + 0.114 * intact.data[k + 2]) + 100;
      img[3 * (y * w + x)] = img[3 * (y * w + x) + 1] = img[3 * (y * w + x) + 2] = Math.min(255, v);
    }
  }
  const colours = [[230, 30, 30], [30, 160, 30], [30, 60, 230], [200, 120, 0], [160, 0, 160], [0, 150, 150], [120, 80, 0], [230, 0, 120], [0, 0, 0], [90, 90, 255]];
  gt.pieces.forEach((p, k) => {
    const f = frags.find((x) => x.id === p.id)!;
    const col = colours[k % colours.length];
    for (let i = 0; i < f.outline.length; i += 2) {
      const [x, y] = simApply(p.sim, f.outline[i], f.outline[i + 1]);
      for (let d = -1; d <= 1; d++) {
        for (let e = -1; e <= 1; e++) {
          const X = Math.round(x / L) + d;
          const Y = Math.round(y / L) + e;
          if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
          img.set(col, 3 * (Y * w + X));
        }
      }
    }
  });
  mkdirSync(path.dirname(file), { recursive: true });
  await sharp(img, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 85 }).toFile(file);
}

// ── scoring ────────────────────────────────────────────────────────────────────────────────────────────────────

export type RealScore = {
  pieces: number;
  correct: string[];
  split: string[];
  misplaced: string[];
  unplaced: string[];
  joins: { a: string; b: string; right: boolean; why?: string }[];
  joinsRight: number;
  joinsWrong: number;
  trueSeams: number;
  pages: number;
  tolerance: { px: number; deg: number };
};

/**
 * Score predicted pages (piece poses torn px → page px) against the truth. Each page is aligned to the truth by the
 * rigid transform that agrees with the most of its pieces (refined on their outlines); pieces off it are misplaced.
 * The page with the most agreeing pieces is the main one; agreeing groups on other pages are split off.
 */
/** What scoring needs of a piece, in photo px. */
export type PieceShape = { centroid: [number, number]; outline: Float64Array };

/** Working-scale fragments as photo-px shapes (coordinates ÷ k). */
export function shapesOf(frags: Fragment[], k = 1): Map<string, PieceShape> {
  return new Map(frags.map((f) => [f.id, { centroid: [f.centroid[0] / k, f.centroid[1] / k] as [number, number], outline: f.outline.map((v) => v / k) }] as const));
}

export function scoreReal(
  gt: RealGt,
  frags: Map<string, PieceShape>,
  pages: { pieces: { id: string; pose: Pose }[] }[],
  joins: { a: string; b: string; pose?: Pose | null }[],
  allIds: string[],
): RealScore {
  const tolPx = 0.015 * gt.pageWidth;
  const tolDeg = 2;
  const truth = new Map(gt.pieces.map((p) => [p.id, p.pose] as const));
  const centroid = (id: string) => frags.get(id)?.centroid ?? gt.pieces.find((p) => p.id === id)!.centroid;
  const agree = (G: Pose, id: string, pose: Pose) => {
    const pred = poseCompose(G, pose);
    const tr = truth.get(id)!;
    const c = centroid(id);
    const [x1, y1] = poseApply(pred, c[0], c[1]);
    const [x2, y2] = poseApply(tr, c[0], c[1]);
    const dth = Math.abs(Math.atan2(Math.sin(pred.theta - tr.theta), Math.cos(pred.theta - tr.theta)));
    return Math.hypot(x1 - x2, y1 - y2) <= tolPx && dth <= (tolDeg * Math.PI) / 180;
  };
  const groups: { page: number; ids: string[] }[] = [];
  pages.forEach((pg, k) => {
    let best: string[] = [];
    for (const anchor of pg.pieces) {
      if (!truth.has(anchor.id)) continue;
      let G = poseCompose(truth.get(anchor.id)!, poseInvert(anchor.pose));
      let ok = pg.pieces.filter((m) => truth.has(m.id) && agree(G, m.id, m.pose));
      if (ok.length >= 2) {
        const a: number[] = [];
        const b: number[] = [];
        for (const m of ok) {
          const f = frags.get(m.id);
          if (!f) continue;
          for (let i = 0; i < f.outline.length; i += 40) {
            a.push(...poseApply(m.pose, f.outline[i], f.outline[i + 1]));
            b.push(...poseApply(truth.get(m.id)!, f.outline[i], f.outline[i + 1]));
          }
        }
        if (a.length) {
          G = fitRigid(Float64Array.from(a), Float64Array.from(b)).pose;
          const ok2 = pg.pieces.filter((m) => truth.has(m.id) && agree(G, m.id, m.pose));
          if (ok2.length >= ok.length) ok = ok2;
        }
      }
      if (ok.length > best.length) best = ok.map((m) => m.id);
    }
    groups.push({ page: k, ids: best.length >= 2 ? best : [] });
  });
  groups.sort((x, y) => y.ids.length - x.ids.length);
  const correct = groups[0]?.ids ?? [];
  const split = groups.slice(1).flatMap((g) => g.ids);
  const placedIds = pages.flatMap((p) => p.pieces.map((q) => q.id));
  const misplaced = placedIds.filter((id) => !correct.includes(id) && !split.includes(id));
  const unplaced = allIds.filter((id) => !placedIds.includes(id));
  const adj = new Map<string, GtAdjacency>(gt.adjacency.map((a) => [`${a.a}|${a.b}`, a]));
  const scored = joins.map((j) => {
    const key = j.a < j.b ? `${j.a}|${j.b}` : `${j.b}|${j.a}`;
    const t = adj.get(key);
    if (!t) return { a: j.a, b: j.b, right: false, why: "not adjacent" };
    if (!j.pose) return { a: j.a, b: j.b, right: true };
    // the true pose b → a in the join's orientation
    const rel = j.a === t.a ? t.rel : poseInvert(t.rel);
    const c = centroid(j.b);
    const [x1, y1] = poseApply(rel, c[0], c[1]);
    const [x2, y2] = poseApply(j.pose, c[0], c[1]);
    const dth = Math.abs(Math.atan2(Math.sin(rel.theta - j.pose.theta), Math.cos(rel.theta - j.pose.theta)));
    const right = Math.hypot(x1 - x2, y1 - y2) <= tolPx && dth <= (tolDeg * Math.PI) / 180;
    return { a: j.a, b: j.b, right, why: right ? undefined : `pose off by ${Math.hypot(x1 - x2, y1 - y2).toFixed(0)} px, ${((dth * 180) / Math.PI).toFixed(1)}°` };
  });
  return {
    pieces: allIds.length,
    correct,
    split,
    misplaced,
    unplaced,
    joins: scored,
    joinsRight: scored.filter((j) => j.right).length,
    joinsWrong: scored.filter((j) => !j.right).length,
    trueSeams: gt.adjacency.length,
    pages: pages.length,
    tolerance: { px: tolPx, deg: tolDeg },
  };
}

export function loadGt(c: RealCase): RealGt {
  if (!existsSync(c.gt)) throw new Error(`no ground truth for ${c.name}: run "real.ts register --case ${c.name}" first`);
  return JSON.parse(readFileSync(c.gt, "utf8")) as RealGt;
}

/** Character error rate: Levenshtein distance over the reference length, on whitespace-normalised text. */
export function cer(hyp: string, ref: string): number {
  const norm = (s: string) => s.replace(/\[…\]/g, "").replace(/\s+/g, " ").trim();
  const a = norm(hyp);
  const b = norm(ref);
  if (!b.length) return a.length ? 1 : 0;
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[b.length] / b.length;
}


// ── diagnosis ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Pose error of a candidate (b → a) against the truth, at b's centroid: px and degrees. */
export function candidateError(gt: RealGt, frags: Map<string, Fragment>, a: string, b: string, pose: Pose): { px: number; deg: number } | null {
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  const t = gt.adjacency.find((x) => `${x.a}|${x.b}` === key);
  const ta = gt.pieces.find((p) => p.id === a)!.pose;
  const tb = gt.pieces.find((p) => p.id === b)!.pose;
  const rel = t ? (a === t.a ? t.rel : poseInvert(t.rel)) : poseCompose(poseInvert(ta), tb);
  const c = frags.get(b)!.centroid;
  const [x1, y1] = poseApply(rel, c[0], c[1]);
  const [x2, y2] = poseApply(pose, c[0], c[1]);
  const dth = Math.abs(Math.atan2(Math.sin(rel.theta - pose.theta), Math.cos(rel.theta - pose.theta)));
  return { px: Math.hypot(x1 - x2, y1 - y2), deg: (dth * 180) / Math.PI };
}

/** Solver inputs for a case; with k < 1 they are pre-shrunk (experiments: the truth must then be scaled by k too). */
export async function prepareCase(c: RealCase, options: Parameters<typeof prepare>[1] = {}, k = 1): Promise<{ prep: Prepared; inputs: FragmentInput[]; ms: number }> {
  const torn = await loadRgb(c.photo);
  let inputs = fragmentsFromSegments(rgbToRgba(torn), loadSegments(c));
  if (k < 1) inputs = inputs.map((inp) => downscaleInput(inp, k));
  const t0 = performance.now();
  const prep = prepare(inputs, options);
  return { prep, inputs, ms: performance.now() - t0 };
}

/** The truth in working px (photo px × k). */
export function scaleGt(gt: RealGt, k: number): RealGt {
  if (k === 1) return gt;
  const sp = (p: Pose): Pose => ({ theta: p.theta, tx: p.tx * k, ty: p.ty * k });
  return {
    ...gt,
    pageWidth: gt.pageWidth * k,
    pieces: gt.pieces.map((p) => ({ ...p, pose: sp(p.pose), centroid: [p.centroid[0] * k, p.centroid[1] * k] })),
    adjacency: gt.adjacency.map((a) => ({ ...a, length: a.length * k, rel: sp(a.rel) })),
  };
}

/** Solve a case (geometry only) and score it; pages are rendered for a look. */
async function solveCase(c: RealCase, out: string, k: number) {
  const gt = loadGt(c);
  const { prep, inputs, ms } = await prepareCase(c, {}, k);
  const t0 = performance.now();
  const res = finish(prep);
  const total = ms + performance.now() - t0;
  const toPhoto = (p: Pose): Pose => ({ theta: p.theta, tx: p.tx / k, ty: p.ty / k });
  const pages = res.pages.map((pg) => ({ pieces: pg.fragments.map((f) => ({ id: f.id, pose: toPhoto(f.pose) })) }));
  const joins = res.joins.map((j) => ({ a: j.a, b: j.b, pose: toPhoto(j.pose) }));
  const s = scoreReal(gt, shapesOf(prep.fragments, k), pages, joins, inputs.map((i) => i.id));
  console.log(
    `${c.name} (scale ${k}): ${s.correct.length}/${s.pieces} placed correctly, ${s.split.length} split off, ${s.misplaced.length} misplaced, ${s.unplaced.length} unplaced; ` +
      `pages ${res.pages.map((p) => p.fragments.length).join("+") || "none"}; joins ${s.joinsRight} right, ${s.joinsWrong} wrong (of ${s.trueSeams} true seams); ${(total / 1000).toFixed(1)} s`,
  );
  for (const j of s.joins) console.log(`  ${j.a}–${j.b}: ${j.right ? "right" : `WRONG (${j.why})`}`);
  if (s.misplaced.length) console.log(`  misplaced: ${s.misplaced.join(", ")}`);
  mkdirSync(out, { recursive: true });
  res.pages.forEach((p, i) => writeFileSync(path.join(out, `${c.name}-k${k}-page-${i}.png`), encodePng(renderPage(p, prep.fragments, { background: [255, 255, 255, 255] }))));
  return { score: s, res, prep };
}

async function diagnose(c: RealCase, out: string, k: number) {
  const gt = scaleGt(loadGt(c), k);
  const { prep, ms } = await prepareCase(c, {}, k);
  console.log(`working scale ${k}`);
  const tolPx = 0.015 * gt.pageWidth;
  console.log(`${c.name}: prepare ${(ms / 1000).toFixed(1)} s (analyse ${(prep.timings.analyse / 1000).toFixed(1)} s, match ${(prep.timings.match / 1000).toFixed(1)} s), ${prep.match.candidates.length} candidates; tolerance ${tolPx.toFixed(0)} px / 2°`);
  console.log(`truth: scale ${gt.scale.toFixed(4)} (pieces ${gt.scaleRange.map((v) => v.toFixed(4)).join("–")}), page width ${gt.pageWidth.toFixed(0)} px`);
  for (const f of prep.fragments) {
    const t = f.text;
    const g = gt.pieces.find((p) => p.id === f.id)!;
    console.log(
      `  ${f.id}: area ${(f.area / 1e6).toFixed(2)} Mpx², outline ${f.outline.length / 2} pts, ${f.segments.filter((s) => s.kind === "straight").length} straight / ${f.segments.filter((s) => s.kind === "torn").length} torn segments, ` +
        `corners ${f.pageCorners.length}; text ${t ? `${((t.angle * 180) / Math.PI).toFixed(1)}° conf ${t.confidence.toFixed(2)} pitch ${t.pitch} up ${t.up} (${t.upConfidence.toFixed(2)})` : "none"}; ` +
        `truth θ ${((g.sim.theta * 180) / Math.PI).toFixed(1)}° s ${g.sim.s.toFixed(4)} ncc ${g.ncc.toFixed(2)}`,
    );
  }
  const cands = [...prep.match.candidates].sort((x, y) => y.score - x.score);
  const rank = new Map(cands.map((x, k) => [x.id, k + 1] as const));
  const label = (x: Candidate) => {
    const e = candidateError(gt, prep.byId, x.a, x.b, x.pose)!;
    const adjacent = gt.adjacency.some((t) => (t.a === x.a && t.b === x.b) || (t.a === x.b && t.b === x.a));
    return { e, ok: adjacent && e.px <= tolPx && e.deg <= 2 };
  };
  const rows = cands.map((x) => ({ x, ...label(x) }));
  console.log("\ntrue seams (adjacent on the page), their candidates and the best fit from the true pose:");
  const seamRows: unknown[] = [];
  for (const t of gt.adjacency) {
    const mine = rows.filter((r) => (r.x.a === t.a && r.x.b === t.b) || (r.x.a === t.b && r.x.b === t.a));
    const good = mine.filter((r) => r.ok);
    const A = prep.match.data.find((d) => d.f.id === t.a)!;
    const B = prep.match.data.find((d) => d.f.id === t.b)!;
    const fit = icp(A, B, t.rel, MATCH_DEFAULTS, workspace(B.sample.length));
    const at = measureSeam(A, B, t.rel, { minOverlap: 20, inlier: 12 });
    const fe = fit ? candidateError(gt, prep.byId, t.a, t.b, fit.pose)! : null;
    console.log(
      `  ${t.a}–${t.b} (${t.length} px): ${good.length ? good.map((r) => `TRUE #${rank.get(r.x.id)} score ${r.x.score.toFixed(0)} overlap ${r.x.overlap} rms ${r.x.rms.toFixed(2)} fine ${r.x.fineRms.toFixed(2)} shape ${r.x.shapeRms.toFixed(2)} margin ${r.x.margin.toFixed(2)} err ${r.e.px.toFixed(0)} px ${r.e.deg.toFixed(1)}°`).join("; ") : "NO TRUE CANDIDATE"}` +
        ` | ${mine.length - good.length} false for this pair` +
        ` | at truth (12 px band): ${at ? `overlap ${at.overlap} rms ${at.rms.toFixed(2)} fine ${at.fineRms.toFixed(2)} shape ${at.shapeRms.toFixed(2)} area-in ${at.areaOverlap}` : "no seam"}` +
        ` | ICP from truth: ${fit ? `overlap ${fit.inliers * 2} rms ${fit.rms.toFixed(2)} fine ${fit.fineRms.toFixed(2)} shape ${fit.shapeRms.toFixed(2)} moved ${fe!.px.toFixed(0)} px ${fe!.deg.toFixed(1)}°` : "lost"}`,
    );
    seamRows.push({ a: t.a, b: t.b, length: t.length, candidates: mine.map((r) => ({ id: r.x.id, rank: rank.get(r.x.id), ok: r.ok, err: r.e, score: r.x.score, overlap: r.x.overlap, rms: r.x.rms, fine: r.x.fineRms, shape: r.x.shapeRms, margin: r.x.margin })), atTruth: at, icpFromTruth: fit ? { overlap: fit.inliers * 2, rms: fit.rms, fine: fit.fineRms, shape: fit.shapeRms, err: fe } : null });
  }
  const q = (v: number[], p: number) => {
    const s2 = [...v].sort((a, b) => a - b);
    return s2.length ? s2[Math.min(s2.length - 1, Math.floor(p * (s2.length - 1) + 0.5))] : NaN;
  };
  const stat = (name: string, sel: (x: Candidate) => number) => {
    const tv = rows.filter((r) => r.ok).map((r) => sel(r.x));
    const fv = rows.filter((r) => !r.ok).map((r) => sel(r.x));
    console.log(`  ${name.padEnd(8)} true p10/p50/p90 ${[0.1, 0.5, 0.9].map((p) => q(tv, p).toFixed(2)).join(" / ")}   false ${[0.1, 0.5, 0.9].map((p) => q(fv, p).toFixed(2)).join(" / ")}`);
  };
  console.log(`\ncandidates: ${rows.filter((r) => r.ok).length} true, ${rows.filter((r) => !r.ok).length} false; top 15 by score:`);
  for (const r of rows.slice(0, 15)) console.log(`  #${rank.get(r.x.id)} ${r.x.id} ${r.ok ? "TRUE " : "false"} score ${r.x.score.toFixed(0)} overlap ${r.x.overlap} rms ${r.x.rms.toFixed(2)} fine ${r.x.fineRms.toFixed(2)} margin ${r.x.margin.toFixed(2)} err ${r.e.px.toFixed(0)} px ${r.e.deg.toFixed(1)}°`);
  stat("score", (x) => x.score);
  stat("overlap", (x) => x.overlap);
  stat("rms", (x) => x.rms);
  stat("fine", (x) => x.fineRms);
  stat("shape", (x) => x.shapeRms);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, `${c.name}-diagnosis-k${k}.json`), JSON.stringify({ seams: seamRows, candidates: rows.map((r) => ({ id: r.x.id, ok: r.ok, err: r.e, score: r.x.score, overlap: r.x.overlap, rms: r.x.rms, fine: r.x.fineRms, shape: r.x.shapeRms, margin: r.x.margin })) }, null, 1));
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const opt = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const out = opt("--out") ?? path.join(process.cwd(), ".apex/real");
  const cases = loadConfig().filter((c) => !opt("--case") || c.name === opt("--case"));
  if (cmd === "register") {
    for (const c of cases) await register(c, out);
    return;
  }
  if (cmd === "diagnose") {
    for (const c of cases) await diagnose(c, out, Number(opt("--scale") ?? 1));
    return;
  }
  if (cmd === "solve") {
    for (const c of cases) await solveCase(c, out, Number(opt("--scale") ?? 1));
    return;
  }
  if (cmd === "score") {
    const file = opt("--result");
    if (!file) throw new Error("score needs --result FILE");
    const c = cases[0];
    const gt = loadGt(c);
    const result = JSON.parse(readFileSync(file, "utf8")) as { pages: { pieces: { id: string; pose: Pose }[] }[]; pieces: { id: string }[]; joins: { a: string; b: string }[] };
    const torn = await loadRgb(c.photo);
    const inputs: FragmentInput[] = fragmentsFromSegments(rgbToRgba(torn), loadSegments(c));
    const frags = new Map(inputs.map((inp, i) => analyzeFragment(inp, i)).filter((f): f is Fragment => !!f).map((f) => [f.id, f] as const));
    // joins from the page poses (the stored result has no join poses)
    const poseOf = new Map(result.pages.flatMap((p) => p.pieces.map((q) => [q.id, q.pose] as const)));
    const joins = result.joins.map((j) => ({ a: j.a, b: j.b, pose: poseOf.has(j.a) && poseOf.has(j.b) ? poseCompose(poseInvert(poseOf.get(j.a)!), poseOf.get(j.b)!) : null }));
    const s = scoreReal(gt, frags, result.pages, joins, result.pieces.map((p) => p.id));
    console.log(JSON.stringify({ ...s, joins: s.joins.map((j) => `${j.a}-${j.b}:${j.right ? "right" : `WRONG (${j.why})`}`) }, null, 1));
    return;
  }
  throw new Error(`unknown command ${cmd}; see the header of scripts/eval/real.ts`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
