// The paper, cut from the real photo along SAM's outlines, in two exposures: as photographed, and lit on the light
// table (levelled warm against the piece's own paper colour, local contrast lifted so the fibre shows). Plus a soft
// lift shadow and a tight contact shadow from the same outline. All from real pixels; nothing is painted in.
// The pixel work runs in a worker (cutouts.worker.ts) where the browser can; otherwise here, a piece at a time.

import type { ScenePiece } from "@/lib/run/scene";
import { cutPiece, type CutPieceInput, type CutResult } from "./cutouts-core";

export type Cutout = CutResult<CanvasImageSource>;

const yieldToMain = () => new Promise<void>((r) => setTimeout(r, 0));

const toInput = (p: ScenePiece): CutPieceInput => ({ c: p.c, poly: p.poly, bbox: p.bbox });

function viaWorker(src: string, worldW: number, pieces: ScenePiece[], onPiece?: (i: number, c: Cutout) => void): Promise<Cutout[]> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./cutouts.worker.ts", import.meta.url), { type: "module" });
    } catch (e) {
      reject(e);
      return;
    }
    const out: Cutout[] = [];
    worker.onmessage = (e: MessageEvent<{ i: number; cut?: Cutout; done?: boolean; error?: string }>) => {
      const m = e.data;
      if (m.error) {
        worker.terminate();
        reject(new Error(m.error));
      } else if (m.done) {
        worker.terminate();
        resolve(out);
      } else if (m.cut) {
        out[m.i] = m.cut;
        onPiece?.(m.i, m.cut);
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(e);
    };
    // the worker fetches and decodes the photo itself, off the main thread
    worker.postMessage({ src: new URL(src, location.href).href, worldW, pieces: pieces.map(toInput) });
  });
}

async function onMain(src: string, worldW: number, pieces: ScenePiece[], onPiece?: (i: number, c: Cutout) => void, signal?: { cancelled: boolean }): Promise<Cutout[]> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const scale = worldW / img.naturalWidth;
  const make = (w: number, h: number) => {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  };
  const out: Cutout[] = [];
  for (let i = 0; i < pieces.length; i++) {
    if (signal?.cancelled) break;
    const cut = cutPiece(img, scale, toInput(pieces[i]), make) as Cutout;
    out.push(cut);
    onPiece?.(i, cut);
    await yieldToMain();
  }
  return out;
}

/** Cut every piece out of the photo at `src` (any resolution; `worldW` is its width in world units). */
export async function makeCutouts(src: string, worldW: number, pieces: ScenePiece[], onPiece?: (i: number, c: Cutout) => void, signal?: { cancelled: boolean }): Promise<Cutout[]> {
  if (typeof Worker !== "undefined" && typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap !== "undefined") {
    try {
      return await viaWorker(src, worldW, pieces, onPiece);
    } catch {
      // the main thread does it instead
    }
  }
  return onMain(src, worldW, pieces, onPiece, signal);
}

/* ---------------- shared between the hero and the result plate ---------------- */

const shared = new Map<string, Promise<Map<string, Cutout>>>();
/** Same photo and the same outlines (a new segmentation of the same photo gets its own cut-outs). */
export const cutoutKey = (src: string, pieces: ScenePiece[]) => `${src}|${pieces.map((p) => `${p.id}:${p.bbox.map(Math.round).join(",")}:${p.poly.length}`).join(";")}`;
/** One set of cut-outs per photo and outline set: whoever asks first makes them, the rest wait for them. */
export function sharedCutouts(key: string, make: () => Promise<Map<string, Cutout>>): Promise<Map<string, Cutout>> {
  let p = shared.get(key);
  if (!p) {
    p = make();
    shared.set(key, p);
    if (shared.size > 4) shared.delete(shared.keys().next().value!);
  }
  return p;
}

/**
 * Where Muse read a seam: the pipeline frames each seam image on the point along the shared edge (at 1/2, 0.35, 0.65,
 * 0.2 or 0.8 of its length) whose window holds the most ink on both sides (seam.ts). The same rule here, so the
 * close-up and the climax show the paper Muse read. Falls back to the middle of the edge.
 */
export function readPoint(line: number[], mid: [number, number], a: { cut: Cutout; x: number; y: number; ang: number }, b: { cut: Cutout; x: number; y: number; ang: number }, K: number): [number, number] {
  if (line.length < 4) return mid;
  const pts: [number, number][] = [[line[0], line[1]]];
  const acc = [0];
  for (let j = 2; j < line.length; j += 2) {
    pts.push([line[j], line[j + 1]]);
    acc.push(acc[acc.length - 1] + Math.hypot(line[j] - line[j - 2], line[j + 1] - line[j - 1]));
  }
  const total = acc[acc.length - 1];
  const at = (d: number): [number, number] => {
    let i = 1;
    while (i < acc.length - 1 && acc[i] < d) i++;
    const u = acc[i] === acc[i - 1] ? 0 : (d - acc[i - 1]) / (acc[i] - acc[i - 1]);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
  };
  // the pipeline's window: 420×150 output px at about 32 px per text line, i.e. about 260×93 page px on a typed letter
  const hw = 130 * K;
  const hh = 46 * K;
  let best: { p: [number, number]; v: number } = { p: at(total / 2), v: -1 };
  const ta = { cut: a.cut, x: a.x, y: a.y, c: Math.cos(-a.ang), s: Math.sin(-a.ang) };
  const tb = { cut: b.cut, x: b.x, y: b.y, c: Math.cos(-b.ang), s: Math.sin(-b.ang) };
  for (const frac of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    const p = at(frac * total);
    let ia = 0;
    let ib = 0;
    for (let v = -hh; v <= hh; v += 4) {
      for (let u = -hw; u <= hw; u += 4) {
        ia += inkAt(ta, p[0] + u, p[1] + v);
        ib += inkAt(tb, p[0] + u, p[1] + v);
      }
    }
    const val = Math.min(ia, ib) + 0.01 * (ia + ib);
    if (val > best.v) best = { p, v: val };
  }
  return best.p;
}

function inkAt(t: { cut: Cutout; x: number; y: number; c: number; s: number }, x: number, y: number): number {
  const c = t.cut;
  const dx = x - t.x;
  const dy = y - t.y;
  const cx = Math.floor((dx * t.c - dy * t.s - c.off[0]) / c.scale);
  const cy = Math.floor((dx * t.s + dy * t.c - c.off[1]) / c.scale);
  if (cx < 0 || cy < 0 || cx >= c.w || cy >= c.h) return 0;
  return c.ink[cy * c.w + cx];
}
