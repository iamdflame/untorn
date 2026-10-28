// The images the content ("crossword") check reads, in the formats the spike validated with Muse Spark:
//   renderSeam: both fragments joined by a candidate, a window centred on the seam, text upright, the tear drawn as
//     a dark line (cw1: 14 of 17 adversarial seams judged right);
//   renderChoiceSheet: the left fragment's seam window above k candidate right fragments, each shown alone in the
//     same frame (cw3: the true stack twin picked 9 of 9 times).
// Pure TypeScript: RGBA rasters in, RGBA rasters out.

/** The median line pitch over pieces with a confident text estimate (for `pitchHint`), or null. */
export function medianPitch(frags: Fragment[]): number | null {
  const ps = frags.filter((f) => f.text && f.text.confidence >= 0.4 && f.text.pitch).map((f) => f.text!.pitch!).sort((a, b) => a - b);
  return ps.length ? ps[Math.floor(ps.length / 2)] : null;
}

import { drawText } from "./font";
import { poseApply, poseInvert, type Pose } from "./geom";
import { side } from "./match";
import { sampleRgba } from "./raster";
import type { Candidate, Fragment, Rgba } from "./types";

export type SeamRenderOptions = {
  /** Output window (px). */
  width?: number;
  height?: number;
  /** Output px per photo px; default: about 32 px per text line (between ×0.5 and ×3), else 1.5. */
  scale?: number;
  /**
   * The photo's typical line pitch (median over its pieces). A piece whose own estimate is far from it (a letterhead,
   * a harmonic) is drawn at this pitch instead, so one odd estimate cannot zoom a seam onto a single word.
   */
  pitchHint?: number | null;
  /** Draw the tear as a dark line (pair images). */
  seamLine?: boolean;
  background?: [number, number, number];
};

const BG: [number, number, number] = [126, 92, 62];
const SEAM_INK: [number, number, number] = [70, 55, 40];

type Frame = { cx: number; cy: number; phi: number; scale: number; width: number; height: number };

type Lookup = (id: string) => Fragment;

function lookupOf(frags: Fragment[] | Map<string, Fragment>): Lookup {
  const m = frags instanceof Map ? frags : new Map(frags.map((f) => [f.id, f] as const));
  return (id) => {
    const f = m.get(id);
    if (!f) throw new Error(`unknown fragment ${id}`);
    return f;
  };
}

/** Is photo point (x, y) on fragment f's paper? */
function onPaper(f: Fragment, x: number, y: number): boolean {
  const { mask, x0, y0 } = f.input;
  const c = Math.floor(x - x0);
  const r = Math.floor(y - y0);
  return c >= 0 && r >= 0 && c < mask.width && r < mask.height && mask.data[r * mask.width + c] !== 0;
}

function ink(f: Fragment, x: number, y: number): number {
  const img = f.input.rgba;
  if (!img || !onPaper(f, x, y)) return 0;
  const c = Math.floor(x - f.input.x0);
  const r = Math.floor(y - f.input.y0);
  const k = 4 * (r * img.width + c);
  const lum = 0.299 * img.data[k] + 0.587 * img.data[k + 1] + 0.114 * img.data[k + 2];
  const paper = f.paper ? 0.299 * f.paper[0] + 0.587 * f.paper[1] + 0.114 * f.paper[2] : 220;
  return lum < paper - 45 ? 1 : 0;
}

/**
 * The view frame for a seam on `anchor`: centred on the seam where both sides carry the most ink, rotated so that the
 * anchor's text reads left to right (or, without text, so that the seam runs vertically with the anchor on the left).
 */
function seamFrame(anchor: Fragment, seam: [number, number], partner: Fragment, pose: Pose, o: SeamRenderOptions): Frame {
  const n = anchor.outline.length / 2;
  const width = o.width ?? 420;
  const height = o.height ?? 150;
  const hint = o.pitchHint ?? null;
  const near = (p: number | null | undefined) => !!p && (!hint || (p >= 0.6 * hint && p <= 1.6 * hint));
  const own = [anchor.text?.pitch, partner.text?.pitch].find(near);
  const pitch = own ?? hint ?? anchor.text?.pitch ?? partner.text?.pitch ?? null;
  const scale = o.scale ?? (pitch ? Math.max(0.5, Math.min(3, 32 / pitch)) : 1.5);
  const at = (q: number) => (seam[0] + Math.round(q)) % n;
  // outward normal at the seam middle (towards the partner)
  const mid = at(seam[1] / 2);
  const a = (mid - 6 + n) % n;
  const b = (mid + 6) % n;
  const tx = anchor.outline[2 * b] - anchor.outline[2 * a];
  const ty = anchor.outline[2 * b + 1] - anchor.outline[2 * a + 1];
  const nAngle = Math.atan2(-tx, ty); // (dy, −dx) points out of a positive-area outline
  let phi: number;
  const t = anchor.text;
  if (t && t.confidence >= 0.4) {
    let reading = t.angle + (t.up === -1 ? Math.PI : 0);
    // unknown up: prefer the orientation that puts the partner on the right
    if (t.up === 0 && Math.cos(nAngle - reading) < 0) reading += Math.PI;
    phi = -reading;
  } else phi = -nAngle;
  // pick the centre along the seam with the most ink on both sides
  const halfW = width / scale / 2;
  const halfH = height / scale / 2;
  const inv = poseInvert(pose);
  let best = { q: seam[1] / 2, v: -1 };
  for (const frac of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    const q = frac * seam[1];
    const i = at(q);
    const cx = anchor.outline[2 * i];
    const cy = anchor.outline[2 * i + 1];
    let ia = 0;
    let ib = 0;
    const c = Math.cos(-phi);
    const s = Math.sin(-phi);
    for (let v = -halfH; v <= halfH; v += 4) {
      for (let u = -halfW; u <= halfW; u += 4) {
        const x = cx + c * u - s * v;
        const y = cy + s * u + c * v;
        ia += ink(anchor, x, y);
        const [px, py] = poseApply(inv, x, y);
        ib += ink(partner, px, py);
      }
    }
    const val = Math.min(ia, ib) + 0.01 * (ia + ib);
    if (val > best.v) best = { q, v: val };
  }
  const i = at(best.q);
  return { cx: anchor.outline[2 * i], cy: anchor.outline[2 * i + 1], phi, scale, width, height };
}

/** Paint fragments into a window: each layer is a fragment and the pose taking its photo coords into the frame's. */
function paint(out: Rgba, ox: number, oy: number, fr: Frame, layers: { f: Fragment; pose: Pose }[], bg: [number, number, number]) {
  const c = Math.cos(-fr.phi);
  const s = Math.sin(-fr.phi);
  const px = new Float64Array(4);
  const invs = layers.map((l) => poseInvert(l.pose));
  for (let v = 0; v < fr.height; v++) {
    for (let u = 0; u < fr.width; u++) {
      const du = (u + 0.5 - fr.width / 2) / fr.scale;
      const dv = (v + 0.5 - fr.height / 2) / fr.scale;
      const x = fr.cx + c * du - s * dv;
      const y = fr.cy + s * du + c * dv;
      const k = 4 * ((oy + v) * out.width + ox + u);
      let done = false;
      for (let li = 0; li < layers.length && !done; li++) {
        const f = layers[li].f;
        const [fx, fy] = poseApply(invs[li], x, y);
        if (!onPaper(f, fx, fy) || !f.input.rgba) continue;
        sampleRgba(f.input.rgba, fx - f.input.x0, fy - f.input.y0, px);
        out.data[k] = px[0];
        out.data[k + 1] = px[1];
        out.data[k + 2] = px[2];
        out.data[k + 3] = 255;
        done = true;
      }
      if (!done) {
        out.data[k] = bg[0];
        out.data[k + 1] = bg[1];
        out.data[k + 2] = bg[2];
        out.data[k + 3] = 255;
      }
    }
  }
}

function blank(width: number, height: number, bg: [number, number, number]): Rgba {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[4 * i] = bg[0];
    data[4 * i + 1] = bg[1];
    data[4 * i + 2] = bg[2];
    data[4 * i + 3] = 255;
  }
  return { width, height, data };
}

/** The two fragments of a candidate joined, in a window centred on the seam (fragment a is the left one). */
export function renderSeam(frags: Fragment[] | Map<string, Fragment>, candidate: Candidate, opts: SeamRenderOptions = {}): Rgba {
  const get = lookupOf(frags);
  const A = get(candidate.a);
  const B = get(candidate.b);
  const bg = opts.background ?? BG;
  const fr = seamFrame(A, candidate.seamA, B, candidate.pose, opts);
  const out = blank(fr.width, fr.height, bg);
  paint(out, 0, 0, fr, [{ f: A, pose: { theta: 0, tx: 0, ty: 0 } }, { f: B, pose: candidate.pose }], bg);
  if (opts.seamLine ?? true) {
    const n = A.outline.length / 2;
    const c = Math.cos(fr.phi);
    const s = Math.sin(fr.phi);
    for (let q = 0; q < candidate.seamA[1]; q++) {
      const i = (candidate.seamA[0] + q) % n;
      const dx = A.outline[2 * i] - fr.cx;
      const dy = A.outline[2 * i + 1] - fr.cy;
      const u = (c * dx - s * dy) * fr.scale + fr.width / 2;
      const v = (s * dx + c * dy) * fr.scale + fr.height / 2;
      for (let ddy = -1; ddy <= 1; ddy++) {
        for (let ddx = -1; ddx <= 1; ddx++) {
          const X = Math.round(u + ddx);
          const Y = Math.round(v + ddy);
          if (X < 0 || Y < 0 || X >= fr.width || Y >= fr.height) continue;
          const k = 4 * (Y * fr.width + X);
          out.data[k] = SEAM_INK[0];
          out.data[k + 1] = SEAM_INK[1];
          out.data[k + 2] = SEAM_INK[2];
        }
      }
    }
  }
  return out;
}

/**
 * A k-way sheet: the left (anchor) fragment's seam window on top, then each candidate's partner fragment alone in the
 * same frame, labelled A, B, C… in the given order. All candidates must involve the anchor.
 */
export function renderChoiceSheet(
  frags: Fragment[] | Map<string, Fragment>,
  anchorId: string,
  candidates: Candidate[],
  opts: SeamRenderOptions = {},
): Rgba {
  if (!candidates.length) throw new Error("renderChoiceSheet needs at least one candidate");
  const get = lookupOf(frags);
  const anchor = get(anchorId);
  const bg = opts.background ?? BG;
  const first = side(candidates[0], anchorId);
  const fr = seamFrame(anchor, first.seam, get(first.partner), first.pose, opts);
  const pad = 20;
  const gap = 34;
  const W = fr.width + 2 * pad;
  const H = pad + (fr.height + gap) * (candidates.length + 1) - gap + pad;
  const out = blank(W, H, bg);
  const white: [number, number, number] = [255, 255, 255];
  drawText(out, "LEFT FRAGMENT", pad, 4, white, 2);
  paint(out, pad, pad, fr, [{ f: anchor, pose: { theta: 0, tx: 0, ty: 0 } }], bg);
  candidates.forEach((cand, k) => {
    const sd = side(cand, anchorId);
    const top = pad + (fr.height + gap) * (k + 1);
    drawText(out, `CANDIDATE ${String.fromCharCode(65 + k)}`, pad, top - 18, white, 2);
    paint(out, pad, top, fr, [{ f: get(sd.partner), pose: sd.pose }], bg);
  });
  return out;
}
