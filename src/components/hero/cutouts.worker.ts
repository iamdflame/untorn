// Cuts the pieces out of the photo off the main thread (see cutouts-core.ts) and hands each one back as bitmaps.

import { cutPiece, type CutPieceInput } from "./cutouts-core";

type Job = { bitmap: ImageBitmap; scale: number; pieces: CutPieceInput[] };
const post = (m: unknown, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);

self.onmessage = (e: MessageEvent<Job>) => {
  const { bitmap, scale, pieces } = e.data;
  try {
    const make = (w: number, h: number) => new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    const bm = (x: HTMLCanvasElement | OffscreenCanvas) => (x as OffscreenCanvas).transferToImageBitmap();
    pieces.forEach((p, i) => {
      const c = cutPiece(bitmap, scale, p, make);
      const cut = { ...c, plain: bm(c.plain), lit: bm(c.lit), shadow: bm(c.shadow), contact: bm(c.contact) };
      post({ i, cut }, [cut.plain, cut.lit, cut.shadow, cut.contact, cut.ink.buffer]);
    });
    bitmap.close();
    post({ i: -1, done: true });
  } catch (err) {
    post({ i: -1, error: String(err) });
  }
};
