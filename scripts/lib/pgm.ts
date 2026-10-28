// Read a label map PGM (P5, 8-bit: 0 = background, k = object k) into one PlacedMask per label.
import { readFileSync } from "node:fs";
import { trimMask, type PlacedMask } from "../../src/lib/server/mask-geometry";

export function readLabelPgm(path: string): PlacedMask[] {
  const buf = readFileSync(path);
  const header = /^P5\s+(\d+)\s+(\d+)\s+(\d+)\s/.exec(buf.subarray(0, 64).toString("latin1"));
  if (!header) throw new Error(`not a P5 PGM: ${path}`);
  const [, w, h] = header.map(Number);
  const px = buf.subarray(header[0].length);
  let max = 0;
  for (let i = 0; i < w * h; i++) if (px[i] > max) max = px[i];
  const masks: PlacedMask[] = [];
  for (let k = 1; k <= max; k++) {
    const data = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) data[i] = px[i] === k ? 1 : 0;
    masks.push(trimMask({ x: 0, y: 0, width: w, height: h, data }));
  }
  return masks;
}
